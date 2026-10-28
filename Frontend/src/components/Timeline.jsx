import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore, getSelectionSpan } from '../store/useEditorStore.js';
import { useTheme } from '../store/useTheme.js';
import { buildEDL, editedDuration, isSpanRemoved, sourceToOutput } from '../lib/edl.js';
import { findRangeAt, normalize } from '../lib/ranges.js';
import { snapCut } from '../lib/snap.js';
import { formatClock, formatTick, moveRangeEdge, snapSeek, tickStep, wordBoundaries, nextBoundary, prevBoundary } from '../lib/timeline.js';
import { gapCutTimes, splitTarget } from '../lib/transcript.js';
import { resolveBrolls } from '../lib/overlays.js';
import { useMediaStore } from '../store/useMediaStore.js';
import { addBrollOverSelection, canAddBroll } from '../store/overlayActions.js';
import { player } from '../media/player.js';
import { deleteOrRestoreSelection, selectionIsRemoved } from './editActions.js';
import * as I from './icons.jsx';
import { buildFillerCuts } from '../lib/fillers.js';

// Geometry (px). Rows are absolutely positioned inside the scrolling content.
const PAD = 16; // space before 0:00 and after the end
const RULER_H = 28;
const ROWS = {
  broll: { top: 34, h: 26 },
  caption: { top: 66, h: 30 },
  video: { top: 102, h: 58 },
  audio: { top: 166, h: 40 },
};
const CONTENT_H = 212;
const MAX_PPS = 900; // max zoom: px per second

// Razor cursor (scissors), with crosshair as the fallback.
const RAZOR_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"><g><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></g><g stroke="black" stroke-width="1.5"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></g></svg>',
)}") 12 12, crosshair`;

/**
 * Multi-track timeline: ruler, caption (word) track, video filmstrip and audio waveform.
 *
 * Sync model: the timeline holds no edit state of its own. It reads words, gaps and
 * removedRanges from the store (the same data the transcript and exporter use) and
 * the playhead reads the <video>'s currentTime every frame. Every time it produces
 * (seek, selection edge, trim edge) goes through snapSeek / snapCut, so nothing can
 * land in the middle of a word.
 */
