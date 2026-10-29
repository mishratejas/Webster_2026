// Text overlays ("titles"): text shown while certain words are spoken. Same anchoring and
// timing model as B-roll (lib/overlays.js: anchored to words, output time, one layer),
// drawn by drawTitle() in both the preview and the exporter. System fonts only, so the
// worker draws exactly what the page shows; sizes are fractions of the frame's shorter
// side, so titles look the same at any resolution and aspect ratio.
//
// Item: { id, anchor, text, style, position, scale, anim, accent }

const HEAVY = '"Arial Black", "Helvetica Neue", Arial, sans-serif';
const BOLD = '"Helvetica Neue", Arial, sans-serif';

export const TITLE_ACCENTS = ['#e0313a', '#ffd400', '#3dff7a', '#4da3ff', '#ffffff'];

/** box.color 'accent' uses the item's accent colour. Sizes are multiples of the font size. */
export const TITLE_STYLES = [
  {
    id: 'headline',
    name: 'Headline',
    font: HEAVY,
    weight: 900,
    size: 0.1,
    color: '#ffffff',
    stroke: '#000000',
    strokeWidth: 0.12,
    shadow: { color: 'rgba(0,0,0,0.55)', blur: 0.25, y: 0.06 },
    box: null,
    bar: false,
    upper: true,
    lineHeight: 1.08,
  },
  {
    id: 'lower',
    name: 'Lower third',
    font: BOLD,
    weight: 800,
    size: 0.048,
    color: '#ffffff',
    stroke: null,
    strokeWidth: 0,
    shadow: null,
    box: { color: 'rgba(12,12,16,0.82)', padX: 0.7, padY: 0.42, radius: 0.12 },
    bar: true,
    upper: false,
    lineHeight: 1.25,
  },
  {
    id: 'boxed',
    name: 'Boxed',
    font: HEAVY,
    weight: 900,
    size: 0.066,
    color: '#ffffff',
    stroke: null,
    strokeWidth: 0,
    shadow: null,
    box: { color: 'accent', padX: 0.55, padY: 0.3, radius: 0.24 },
    bar: false,
    upper: false,
    lineHeight: 1.15,
  },
  {
    id: 'minimal',
    name: 'Minimal',
    font: BOLD,
    weight: 500,
    size: 0.062,
    color: '#ffffff',
    stroke: null,
    strokeWidth: 0,
    shadow: { color: 'rgba(0,0,0,0.75)', blur: 0.4, y: 0.05 },
    box: null,
    bar: false,
    upper: false,
    lineHeight: 1.2,
  },
];

/** Where a title sits. `left` positions are left-aligned from x; the others are centred on x. */
export const TITLE_POSITIONS = {
  top: { x: 0.5, y: 0.16, align: 'center', label: 'Top' },
  center: { x: 0.5, y: 0.5, align: 'center', label: 'Centre' },
  bottom: { x: 0.5, y: 0.8, align: 'center', label: 'Bottom' },
  'lower-left': { x: 0.06, y: 0.8, align: 'left', label: 'Lower left' },
};

export const TITLE_ANIMS = [
  { id: 'pop', label: 'Pop' },
  { id: 'slide', label: 'Slide' },
  { id: 'fade', label: 'Fade' },
  { id: 'none', label: 'None' },
];

export const TITLE_DEFAULTS = { style: 'headline', position: 'center', scale: 1, anim: 'pop', accent: TITLE_ACCENTS[0] };

export const getTitleStyle = (id) => TITLE_STYLES.find((s) => s.id === id) ?? TITLE_STYLES[0];

/** Readable text on a coloured box: dark text on light accents (yellow, green, white). */
export function textOnAccent(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? '#111111' : '#ffffff';
}

const IN_S = 0.35;
const OUT_S = 0.3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOutCubic = (p) => 1 - (1 - p) ** 3;
const easeOutBack = (p) => {
  const c = 1.7;
  return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
};

/** Opacity, offset and scale for the in / out animation at output time T. */
export function titleMotion(item, T) {
  if (item.anim === 'none') return { alpha: 1, dx: 0, dy: 0, scale: 1 };
  const len = Math.max(1e-6, item.outEnd - item.outStart);
  const pin = clamp((T - item.outStart) / Math.min(IN_S, len / 3), 0, 1);
  const pout = clamp((item.outEnd - T) / Math.min(OUT_S, len / 3), 0, 1);
  const alpha = Math.min(easeOutCubic(pin), pout);
  if (item.anim === 'slide') return { alpha, dx: -(1 - easeOutCubic(pin)), dy: 0, scale: 1 };
  if (item.anim === 'pop') return { alpha, dx: 0, dy: 0, scale: 0.8 + 0.2 * easeOutBack(pin) };
  return { alpha, dx: 0, dy: 0, scale: 1 };
}

