import { useEffect, useRef } from 'react';
import { useSubtitleStore } from '../store/useSubtitleStore.js';
import { useCaptionPages } from '../store/useCaptionPages.js';
import { drawCaption, findPageAt, SAMPLE_PAGE } from '../lib/captions.js';
import { getCaptionStyle } from '../lib/captionStyles.js';
import { useEditorStore } from '../store/useEditorStore.js';
import { previewStage } from '../lib/frame.js';

const HANDLE = 14; // px, the resize square at the caption's bottom-right corner
const SNAP = 0.02; // snap to the horizontal centre within 2% of the width

/**
 * Subtitles drawn over the preview with the exporter's own drawCaption(), inside the
 * output frame (the aspect-ratio stage that PreviewCanvas draws), so the preview
 * matches the export at any window size and any aspect ratio.
 *
 * Drag the caption to move it, drag the corner square to resize. Clicks anywhere else
 * go to `onBackgroundClick` (play / pause), like clicking the video.
 */
export default function SubtitleCanvas({ videoRef, onBackgroundClick }) {
  const canvasRef = useRef(null);
  const enabled = useSubtitleStore((s) => s.enabled);
  const pages = useCaptionPages();

  const live = useRef({});
  live.current.pages = pages;
  const view = useRef(null); // { ox, oy, cw, ch } picture rect in CSS px
  const box = useRef(null); // last drawn caption bounds in CSS px
  const drag = useRef(null);
  const hover = useRef(null); // 'move' | 'scale' | null

  // ---- draw every frame ----
  useEffect(() => {
    if (!enabled) return undefined;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cv = canvasRef.current;
      const v = videoRef.current;
      if (!cv || !v) return;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      box.current = null;

      const vw = v.videoWidth;
      const vh = v.videoHeight;
      if (!vw || !vh || !w || !h) return;
      // The output frame on screen (aspect ratio / crop / fit), same as PreviewCanvas, so
      // subtitles are placed relative to the exported frame, exactly as the exporter does.
      const stage = previewStage(w, h, vw, vh, useEditorStore.getState().frame);
      const { x: ox, y: oy, w: cw, h: ch } = stage;
      view.current = { ox, oy, cw, ch };

      const sub = useSubtitleStore.getState();
      const style = getCaptionStyle(sub.styleId);
      const t = v.currentTime;
      const showFrame = sub.panelOpen || hover.current || drag.current;
      let page = findPageAt(live.current.pages, t);
      let time = t;
      let alpha = 1;
      if (!page && showFrame) {
        page = SAMPLE_PAGE; // something to position while nothing is being said
        time = 0.55;
        alpha = 0.6;
      }
      if (!page) return;

      ctx.save();
      ctx.translate(ox, oy);
      ctx.beginPath();
      ctx.rect(0, 0, cw, ch);
      ctx.clip();
      ctx.globalAlpha = alpha;
      const b = drawCaption(ctx, page, time, style, sub, cw, ch);
      ctx.restore();
      box.current = { x: b.x + ox, y: b.y + oy, w: b.w, h: b.h };

      if (showFrame) drawFrame(ctx, box.current, drag.current?.mode === 'move' && sub.x === 0.5, view.current);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      const cv = canvasRef.current;
      cv?.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    };
  }, [enabled, videoRef]);

  // ---- move / resize ----
  const local = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitTest = (p) => {
    const b = box.current;
    if (!b) return null;
    const pad = 6;
    const hx = b.x + b.w + pad;
    const hy = b.y + b.h + pad;
    if (Math.abs(p.x - hx) <= HANDLE && Math.abs(p.y - hy) <= HANDLE) return 'scale';
    if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return 'move';
    return null;
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const p = local(e);
    const hit = hitTest(p);
    if (!hit) {
      onBackgroundClick?.();
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const b = box.current;
    const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const sub = useSubtitleStore.getState();
    drag.current =
      hit === 'move'
        ? { mode: 'move', dx: p.x - center.x, dy: p.y - center.y }
        : { mode: 'scale', center, startScale: sub.scale, startDist: Math.max(8, Math.hypot(p.x - center.x, p.y - center.y)) };
  };

  const onPointerMove = (e) => {
    const p = local(e);
    const d = drag.current;
    const cv = canvasRef.current;
    if (!d) {
      hover.current = hitTest(p);
      cv.style.cursor = hover.current === 'scale' ? 'nwse-resize' : hover.current === 'move' ? 'move' : '';
      return;
    }
    const v = view.current;
    if (!v) return;
    const { update } = useSubtitleStore.getState();
    if (d.mode === 'move') {
      let x = (p.x - d.dx - v.ox) / v.cw;
      const y = (p.y - d.dy - v.oy) / v.ch;
      if (Math.abs(x - 0.5) < SNAP) x = 0.5;
      update({ x, y });
    } else {
      const dist = Math.hypot(p.x - d.center.x, p.y - d.center.y);
      update({ scale: d.startScale * (dist / d.startDist) });
    }
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 h-full w-full ${enabled ? '' : 'pointer-events-none hidden'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        if (!drag.current) hover.current = null;
      }}
    />
  );
}

/** Dashed frame + resize handle around the caption, and a centre guide while snapped. */
function drawFrame(ctx, b, snapped, v) {
  const pad = 6;
  ctx.save();
  if (snapped) {
    ctx.strokeStyle = 'rgba(242, 84, 91, 0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(v.ox + v.cw / 2 + 0.5, v.oy);
    ctx.lineTo(v.ox + v.cw / 2 + 0.5, v.oy + v.ch);
    ctx.stroke();
  }
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
  ctx.setLineDash([]);
  const hx = b.x + b.w + pad;
  const hy = b.y + b.h + pad;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(hx - 5, hy - 5, 10, 10);
  ctx.strokeRect(hx - 5, hy - 5, 10, 10);
  ctx.restore();
}
