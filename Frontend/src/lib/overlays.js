// B-roll overlays: extra footage (video or image) shown over the main video while
// certain words are spoken. Pure logic + drawing, shared by the preview and the exporter.
//
// Model (decisions recorded in the README):
//   - Anchored to the main transcript: { startWordId, endWordId }, or { start, end }
//     (source seconds) when the selection had no words. So overlays follow edits: cut the
//     words before it and it moves; cut words inside it and it gets shorter; cut all of
//     its words and it disappears.
//   - B-roll has no transcript and no audio (always muted).
//   - One B-roll layer: a new B-roll replaces any B-roll it overlaps.
//   - Timing runs on OUTPUT time: the clip plays continuously through cuts in the main
//     video (no jump cuts in the B-roll), and holds its last frame if it's too short.
//
// Item: { id, mediaId, anchor, mode: 'cutaway' | 'pip', pip: { corner, size }, fade, offset }

import { buildEDL, sourceToOutput } from './edl.js';

export const FADE_S = 0.3;
export const MIN_VISIBLE_S = 0.1;
export const PIP_CORNERS = ['tl', 'tr', 'bl', 'br'];
export const BROLL_DEFAULTS = { mode: 'cutaway', pip: { corner: 'tr', size: 0.34 }, fade: true, offset: 0 };
const KEN_BURNS = 0.08; // images zoom in by 8% over their time on screen

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Anchors

/** Source-time range of an anchor, or null if its words no longer exist. */
export function anchorRange(anchor, wordsById) {
  if (!anchor) return null;
  if (anchor.startWordId) {
    const a = wordsById.get(anchor.startWordId);
    const b = wordsById.get(anchor.endWordId);
    if (!a || !b) return null;
    return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
  }
  if (Number.isFinite(anchor.start) && Number.isFinite(anchor.end) && anchor.end > anchor.start) {
    return { start: anchor.start, end: anchor.end };
  }
  return null;
}

/**
 * Anchor for a selection: the first..last word inside it, or (no words, e.g. a pause or a
 * timeline range over silence) the time range itself.
 */
export function anchorForRange(range, words) {
  const inside = words.filter((w) => w.end > range.start + 1e-6 && w.start < range.end - 1e-6);
  if (inside.length) return { startWordId: inside[0].id, endWordId: inside[inside.length - 1].id };
  return { start: range.start, end: range.end };
}

// ---------------------------------------------------------------------------
// Timing

/**
 * Overlays with their source and output ranges, dropping any that are no longer visible.
 * @returns {Array<item & { srcStart, srcEnd, outStart, outEnd }>} sorted by outStart
 */
export function resolveBrolls(brolls, words, removedRanges, duration) {
  if (!brolls?.length) return [];
  const wordsById = new Map(words.map((w) => [w.id, w]));
  const edl = buildEDL(removedRanges, duration);
  const out = [];
  for (const b of brolls) {
    const r = anchorRange(b.anchor, wordsById);
    if (!r) continue;
    const outStart = sourceToOutput(r.start, edl);
    const outEnd = sourceToOutput(r.end, edl);
    if (outEnd - outStart < MIN_VISIBLE_S) continue; // everything under it was cut
    out.push({ ...b, srcStart: r.start, srcEnd: r.end, outStart, outEnd });
  }
  return out.sort((a, b) => a.outStart - b.outStart);
}

/** The overlay on screen at output time T (one layer, so at most one). */
export function brollAt(resolved, T) {
  for (const r of resolved) if (T >= r.outStart && T < r.outEnd) return r;
  return null;
}

/** Where in its own media the overlay is at output time T. Holds the last frame at the end. */
export function brollMediaTime(item, T, mediaDuration) {
  const t = (item.offset ?? 0) + (T - item.outStart);
  return Number.isFinite(mediaDuration) && mediaDuration > 0 ? clamp(t, 0, Math.max(0, mediaDuration - 0.05)) : Math.max(0, t);
}

/** Opacity for the fade in / out. */
export function brollAlpha(item, T) {
  if (!item.fade) return 1;
  const len = item.outEnd - item.outStart;
  const f = Math.min(FADE_S, len / 3);
  return clamp(Math.min((T - item.outStart) / f, (item.outEnd - T) / f), 0, 1);
}

/** Source-range overlap test used to keep one B-roll layer. */
export const rangesOverlap = (a, b) => a.start < b.end - 1e-6 && b.start < a.end - 1e-6;

/** Drop existing overlays whose source range overlaps `range` (a new one replaces them). */
export function withoutOverlapping(brolls, range, words) {
  const wordsById = new Map(words.map((w) => [w.id, w]));
  return brolls.filter((b) => {
    const r = anchorRange(b.anchor, wordsById);
    return !r || !rangesOverlap(r, range);
  });
}

// ---------------------------------------------------------------------------
// Drawing

/** PiP box in output pixels: `size` is a fraction of the output width, at a corner. */
export function pipRect(pip, iw, ih, W, H) {
  const margin = 0.04 * Math.min(W, H);
  const w = clamp((pip?.size ?? 0.34) * W, 0.12 * W, W - 2 * margin);
  const h = Math.min(w * (ih / iw), H - 2 * margin);
  const ww = h * (iw / ih); // keep the media's aspect if the height had to be capped
  const corner = PIP_CORNERS.includes(pip?.corner) ? pip.corner : 'tr';
  const x = corner.endsWith('l') ? margin : W - margin - ww;
  const y = corner.startsWith('t') ? margin : H - margin - h;
  return { x, y, w: ww, h };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/**
 * Draw one overlay frame onto a W×H output. `img` is the B-roll's current frame (a video,
 * canvas or image) of size iw×ih. `kind` 'image' adds a slow zoom. Returns the drawn box.
 */
export function drawBroll(ctx, img, iw, ih, item, W, H, T, kind = 'video') {
  if (!img || !iw || !ih) return null;
  const alpha = brollAlpha(item, T);
  if (alpha <= 0) return null;
  const len = Math.max(1e-6, item.outEnd - item.outStart);
  const zoom = kind === 'image' ? 1 + KEN_BURNS * clamp((T - item.outStart) / len, 0, 1) : 1;

  const box = item.mode === 'pip' ? pipRect(item.pip, iw, ih, W, H) : { x: 0, y: 0, w: W, h: H };
  // Cover the box: crop the media to the box's aspect, centred, then apply the zoom.
  const boxRatio = box.w / box.h;
  let sw = iw / ih > boxRatio ? ih * boxRatio : iw;
  let sh = iw / ih > boxRatio ? ih : iw / boxRatio;
  sw /= zoom;
  sh /= zoom;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  if (item.mode === 'pip') {
    const r = 0.025 * Math.min(W, H);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 0.03 * Math.min(W, H);
    ctx.fillStyle = '#000';
    roundRect(ctx, box.x, box.y, box.w, box.h, r);
    ctx.fill(); // casts the shadow
    ctx.shadowColor = 'transparent';
    ctx.clip();
  }
  ctx.drawImage(img, sx, sy, sw, sh, box.x, box.y, box.w, box.h);
  ctx.restore();
  if (item.mode === 'pip') {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, 0.004 * Math.min(W, H));
    roundRect(ctx, box.x, box.y, box.w, box.h, 0.025 * Math.min(W, H));
    ctx.stroke();
    ctx.restore();
  }
  return box;
}