export default function Timeline() {
  const duration = useEditorStore((s) => s.duration);
  const items = useEditorStore((s) => s.items);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const peaks = useEditorStore((s) => s.peaks);
  const splits = useEditorStore((s) => s.splits);
  const fileName = useEditorStore((s) => s.file?.name ?? 'audio');
  const status = useEditorStore((s) => s.status);
  const theme = useTheme((s) => s.theme);

  const scrollerRef = useRef(null);
  const contentRef = useRef(null);
  const canvasRef = useRef(null);
  const playheadRef = useRef(null);
  const hoverRef = useRef(null);
  const hoverLabelRef = useRef(null);
  const hoverLineRef = useRef(null);
  const gesture = useRef(null);
  const pendingScroll = useRef(null);

  const [viewW, setViewW] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [pps, setPps] = useState(null); // null = fit to width
  const [follow, setFollow] = useState(true);
  // 'select' (V): click to seek, drag to select, drag red handles to trim.
  // 'razor'  (C): click inside a pause to split it into pieces (words can't be split).
  const [tool, setTool] = useState('select');
  const [trimPreview, setTrimPreview] = useState(null); // removedRanges while dragging a trim handle
  const trimRef = useRef(null);

  const fitPps = viewW > 0 && duration > 0 ? Math.max(1, (viewW - 2 * PAD) / duration) : 40;
  const zoom = pps ?? fitPps;
  const contentW = Math.max(viewW, duration * zoom + 2 * PAD);
  const ranges = trimPreview ?? removedRanges;

  // Cuts a filler review would make (selected candidates), drawn as a highlight.
  const fillerReview = useEditorStore((s) => s.fillerReview);
  const proposed = useMemo(
    () => (fillerReview?.phase === 'review' ? buildFillerCuts(fillerReview.candidates, fillerReview.selected, duration) : null),
    [fillerReview, duration],
  );

  const xOf = useCallback((t) => PAD + t * zoom, [zoom]);
  const tOf = useCallback((x) => Math.min(duration, Math.max(0, (x - PAD) / zoom)), [zoom, duration]);

  // Latest values for the rAF loop / native listeners.
  const live = useRef({});
  live.current = { xOf, tOf, zoom, fitPps, follow, ranges, duration, peaks, fileName, proposed, tool };

  // ---- size & scroll ----
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollerRef.current) {
      scrollerRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
      setScrollLeft(scrollerRef.current.scrollLeft);
    }
  }, [zoom]);

  // ---- canvas: ruler + waveform, drawn for the visible window only ----
  const draw = useCallback(() => {
    const sc = scrollerRef.current;
    const cv = canvasRef.current;
    if (!sc || !cv) return;
    const { xOf: X, tOf: T, zoom: Z, ranges: R, duration: D, peaks: P, fileName: name, proposed: FP } = live.current;
    const w = sc.clientWidth;
    const sl = sc.scrollLeft;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(CONTENT_H * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(CONTENT_H * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${CONTENT_H}px`;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, CONTENT_H);

    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();

    // Ruler
    ctx.fillStyle = col('--c-raised');
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = col('--c-line-strong');
    ctx.fillRect(0, RULER_H - 1, w, 1);

    const { major, minor } = tickStep(Z);
    const every = Math.round(major / minor);
    const tStart = T(sl);
    const tEnd = T(sl + w);
    ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'top';
    for (let k = Math.max(0, Math.floor(tStart / minor) - 1); k * minor <= tEnd + minor; k++) {
      const t = k * minor;
      if (t > D + 1e-6) break;
      const x = Math.round(X(t) - sl) + 0.5;
      const isMajor = k % every === 0;
      ctx.fillStyle = isMajor ? col('--c-muted') : col('--c-line-strong');
      ctx.fillRect(x, RULER_H - (isMajor ? 10 : 5), 1, isMajor ? 10 : 5);
      if (isMajor) {
        ctx.fillStyle = col('--c-subtle');
        ctx.fillText(formatTick(t, major), x + 4, 6);
      }
    }
    // Removed ranges marked on the ruler
    ctx.fillStyle = col('--c-accent');
    for (const r of R) {
      const a = X(r.start) - sl;
      const b = X(r.end) - sl;
      if (b < 0 || a > w) continue;
      ctx.fillRect(a, RULER_H - 3, Math.max(1, b - a), 3);
    }
    // Proposed filler cuts: highlight band on the ruler plus a light wash over the tracks
    if (FP?.length) {
      ctx.fillStyle = col('--c-highlight');
      for (const r of FP) {
        const a = X(r.start) - sl;
        const b = X(r.end) - sl;
        if (b < 0 || a > w) continue;
        ctx.globalAlpha = 1;
        ctx.fillRect(a, RULER_H - 6, Math.max(1.5, b - a), 3);
        ctx.globalAlpha = 0.16;
        ctx.fillRect(a, RULER_H, Math.max(1.5, b - a), CONTENT_H - RULER_H);
      }
      ctx.globalAlpha = 1;
    }

    // Audio track
    const { top, h } = ROWS.audio;
    const xs = Math.max(-8, X(0) - sl);
    const xe = Math.min(w + 8, X(D) - sl);
    if (xe > xs) {
      ctx.save();
      roundRect(ctx, X(0) - sl, top, X(D) - X(0), h, 7);
      ctx.fillStyle = col('--c-wave-bg');
      ctx.fill();
      ctx.clip();
      const mid = top + h / 2;
      const wave = col('--c-wave');
      const cut = col('--c-subtle');
      if (P && P.length) {
        const step = 3;
        for (let px = Math.floor(xs); px < xe; px += step) {
          const ta = T(px + sl);
          const tb = T(px + step + sl);
          const ia = Math.floor(ta * 100);
          const ib = Math.max(ia + 1, Math.ceil(tb * 100));
          let p = 0;
          for (let i = ia; i < ib && i < P.length; i++) if (P[i] > p) p = P[i];
          const bh = Math.max(1.5, p * (h - 10));
          const removed = findRangeAt(R, (ta + tb) / 2);
          ctx.globalAlpha = removed ? 0.28 : 0.95;
          ctx.fillStyle = removed ? cut : wave;
          ctx.fillRect(px, mid - bh / 2, step - 1, bh);
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = cut;
        ctx.globalAlpha = 0.4;
        ctx.fillRect(xs, mid, xe - xs, 1);
        ctx.globalAlpha = 1;
      }
      // Track label, pinned to the visible start
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const label = name;
      const lx = Math.max(xs, 0) + 10;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = col('--c-surface');
      ctx.globalAlpha = 0.7;
      roundRect(ctx, lx - 6, top + 5, tw + 12, 18, 5);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = wave;
      ctx.fillText(label, lx, top + 14);
      ctx.restore();
    }
  }, []);

  useEffect(() => {
    draw();
  }, [draw, zoom, viewW, ranges, peaks, theme, duration, fileName, proposed]);

  const onScroll = () => {
    draw();
    setScrollLeft(scrollerRef.current.scrollLeft);
  };

  // ---- playhead: follows the video every frame, no React re-render ----
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const { xOf: X, follow: f } = live.current;
      const t = player.time;
      const x = X(t);
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
      const sc = scrollerRef.current;
      const v = player.element;
      if (f && sc && v && !v.paused && !gesture.current) {
        const left = sc.scrollLeft;
        const w = sc.clientWidth;
        if (x > left + w - 48 || x < left) sc.scrollLeft = Math.max(0, x - w * 0.2);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- zoom ----
  const zoomTo = useCallback(
    (next, anchorOffset) => {
      const sc = scrollerRef.current;
      if (!sc) return;
      const { fitPps: F, zoom: Z } = live.current;
      const clamped = Math.min(MAX_PPS, Math.max(F, next));
      if (Math.abs(clamped - Z) < 1e-6) return;
      // Keep the anchor (default: playhead if visible, else centre) still while zooming.
      let off = anchorOffset;
      if (off == null) {
        const px = PAD + player.time * Z - sc.scrollLeft;
        off = px >= 0 && px <= sc.clientWidth ? px : sc.clientWidth / 2;
      }
      const tAnchor = (sc.scrollLeft + off - PAD) / Z;
      pendingScroll.current = Math.max(0, PAD + tAnchor * clamped - off);
      setPps(clamped <= F + 1e-6 ? null : clamped);
    },
    [],
  );

  useEffect(() => {
    const sc = scrollerRef.current;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = sc.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * 0.0025);
        zoomTo(live.current.zoom * factor, e.clientX - rect.left);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        sc.scrollLeft += e.deltaY;
      }
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '=' || e.key === '+') zoomTo(live.current.zoom * 1.5);
      else if (e.key === '-' || e.key === '_') zoomTo(live.current.zoom / 1.5);
      else if (e.key === '0') zoomTo(0);
      else if (e.key === 'c' || e.key === 'C') setTool('razor');
      else if (e.key === 'v' || e.key === 'V' || e.key === 'Escape') setTool('select');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomTo]);

  // ---- pointer: scrub (ruler), click-seek / drag-select (tracks), trim (handles) ----
  const localX = (e) => e.clientX - contentRef.current.getBoundingClientRect().left;

  const showHover = (x) => {
    const { words, gaps, duration: D, removedRanges: rr, splits: sp } = useEditorStore.getState();
    const razor = live.current.tool === 'razor';
    // Razor: show exactly where the split would go, and whether it's allowed there.
    const t = razor ? snapCut(tOf(x), words, gaps) : snapSeek(tOf(x), words, gaps, D);
    const ok = razor && Boolean(splitTarget(t, gaps, gapCutTimes(sp, rr)));
    const hx = xOf(t);
    if (hoverRef.current) {
      hoverRef.current.style.opacity = '1';
      hoverRef.current.style.transform = `translateX(${hx}px)`;
    }
    if (hoverLineRef.current) {
      hoverLineRef.current.style.borderColor = razor ? (ok ? 'var(--c-accent)' : 'var(--c-subtle)') : '';
      hoverLineRef.current.style.borderLeftStyle = razor && ok ? 'solid' : 'dashed';
    }
    if (hoverLabelRef.current) {
      hoverLabelRef.current.textContent = !razor ? formatClock(t) : ok ? `Split ${formatClock(t)}` : "Words can't be split";
      hoverLabelRef.current.style.background = razor && ok ? 'var(--c-accent)' : '';
      hoverLabelRef.current.style.color = razor && ok ? '#fff' : '';
    }
  };
  const hideHover = () => {
    if (hoverRef.current) hoverRef.current.style.opacity = '0';
  };

  const edgeScroll = (e) => {
    const sc = scrollerRef.current;
    const r = sc.getBoundingClientRect();
    if (e.clientX < r.left + 28) sc.scrollLeft -= 14;
    else if (e.clientX > r.right - 28) sc.scrollLeft += 14;
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || status !== 'ready') return;
    const x = localX(e);
    const y = e.clientY - contentRef.current.getBoundingClientRect().top;
    const { words, gaps } = useEditorStore.getState();
    if (tool === 'razor' && y >= RULER_H) {
      // Same snapping as the hover guide; addSplit refuses anything outside a pause.
      useEditorStore.getState().addSplit(snapCut(tOf(x), words, gaps));
      showHover(x);
      return;
    }
    contentRef.current.setPointerCapture(e.pointerId);
    if (y < RULER_H) {
      gesture.current = { mode: 'scrub' };
      player.seekSnapped(tOf(x));
    } else {
      gesture.current = { mode: 'select', startX: x, startT: snapCut(tOf(x), words, gaps), moved: false };
    }
  };

  const startTrim = (index, edge, e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    contentRef.current.setPointerCapture(e.pointerId);
    gesture.current = { mode: 'trim', index, edge };
  };

  const onPointerMove = (e) => {
    const x = localX(e);
    showHover(x);
    const g = gesture.current;
    if (!g) return;
    edgeScroll(e);
    const { words, gaps, removedRanges: base, setRangeSelection } = useEditorStore.getState();
    if (g.mode === 'scrub') {
      player.seekSnapped(tOf(x));
    } else if (g.mode === 'select') {
      if (!g.moved && Math.abs(x - g.startX) < 4) return;
      g.moved = true;
      const t = snapCut(tOf(x), words, gaps);
      setRangeSelection({ start: Math.min(g.startT, t), end: Math.max(g.startT, t) });
    } else if (g.mode === 'trim') {
      const t = snapCut(tOf(x), words, gaps);
      trimRef.current = moveRangeEdge(base, g.index, g.edge, t);
      setTrimPreview(trimRef.current);
    }
  };

  const onPointerUp = (e) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const s = useEditorStore.getState();
    if (g.mode === 'select' && !g.moved) {
      s.setSelection(null);
      player.seekSnapped(tOf(localX(e)));
    } else if (g.mode === 'trim') {
      const preview = trimRef.current;
      trimRef.current = null;
      setTrimPreview(null);
      if (preview && JSON.stringify(preview) !== JSON.stringify(s.removedRanges)) s.commit(normalize(preview));
    }
  };

  // ---- virtualised window (render only what's near the viewport) ----
  const winA = scrollLeft - viewW;
  const winB = scrollLeft + 2 * viewW;

  return (
    <div className="panel fade-up flex shrink-0 flex-col overflow-hidden" style={{ animationDelay: '120ms' }}>
      <TimelineToolbar
        zoom={zoom}
        fitPps={fitPps}
        zoomTo={zoomTo}
        follow={follow}
        setFollow={setFollow}
        tool={tool}
        setTool={setTool}
      />

      <div className="flex min-h-0 flex-1">
        <TrackLabels />
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden bg-sunken/40"
        >
          <div
            ref={contentRef}
            className="relative touch-none select-none overflow-clip"
            style={{ width: contentW, height: CONTENT_H, cursor: tool === 'razor' ? RAZOR_CURSOR : undefined }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={hideHover}
          >
            <canvas ref={canvasRef} className="pointer-events-none sticky left-0 top-0 block" />

            {duration > 0 && (
              <>
                <BrollTrack xOf={xOf} winA={winA} winB={winB} />
                <CaptionTrack items={items} ranges={ranges} xOf={xOf} winA={winA} winB={winB} zoom={zoom} tool={tool} />
                <VideoTrack
                  ranges={ranges}
                  splits={splits}
                  xOf={xOf}
                  tOf={tOf}
                  winA={winA}
                  winB={winB}
                  startTrim={startTrim}
                  tool={tool}
                />
                <SplitMarkers splits={splits} xOf={xOf} winA={winA} winB={winB} />
                <SelectionOverlay xOf={xOf} />
              </>
            )}

            {/* Hover guide: shows exactly where a click will land (after snapping). */}
            <div
              ref={hoverRef}
              className="pointer-events-none absolute left-0 top-0 z-20 h-full opacity-0 transition-opacity duration-150"
            >
              <div ref={hoverLineRef} className="absolute top-0 h-full border-l border-dashed border-fg/30" />
              <div
                ref={hoverLabelRef}
                className="absolute -translate-x-1/2 rounded bg-fg px-1.5 py-0.5 font-mono text-[10px] font-medium text-canvas shadow"
                style={{ top: CONTENT_H - 18 }}
              />
            </div>

            {/* Playhead */}
            <div ref={playheadRef} className="pointer-events-none absolute left-0 top-0 z-30 h-full will-change-transform">
              <div className="absolute -left-[1px] top-0 h-full w-[2px] bg-fg shadow-[0_0_0_1px_rgb(0_0_0/0.15)]" />
              <div className="absolute -left-[7px] top-0.5 h-4 w-[14px] rounded-[4px] rounded-b-[7px] bg-fg shadow-md" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// ---------------------------------------------------------------------------

/**
 * B-roll layer: one chip per overlay over the words it covers (source time, like every
 * other row). Click to select it (opens the B-roll panel over the preview).
 */
function BrollTrack({ xOf, winA, winB }) {
  const brolls = useEditorStore((s) => s.brolls);
  const words = useEditorStore((s) => s.words);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const duration = useEditorStore((s) => s.duration);
  const selectedId = useEditorStore((s) => s.selectedOverlayId);
  const media = useMediaStore((s) => s.media);
  const resolved = useMemo(() => resolveBrolls(brolls, words, removedRanges, duration), [brolls, words, removedRanges, duration]);
  const { top, h } = ROWS.broll;

  if (!resolved.length) {
    return (
      <div
        className="pointer-events-none absolute flex items-center text-[11px] text-subtle"
        style={{ left: xOf(0) + 8, top, height: h }}
      >
        Select words, then “Add B-roll” to show footage over them
      </div>
    );
  }
  return (
    <>
      {resolved.map((b) => {
        const a = xOf(b.srcStart);
        const z = xOf(b.srcEnd);
        if (z < winA || a > winB) return null;
        const m = media[b.mediaId];
        const selected = b.id === selectedId;
        return (
          <button
            key={b.id}
            type="button"
            tabIndex={-1}
            title={`${m?.name ?? 'B-roll'}: ${b.mode === 'pip' ? 'picture-in-picture' : 'full screen'}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              useEditorStore.getState().selectOverlay(b.id);
              player.seek(b.srcStart);
            }}
            className={`absolute flex items-center gap-1 overflow-hidden whitespace-nowrap rounded-md px-1.5 text-left text-[11px] font-semibold text-white shadow transition-[box-shadow] ${
              selected ? 'ring-2 ring-fg' : 'hover:brightness-110'
            }`}
            style={{ left: a + 1, width: Math.max(4, z - a - 2), top, height: h, background: 'linear-gradient(180deg, #8b5cf6, #6d28d9)' }}
          >
            <I.Film className="shrink-0 text-[12px]" />
            <span className="truncate">{m?.name ?? 'B-roll'}</span>
            {b.mode === 'pip' && <span className="ml-auto shrink-0 rounded bg-white/25 px-1 text-[9px]">PiP</span>}
          </button>
        );
      })}
    </>
  );
}

