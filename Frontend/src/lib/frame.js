// Output framing: aspect ratio (Original, 16:9, 9:16, 1:1, 4:5) and how the source fills it.
//
//   crop  fill the frame, cutting off what doesn't fit. You choose which part to keep
//         (cx, cy = centre of the kept area, 0..1 of the source) and can zoom in.
//   fit   show the whole picture, centred, over a blurred and darkened copy of itself
//         (the Reels / Shorts look) so there are no black bars.
//
// drawFramed() is used by the preview (main thread, <canvas>) and by the exporter
// (worker, OffscreenCanvas), so the preview is exactly what gets exported. Everything
// is proportional: the preview draws at screen size, the export at output size.

export const ASPECTS = [
  { id: 'original', label: 'Original', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9, hint: 'YouTube' },
  { id: '9:16', label: '9:16', ratio: 9 / 16, hint: 'Reels · Shorts' },
  { id: '1:1', label: '1:1', ratio: 1, hint: 'Square' },
  { id: '4:5', label: '4:5', ratio: 4 / 5, hint: 'Feed' },
];

export const FRAME_DEFAULTS = { aspect: 'original', mode: 'crop', cx: 0.5, cy: 0.5, zoom: 1 };
export const MAX_ZOOM = 3;
/** Longest side of a "fit" output. Fit pads the picture, so it's capped to keep files sane. */
export const FIT_MAX_LONG = 1920;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Target width/height ratio. Original = the source's own ratio. */
export function aspectRatio(frame, srcW, srcH) {
  return ASPECTS.find((a) => a.id === frame?.aspect)?.ratio ?? srcW / srcH;
}

/** True when the output is just the source as-is. */
export const isOriginal = (frame) => !frame || frame.aspect === 'original';

/** Largest rect of `ratio` inside w×h (the crop at zoom 1). */
function innerRect(w, h, ratio) {
  return w / h > ratio ? { w: h * ratio, h } : { w, h: w / ratio };
}

/**
 * The part of the source that's kept in crop mode, in source pixels: { x, y, w, h }.
 * Zoom shrinks it around (cx, cy); it's always kept fully inside the source.
 */
export function cropRect(srcW, srcH, frame) {
  if (isOriginal(frame)) return { x: 0, y: 0, w: srcW, h: srcH };
  const base = innerRect(srcW, srcH, aspectRatio(frame, srcW, srcH));
  const z = clamp(frame.zoom ?? 1, 1, MAX_ZOOM);
  const w = base.w / z;
  const h = base.h / z;
  const x = clamp((frame.cx ?? 0.5) * srcW - w / 2, 0, srcW - w);
  const y = clamp((frame.cy ?? 0.5) * srcH - h / 2, 0, srcH - h);
  return { x, y, w, h };
}

/** Clamp a frame's centre so the crop stays inside the source (what the navigator shows). */
export function clampFrame(frame, srcW, srcH) {
  const f = { ...FRAME_DEFAULTS, ...frame };
  f.zoom = clamp(Number(f.zoom) || 1, 1, MAX_ZOOM);
  f.mode = f.mode === 'fit' ? 'fit' : 'crop';
  if (!ASPECTS.some((a) => a.id === f.aspect)) f.aspect = 'original';
  if (srcW > 0 && srcH > 0 && !isOriginal(f)) {
    const r = cropRect(srcW, srcH, f);
    f.cx = (r.x + r.w / 2) / srcW;
    f.cy = (r.y + r.h / 2) / srcH;
  } else {
    f.cx = clamp(Number.isFinite(f.cx) ? f.cx : 0.5, 0, 1);
    f.cy = clamp(Number.isFinite(f.cy) ? f.cy : 0.5, 0, 1);
  }
  return f;
}

/**
 * Pixel size of the exported video (even numbers, as H.264 needs).
 *   original  the source size
 *   crop      the source pixels inside the crop at zoom 1 (no upscaling; zooming in
 *             upscales the smaller area to this same size)
 *   fit       a frame of the target ratio that holds the whole source, long side ≤ 1920
 */
export function outputSize(srcW, srcH, frame) {
  if (isOriginal(frame)) return { width: even(srcW), height: even(srcH) };
  const ratio = aspectRatio(frame, srcW, srcH);
  if (frame.mode === 'fit') {
    const outer = srcW / srcH > ratio ? { w: srcW, h: srcW / ratio } : { w: srcH * ratio, h: srcH };
    const s = Math.min(1, Math.max(FIT_MAX_LONG, Math.max(srcW, srcH)) / Math.max(outer.w, outer.h));
    return { width: even(outer.w * s), height: even(outer.h * s) };
  }
  const base = innerRect(srcW, srcH, ratio);
  return { width: even(base.w), height: even(base.h) };
}

/** The largest rect of `ratio` centred in a box (where the preview draws the output). */
export function fitRect(boxW, boxH, ratio) {
  const r = innerRect(boxW, boxH, ratio);
  return { x: (boxW - r.w) / 2, y: (boxH - r.h) / 2, w: r.w, h: r.h };
}

/** Preview stage for the current frame: the output's rect inside the preview box. */
export function previewStage(boxW, boxH, srcW, srcH, frame) {
  const { width, height } = outputSize(srcW, srcH, frame);
  return fitRect(boxW, boxH, width / height);
}

// ---------------------------------------------------------------------------
// Drawing

let scratch = null;
/** A small reusable canvas for the blurred background (OffscreenCanvas exists in pages and workers). */
function getScratch(w, h) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  if (!scratch) scratch = new OffscreenCanvas(w, h);
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  return scratch;
}

/**
 * Draw the source image framed into a W×H output at (0, 0) of ctx.
 * `img` is anything drawImage accepts (a <video>, a canvas, a VideoFrame...).
 */
export function drawFramed(ctx, img, srcW, srcH, frame, W, H) {
  if (!srcW || !srcH) return;

  if (isOriginal(frame) || frame.mode !== 'fit') {
    const c = cropRect(srcW, srcH, frame);
    ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, W, H);
    return;
  }

  // Fit: blurred cover background, then the whole picture contained on top.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const cover = innerRect(srcW, srcH, W / H); // the part of the source that covers W×H
  const sw = Math.max(8, Math.round(W / 16));
  const sh = Math.max(8, Math.round(H / 16));
  const s = getScratch(sw, sh);
  if (s) {
    // Downscale hard (cheap blur), soften a little more, then scale back up smoothly.
    const sctx = s.getContext('2d');
    sctx.filter = 'blur(2px)';
    sctx.drawImage(img, (srcW - cover.w) / 2, (srcH - cover.h) / 2, cover.w, cover.h, -2, -2, sw + 4, sh + 4);
    sctx.filter = 'none';
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s, 0, 0, sw, sh, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  const inner = fitRect(W, H, srcW / srcH);
  ctx.drawImage(img, 0, 0, srcW, srcH, inner.x, inner.y, inner.w, inner.h);
}
