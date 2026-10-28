import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { ASPECTS, MAX_ZOOM, cropRect, isOriginal, outputSize } from '../lib/frame.js';
import * as I from './icons.jsx';

/**
 * Output format, floating over the preview: aspect ratio, crop or fit, and (for crop)
 * which part of the picture to keep, chosen by dragging a box on a small navigator, plus
 * zoom. The preview and the export both follow these settings.
 */
export default function FormatPanel({ videoRef, onClose }) {
  const frame = useEditorStore((s) => s.frame);
  const setFrame = useEditorStore((s) => s.setFrame);
  const vw = useEditorStore((s) => s.videoWidth);
  const vh = useEditorStore((s) => s.videoHeight);
  const out = vw && vh ? outputSize(vw, vh, frame) : null;
  const original = isOriginal(frame);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="panel fade-up absolute right-3 top-3 z-30 flex max-h-[calc(100%-96px)] w-[300px] flex-col overflow-hidden text-fg"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-sm font-semibold">Format</h3>
        {out && (
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted" title="Export size">
            {out.width}×{out.height}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg"
          aria-label="Close format settings"
        >
          <I.X />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <section>
          <Label>Aspect ratio</Label>
          <div className="grid grid-cols-5 gap-1.5">
            {ASPECTS.map((a) => {
              const active = frame.aspect === a.id;
              const r = a.ratio ?? (vw && vh ? vw / vh : 16 / 9);
              return (
                <button
                  key={a.id}
                  type="button"
                  title={a.hint ? `${a.label} · ${a.hint}` : 'Same as the source video'}
                  onClick={() => setFrame({ aspect: a.id })}
                  className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2 transition-all ${
                    active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:border-line-strong hover:text-fg'
                  }`}
                  aria-pressed={active}
                >
                  <RatioIcon ratio={r} />
                  <span className="text-[10px] font-semibold leading-none">{a.id === 'original' ? 'Orig.' : a.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className={original ? 'pointer-events-none opacity-40' : ''}>
          <Label>Fill</Label>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-sunken p-1">
            {[
              ['crop', 'Crop', 'Fill the frame; choose what to keep'],
              ['fit', 'Fit', 'Whole picture over a blurred background'],
            ].map(([id, label, hint]) => (
              <button
                key={id}
                type="button"
                title={hint}
                onClick={() => setFrame({ mode: id })}
                className={`rounded-lg py-1 text-xs font-medium transition-colors ${
                  frame.mode === id ? 'bg-raised text-fg shadow' : 'text-muted hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {!original && frame.mode === 'crop' && (
          <>
            <section>
              <Label>Position</Label>
              <Navigator videoRef={videoRef} />
              <p className="mt-1.5 text-[11px] text-subtle">Drag the box to choose which part of the picture to keep.</p>
            </section>
            <section>
              <Label value={`${Math.round(frame.zoom * 100)}%`}>Zoom</Label>
              <input
                type="range"
                min={1}
                max={MAX_ZOOM}
                step={0.05}
                value={frame.zoom}
                onChange={(e) => setFrame({ zoom: Number(e.target.value) })}
                className="w-full accent-[var(--c-accent)]"
                aria-label="Zoom"
              />
            </section>
          </>
        )}

        <div className="flex items-center justify-between border-t border-line pt-3 text-[11px] text-subtle">
          <span>Applied to the export.</span>
          <button
            type="button"
            onClick={() => setFrame({ cx: 0.5, cy: 0.5, zoom: 1 })}
            className="font-medium text-muted hover:text-fg disabled:opacity-40"
            disabled={original}
          >
            Re-centre
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children, value }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between text-xs font-semibold text-muted">
      <span>{children}</span>
      {value != null && <span className="font-mono tabular-nums text-subtle">{value}</span>}
    </div>
  );
}

/** A small outlined rectangle of the given width/height ratio. */
function RatioIcon({ ratio }) {
  const max = 18;
  const w = ratio >= 1 ? max : max * ratio;
  const h = ratio >= 1 ? max / ratio : max;
  return (
    <span className="grid h-[18px] w-[18px] place-items-center">
      <span className="block rounded-[2px] border-[1.5px] border-current" style={{ width: w, height: h }} />
    </span>
  );
}

/**
 * The whole source frame, with the kept area as a bright box and the rest dimmed.
 * Drag anywhere: the box follows the pointer (keeping the grab offset).
 */
function Navigator({ videoRef }) {
  const canvasRef = useRef(null);
  const drag = useRef(null);
  const vw = useEditorStore((s) => s.videoWidth);
  const vh = useEditorStore((s) => s.videoHeight);
  const W = 268;
  const H = vw && vh ? Math.min(170, (W * vh) / vw) : 150;
  const dw = vw && vh ? Math.min(W, (H * vw) / vh) : W; // picture width inside the canvas
  const dx = (W - dw) / 2;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cv = canvasRef.current;
      const v = videoRef.current;
      if (!cv || !v || !vw || !vh) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(W * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (v.readyState >= 2) ctx.drawImage(v, dx, 0, dw, H);

      const s = dw / vw;
      const c = cropRect(vw, vh, useEditorStore.getState().frame);
      const bx = dx + c.x * s;
      const by = c.y * s;
      const bw = c.w * s;
      const bh = c.h * s;
      // Dim everything outside the kept area.
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(bx, by, bw, bh);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, vw, vh, W, H, dw, dx]);

  const toSource = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left - dx) / dw, y: (e.clientY - r.top) / H };
  };

  return (
    <canvas
      ref={canvasRef}
      className="block cursor-grab touch-none rounded-lg active:cursor-grabbing"
      style={{ width: W, height: H }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = toSource(e);
        const { frame } = useEditorStore.getState();
        // Grab inside the box keeps the offset; grab outside jumps the box there.
        const c = cropRect(vw, vh, frame);
        const inside = p.x * vw >= c.x && p.x * vw <= c.x + c.w && p.y * vh >= c.y && p.y * vh <= c.y + c.h;
        drag.current = inside ? { ox: frame.cx - p.x, oy: frame.cy - p.y } : { ox: 0, oy: 0 };
        if (!inside) useEditorStore.getState().setFrame({ cx: p.x, cy: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const p = toSource(e);
        useEditorStore.getState().setFrame({ cx: p.x + drag.current.ox, cy: p.y + drag.current.oy });
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    />
  );
}