function TrackLabels() {
  const row = 'absolute left-0 right-0 flex items-center gap-1.5 px-3 text-[11px] font-medium text-subtle';
  return (
    <div className="relative hidden w-[84px] shrink-0 border-r border-line bg-raised sm:block" style={{ height: CONTENT_H }}>
      <div className="absolute inset-x-0 top-0 border-b border-line-strong" style={{ height: RULER_H }} />
      <div className={row} style={{ top: ROWS.broll.top, height: ROWS.broll.h }}>
        <I.Film className="text-[13px]" /> B-roll
      </div>
      <div className={row} style={{ top: ROWS.caption.top, height: ROWS.caption.h }}>
        <I.Text className="text-[13px]" /> Words
      </div>
      <div className={row} style={{ top: ROWS.video.top, height: ROWS.video.h }}>
        <I.Film className="text-[13px]" /> Video
      </div>
      <div className={row} style={{ top: ROWS.audio.top, height: ROWS.audio.h }}>
        <I.Wave className="text-[13px]" /> Audio
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const CaptionTrack = memo(function CaptionTrack({ items, ranges, xOf, winA, winB, zoom, tool }) {
  const selection = useEditorStore((s) => s.selection);
  const activeWordId = useEditorStore((s) => s.activeWordId);
  const lo = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const hi = selection ? Math.max(selection.anchor, selection.focus) : -2;

  const onDown = (index, e) => {
    if (e.button !== 0) return;
    if (tool === 'razor') return; // let the click reach the track: the razor handles it
    e.stopPropagation();
    const s = useEditorStore.getState();
    if (e.shiftKey && s.selection) {
      s.setSelection({ anchor: s.selection.anchor, focus: index });
    } else {
      s.setSelection({ anchor: index, focus: index });
      player.seek(s.items[index].start); // word starts are boundaries already
    }
  };

  const { top, h } = ROWS.caption;
  return (
    <>
      {items.map((it, i) => {
        const a = xOf(it.start);
        const b = xOf(it.end);
        if (b < winA || a > winB) return null;
        const w = Math.max(2, b - a - 2);
        const removed = isSpanRemoved(it, ranges);
        const selected = i >= lo && i <= hi;
        const active = it.id === activeWordId;
        const isGap = it.kind === 'gap';
        return (
          <button
            key={it.id}
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => onDown(i, e)}
            title={isGap ? 'Silence' : it.text}
            className={[
              'absolute overflow-hidden whitespace-nowrap rounded-md text-left text-[12px] font-medium transition-[background-color,color,box-shadow] duration-150',
              w > 18 ? 'px-1.5' : 'px-0',
              isGap
                ? 'border border-dashed border-line-strong bg-transparent text-subtle'
                : active && !removed
                  ? 'bg-highlight text-highlight-fg shadow-[0_0_0_1px_var(--c-highlight),0_4px_14px_-4px_var(--c-highlight)]'
                  : 'bg-caption text-fg hover:brightness-110',
              removed ? 'opacity-40 line-through decoration-accent decoration-2' : '',
              selected ? 'ring-2 ring-accent ring-offset-0 z-10' : '',
            ].join(' ')}
            style={{ left: a + 1, width: w, top, height: h }}
          >
            {!isGap && w > 14 && zoom > 0 ? it.text : ''}
          </button>
        );
      })}
    </>
  );
});

// ---------------------------------------------------------------------------

const VideoTrack = memo(function VideoTrack({ ranges, splits, xOf, tOf, winA, winB, startTrim, tool }) {
  const thumbnails = useEditorStore((s) => s.thumbnails);
  const duration = useEditorStore((s) => s.duration);
  const vw = useEditorStore((s) => s.videoWidth);
  const vh = useEditorStore((s) => s.videoHeight);
  const { top, h } = ROWS.video;

  const x0 = xOf(0);
  const x1 = xOf(duration);
  const tileW = Math.min(150, Math.max(44, (h * (vw || 16)) / (vh || 9)));
  // Kept clips, divided at razor marks so each piece is framed as its own clip.
  const clips = useMemo(() => {
    const out = [];
    for (const k of buildEDL(ranges, duration)) {
      let a = k.start;
      for (const t of splits) {
        if (t > a && t < k.end) {
          out.push({ start: a, end: t });
          a = t;
        }
      }
      out.push({ start: a, end: k.end });
    }
    return out;
  }, [ranges, splits, duration]);

  const tiles = [];
  if (thumbnails.length) {
    const first = Math.max(0, Math.floor((winA - x0) / tileW));
    const last = Math.ceil((Math.min(winB, x1) - x0) / tileW);
    for (let i = first; i < last; i++) {
      const left = x0 + i * tileW;
      const t = tOf(left + tileW / 2);
      tiles.push({ left, url: nearestThumb(thumbnails, t) });
    }
  }

  return (
    <>
      {/* Filmstrip */}
      <div
        className="pointer-events-none absolute overflow-hidden rounded-lg bg-raised"
        style={{ left: x0, width: x1 - x0, top, height: h }}
      >
        {tiles.map((tile) => (
          <div
            key={tile.left}
            className="absolute top-0 h-full border-r border-black/20 bg-cover bg-center"
            style={{ left: tile.left - x0, width: tileW, backgroundImage: `url(${tile.url})` }}
          />
        ))}
        {!thumbnails.length && <div className="shimmer absolute inset-0 opacity-10" />}
      </div>

      {/* Kept clips: framed like separate clips */}
      {clips.map((k) => {
        const a = xOf(k.start);
        const b = xOf(k.end);
        if (b < winA || a > winB) return null;
        return (
          <div
            key={`k-${k.start}`}
            className="pointer-events-none absolute rounded-lg ring-2 ring-inset ring-white/70 dark:ring-white/50"
            style={{ left: a, width: Math.max(2, b - a), top, height: h }}
          />
        );
      })}

      {/* Removed ranges: hatched, with draggable trim edges (snapped) */}
      {ranges.map((r, i) => {
        const a = xOf(r.start);
        const b = xOf(r.end);
        if (b < winA || a > winB) return null;
        const w = Math.max(2, b - a);
        return (
          <div key={`r-${i}`} className="absolute" style={{ left: a, width: w, top, height: h }}>
            <div className="stripes absolute inset-0 rounded-md opacity-90 mix-blend-normal" />
            <div className="absolute inset-0 rounded-md bg-canvas/55" />
            {w > 46 && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-white shadow">
                  <I.Scissors /> {(r.end - r.start).toFixed(1)}s
                </span>
              </span>
            )}
            {tool !== 'razor' && (
              <>
                <TrimHandle side="start" onPointerDown={(e) => startTrim(i, 'start', e)} />
                <TrimHandle side="end" onPointerDown={(e) => startTrim(i, 'end', e)} />
              </>
            )}
          </div>
        );
      })}
    </>
  );
});