/**
 * Lines and box of a title at size W×H, before animation.
 * @returns {{ fontPx, lineH, lines: Array<{ text, width }>, box: { x, y, w, h }, align, padX, padY }}
 */
export function layoutTitle(ctx, item, W, H) {
  // Too tall for the frame (long text, big size)? Shrink until it fits in 90% of it.
  let shrink = 1;
  let L = layoutAt(ctx, item, W, H, shrink);
  while (L.box.h > H * 0.9 && shrink > 0.3) {
    shrink *= 0.85;
    L = layoutAt(ctx, item, W, H, shrink);
  }
  return L;
}

function layoutAt(ctx, item, W, H, shrink) {
  const style = getTitleStyle(item.style);
  const pos = TITLE_POSITIONS[item.position] ?? TITLE_POSITIONS.center;
  const fontPx = Math.max(6, Math.min(W, H) * style.size * (item.scale ?? 1) * shrink);
  ctx.font = `${style.weight} ${fontPx}px ${style.font}`;
  const padX = style.box ? style.box.padX * fontPx : 0;
  const padY = style.box ? style.box.padY * fontPx : 0;
  const barW = style.bar ? 0.28 * fontPx : 0;
  const maxW = W * 0.86 - 2 * padX - barW;

  const raw = String(item.text ?? '').replace(/\r/g, '');
  const text = style.upper ? raw.toUpperCase() : raw;
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(tryLine).width > maxW) {
        lines.push(line);
        line = word;
      } else line = tryLine;
    }
    lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const measured = lines.map((t) => ({ text: t, width: ctx.measureText(t).width }));

  const lineH = fontPx * style.lineHeight;
  const blockW = Math.max(0, ...measured.map((l) => l.width));
  const boxW = blockW + 2 * padX + barW;
  const boxH = measured.length * lineH + 2 * padY;
  const margin = 0.03 * Math.min(W, H);
  const left = pos.align === 'left' ? pos.x * W : pos.x * W - boxW / 2;
  const top = pos.y * H - boxH / 2;
  return {
    fontPx,
    lineH,
    lines: measured,
    align: pos.align,
    padX,
    padY,
    barW,
    box: {
      x: boxW + 2 * margin > W ? (W - boxW) / 2 : clamp(left, margin, W - margin - boxW),
      y: boxH + 2 * margin > H ? (H - boxH) / 2 : clamp(top, margin, H - margin - boxH),
      w: boxW,
      h: boxH,
    },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** Draw a resolved title (with outStart / outEnd) at output time T. Returns its box or null. */
export function drawTitle(ctx, item, T, W, H) {
  if (!String(item.text ?? '').trim()) return null;
  const style = getTitleStyle(item.style);
  const L = layoutTitle(ctx, item, W, H);
  if (!L.lines.length) return null;
  const m = titleMotion(item, T);
  if (m.alpha <= 0) return null;
  const accent = item.accent ?? TITLE_ACCENTS[0];
  const { box, fontPx } = L;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  ctx.save();
  ctx.globalAlpha = m.alpha;
  ctx.translate(cx + m.dx * 0.08 * W, cy + m.dy * 0.05 * H);
  ctx.scale(m.scale, m.scale);
  const x0 = -box.w / 2;
  const y0 = -box.h / 2;

  if (style.box) {
    ctx.fillStyle = style.box.color === 'accent' ? accent : style.box.color;
    roundRect(ctx, x0, y0, box.w, box.h, style.box.radius * fontPx);
    ctx.fill();
  }
  if (style.bar) {
    ctx.fillStyle = accent;
    ctx.fillRect(x0, y0, L.barW, box.h);
  }

  ctx.font = `${style.weight} ${fontPx}px ${style.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const textLeft = x0 + L.barW + L.padX;
  const innerW = box.w - L.barW - 2 * L.padX;
  L.lines.forEach((line, i) => {
    const y = y0 + L.padY + i * L.lineH + L.lineH / 2;
    const x = L.align === 'left' ? textLeft : textLeft + (innerW - line.width) / 2;
    if (style.shadow) {
      ctx.shadowColor = style.shadow.color;
      ctx.shadowBlur = style.shadow.blur * fontPx;
      ctx.shadowOffsetY = style.shadow.y * fontPx;
    }
    if (style.stroke && style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth * fontPx;
      ctx.strokeStyle = style.stroke;
      ctx.strokeText(line.text, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = style.box?.color === 'accent' ? textOnAccent(accent) : style.color;
    ctx.fillText(line.text, x, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
  return box;
}