/** Razor marks: a thin line through the word and video rows. */
function SplitMarkers({ splits, xOf, winA, winB }) {
  return (
    <>
      {splits.map((t) => {
        const x = xOf(t);
        if (x < winA || x > winB) return null;
        return (
          <div
            key={t}
            className="pointer-events-none absolute z-[15] w-0 border-l-2 border-accent"
            style={{ left: x - 1, top: ROWS.caption.top - 4, height: ROWS.video.top + ROWS.video.h - ROWS.caption.top + 8 }}
          />
        );
      })}
    </>
  );
}

function TrimHandle({ side, onPointerDown }) {
  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to trim (snaps to word edges)"
      className={`group absolute top-0 z-10 flex h-full w-3 cursor-ew-resize items-center justify-center ${
        side === 'start' ? '-left-1.5' : '-right-1.5'
      }`}
    >
      <div className="h-full w-1.5 rounded-sm bg-accent shadow transition-all group-hover:w-2 group-hover:brightness-110">
        <div className="mx-auto mt-[22px] h-3 w-px bg-white/80" />
      </div>
    </div>
  );
}

function nearestThumb(thumbs, t) {
  let lo = 0;
  let hi = thumbs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (thumbs[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const a = thumbs[Math.max(0, lo - 1)];
  const b = thumbs[lo];
  return Math.abs(a.t - t) < Math.abs(b.t - t) ? a.url : b.url;
}

// ---------------------------------------------------------------------------

function useSelectionSpan() {
  const selection = useEditorStore((s) => s.selection);
  const selectionRange = useEditorStore((s) => s.selectionRange);
  const items = useEditorStore((s) => s.items);
  return useMemo(() => getSelectionSpan({ selection, selectionRange, items }), [selection, selectionRange, items]);
}

function SelectionOverlay({ xOf }) {
  const span = useSelectionSpan();
  if (!span) return null;
  const a = xOf(span.range.start);
  const b = xOf(span.range.end);
  const len = span.range.end - span.range.start;
  return (
    <div
      className="pointer-events-none absolute z-10 border-x-2 border-accent bg-accent-soft"
      style={{ left: a, width: Math.max(2, b - a), top: RULER_H, height: CONTENT_H - RULER_H }}
    >
      {b - a > 54 && (
        <span className="absolute left-1/2 top-1 -translate-x-1/2 rounded bg-accent px-1.5 text-[10px] font-semibold text-white">
          {len.toFixed(2)}s
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TimelineToolbar({ zoom, fitPps, zoomTo, follow, setFollow, tool, setTool }) {
  const ready = useEditorStore((s) => s.status === 'ready');
  const span = useSelectionSpan();
  const restoring = useEditorStore((s) => selectionIsRemoved(s));
  const canAddBrollNow = useEditorStore((s) => canAddBroll(s));

  // Zoom slider is logarithmic between fit and max.
  const lo = Math.log(fitPps);
  const hi = Math.log(Math.max(MAX_PPS, fitPps * 1.01));
  const sliderVal = Math.round(((Math.log(zoom) - lo) / (hi - lo)) * 100) || 0;

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-line px-2 py-1.5 [scrollbar-width:none]">
      <IconBtn label="Selection tool (V)" active={tool === 'select'} onClick={() => setTool('select')}>
        <I.Pointer />
      </IconBtn>
      <IconBtn label="Razor: split a pause (C)" active={tool === 'razor'} disabled={!ready} onClick={() => setTool('razor')}>
        <I.Scissors />
      </IconBtn>
      <Divider />
      <IconBtn
        label={restoring ? 'Restore selection (Del)' : 'Delete selection (Del)'}
        disabled={!ready || !span}
        onClick={deleteOrRestoreSelection}
        danger={!restoring}
      >
        {restoring ? <I.Restore /> : <I.Trash />}
      </IconBtn>
      <IconBtn
        label="Add B-roll over the selection (video or image)"
        disabled={!canAddBrollNow}
        onClick={() => addBrollOverSelection()}
      >
        <span className="relative">
          <I.Film />
          <I.Plus className="absolute -bottom-1 -right-1.5 text-[10px]" />
        </span>
      </IconBtn>
      <IconBtn label="Clear selection (Esc)" disabled={!span} onClick={() => useEditorStore.getState().setSelection(null)}>
        <I.X />
      </IconBtn>
      <Divider />
      <IconBtn label="Previous word edge (←)" onClick={() => stepBoundary(-1)}>
        <I.SkipBack />
      </IconBtn>
      <PlayToggle />
      <IconBtn label="Next word edge (→)" onClick={() => stepBoundary(1)}>
        <I.SkipForward />
      </IconBtn>

      <div className="mx-auto flex shrink-0 items-center px-2">
        <Clock />
      </div>

      <span
        className="mr-1 hidden shrink-0 items-center gap-1 rounded-full bg-wave-bg px-2 py-1 text-[11px] font-medium text-wave sm:flex"
        title="Word snap is on: seeks, selections and trims snap to word edges, so nothing lands mid-word"
      >
        <I.Magnet /> <span className="hidden 2xl:inline">Word snap</span>
      </span>
      <IconBtn label={follow ? 'Following playhead' : 'Follow playhead'} active={follow} onClick={() => setFollow(!follow)}>
        <I.Crosshair />
      </IconBtn>
      <Divider />
      <IconBtn label="Zoom out (-)" onClick={() => zoomTo(zoom / 1.5)} disabled={zoom <= fitPps + 1e-6}>
        <I.ZoomOut />
      </IconBtn>
      <input
        type="range"
        min={0}
        max={100}
        value={sliderVal}
        onChange={(e) => zoomTo(Math.exp(lo + (Number(e.target.value) / 100) * (hi - lo)))}
        className="hidden h-1 w-20 shrink-0 cursor-pointer accent-[var(--c-accent)] xl:block"
        aria-label="Zoom"
      />
      <IconBtn label="Zoom in (+)" onClick={() => zoomTo(zoom * 1.5)} disabled={zoom >= MAX_PPS - 1e-6}>
        <I.ZoomIn />
      </IconBtn>
      <IconBtn label="Fit to width (0)" onClick={() => zoomTo(0)} disabled={zoom <= fitPps + 1e-6}>
        <I.Fit />
      </IconBtn>
    </div>
  );
}

export function stepBoundary(dir) {
  const { words, duration } = useEditorStore.getState();
  const b = wordBoundaries(words, duration);
  const t = player.time;
  player.seek(dir > 0 ? nextBoundary(t, b) : prevBoundary(t, b));
}

function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-line-strong" />;
}

export function IconBtn({ label, onClick, disabled, active, danger, children }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        'grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[15px] transition-all duration-150',
        'disabled:cursor-not-allowed disabled:opacity-30 enabled:active:scale-90',
        active ? 'bg-accent-soft text-accent' : danger ? 'text-fg enabled:hover:bg-accent-soft enabled:hover:text-accent' : 'text-muted enabled:hover:bg-hover enabled:hover:text-fg',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function PlayToggle() {
  const playing = usePlaying();
  return (
    <button
      type="button"
      onClick={() => player.togglePlay()}
      title="Play / pause (Space)"
      aria-label={playing ? 'Pause' : 'Play'}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-fg text-[13px] text-canvas shadow transition-transform hover:scale-105 active:scale-95"
    >
      {playing ? <I.Pause /> : <I.Play className="translate-x-[1px]" />}
    </button>
  );
}

/** Current / total time (source) plus the position in the edited output. */
function Clock() {
  const curRef = useRef(null);
  const outRef = useRef(null);
  const duration = useEditorStore((s) => s.duration);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const edl = useMemo(() => buildEDL(removedRanges, duration), [removedRanges, duration]);
  const edited = editedDuration(removedRanges, duration);

  useEffect(() => {
    let raf = 0;
    let last = -1;
    const tick = () => {
      const t = player.time;
      if (t !== last) {
        last = t;
        if (curRef.current) curRef.current.textContent = formatClock(t);
        if (outRef.current) outRef.current.textContent = formatClock(sourceToOutput(t, edl));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [edl]);

  return (
    <div className="flex items-baseline gap-3 whitespace-nowrap font-mono text-[12px] tabular-nums">
      <span>
        <span ref={curRef} className="font-medium text-fg">
          0:00.00
        </span>
        <span className="text-subtle"> / {formatClock(duration)}</span>
      </span>
      {edited < duration - 0.01 && (
        <span className="hidden text-accent xl:inline" title="Position and length in the edited video">
          ✂ <span ref={outRef}>0:00.00</span> / {formatClock(edited)}
        </span>
      )}
    </div>
  );
}

/** True while the preview is playing. */
export function usePlaying() {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    let raf = 0;
    let last = null;
    const tick = () => {
      const v = player.element;
      const p = Boolean(v && !v.paused && !v.ended);
      if (p !== last) {
        last = p;
        setPlaying(p);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return playing;
}