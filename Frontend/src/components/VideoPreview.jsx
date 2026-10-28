import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { buildEDL, editedDuration, nextPlayableTime, outputToSource, sourceToOutput } from '../lib/edl.js';
import { findWordIndexAt } from '../lib/transcript.js';
import { formatClock, snapSeek } from '../lib/timeline.js';
import { player } from '../media/player.js';
import { stepBoundary, usePlaying } from './Timeline.jsx';
import * as I from './icons.jsx';
import SubtitleCanvas from './SubtitleCanvas.jsx';
import SubtitlePanel from './SubtitlePanel.jsx';
import { useSubtitleStore } from '../store/useSubtitleStore.js';
import PreviewCanvas from './PreviewCanvas.jsx';
import FormatPanel from './FormatPanel.jsx';
import BrollPanel from './BrollPanel.jsx';
import { ASPECTS } from '../lib/frame.js';

/**
 * Preview: a <video> plus a requestAnimationFrame loop that
 *  - jumps over removed ranges while playing (skip playback), and
 *  - updates the active word for transcript / timeline highlighting.
 * Custom controls scrub on the *edited* timeline, with the same word snapping as the
 * timeline, so the scrub bar, the timeline and the transcript always agree.
 */
export default function VideoPreview() {
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const videoUrl = useEditorStore((s) => s.videoUrl);
  const subtitlesOn = useSubtitleStore((s) => s.enabled);
  const subtitlePanelOpen = useSubtitleStore((s) => s.panelOpen);
  const [formatOpen, setFormatOpen] = useState(false);
  const panelOpen = subtitlePanelOpen || formatOpen;
  const aspect = useEditorStore((s) => s.frame.aspect);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const playing = usePlaying();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    player.attach(video);

    let raf = 0;
    const tick = () => {
      const { removedRanges, duration, words, setActiveWordId } = useEditorStore.getState();
      const t = video.currentTime;

      if (!video.paused) {
        const next = nextPlayableTime(t, removedRanges, duration);
        if (next === null) {
          video.pause(); // everything after here is cut
        } else if (next !== t) {
          video.currentTime = next + 0.001;
        }
      }

      const i = findWordIndexAt(words, video.currentTime);
      setActiveWordId(i >= 0 ? words[i].id : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      player.detach(video);
    };
  }, [videoUrl]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted;
      videoRef.current.volume = volume;
    }
  }, [muted, volume]);

  if (!videoUrl) return null;

  const fullscreen = () => {
    const el = wrapRef.current;
    if (document.fullscreenElement) document.exitFullscreen();
    else el?.requestFullscreen?.();
  };

  return (
    <div
      ref={wrapRef}
      className="group/video relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl bg-black shadow-[0_20px_50px_-20px_rgb(0_0_0/0.6)] ring-1 ring-line"
    >
      <video
        ref={videoRef}
        src={videoUrl}
        playsInline
        onClick={() => player.togglePlay()}
        className="h-full max-h-full w-full cursor-pointer object-contain"
      />
      {/* What you actually see: the video framed to the output aspect ratio (crop / fit). */}
      <PreviewCanvas videoRef={videoRef} onClick={() => player.togglePlay()} />

      {/* Big play button when paused */}
      <button
        type="button"
        onClick={() => player.togglePlay()}
        aria-label="Play"
        className={`absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-2xl text-white ring-1 ring-white/25 backdrop-blur-md transition-all duration-300 hover:scale-105 hover:bg-white/25 ${
          playing ? 'pointer-events-none scale-75 opacity-0' : 'scale-100 opacity-100'
        }`}
      >
        <I.Play className="translate-x-[2px]" />
      </button>

      {/* Subtitles: same renderer as the export; drag to move, corner to resize. */}
      <SubtitleCanvas videoRef={videoRef} onBackgroundClick={() => player.togglePlay()} />
      <SubtitlePanel />
      {formatOpen && <FormatPanel videoRef={videoRef} onClose={() => setFormatOpen(false)} />}
      <BrollPanel />

      {/* Control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pb-3 pt-10 text-white transition-opacity duration-300 ${
          playing && !panelOpen ? 'opacity-0 group-hover/video:opacity-100' : 'opacity-100'
        }`}
      >
        <ScrubBar />
        <div className="mt-2 flex items-center gap-1 text-[15px]">
          <CtrlBtn label="Previous word edge" onClick={() => stepBoundary(-1)}>
            <I.SkipBack />
          </CtrlBtn>
          <CtrlBtn label={playing ? 'Pause' : 'Play'} onClick={() => player.togglePlay()}>
            {playing ? <I.Pause /> : <I.Play />}
          </CtrlBtn>
          <CtrlBtn label="Next word edge" onClick={() => stepBoundary(1)}>
            <I.SkipForward />
          </CtrlBtn>
          <div className="group/vol ml-1 flex items-center">
            <CtrlBtn label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted(!muted)}>
              {muted || volume === 0 ? <I.Mute /> : <I.Volume />}
            </CtrlBtn>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                setMuted(false);
              }}
              className="slim w-0 opacity-0 transition-all duration-200 group-hover/vol:ml-1 group-hover/vol:w-20 group-hover/vol:opacity-100"
              aria-label="Volume"
            />
          </div>
          <OutputClock />
          <div className="ml-auto flex items-center gap-1">
            <CtrlBtn
              label={subtitlesOn ? 'Turn subtitles off' : 'Add subtitles'}
              onClick={() => useSubtitleStore.getState().toggle()}
              active={subtitlesOn}
            >
              <span
                className={`rounded-[4px] border-[1.5px] px-[3px] text-[9px] font-bold leading-[13px] ${
                  subtitlesOn ? 'border-scarlet-400 bg-scarlet-400 text-white' : 'border-current'
                }`}
              >
                CC
              </span>
            </CtrlBtn>
            <CtrlBtn
              label="Subtitle style, size and position"
              onClick={() => {
                const s = useSubtitleStore.getState();
                if (!s.enabled) s.update({ enabled: true });
                s.setPanelOpen(!s.panelOpen);
                setFormatOpen(false);
              }}
              active={panelOpen}
            >
              <span className="text-[13px] font-bold leading-none">Aa</span>
            </CtrlBtn>
            <CtrlBtn
              label="Aspect ratio and framing"
              onClick={() => {
                setFormatOpen(!formatOpen);
                useSubtitleStore.getState().setPanelOpen(false);
              }}
              active={formatOpen}
            >
              <span
                className={`flex h-[15px] min-w-[30px] items-center justify-center rounded-[4px] border-[1.5px] px-[3px] text-[9px] font-bold leading-none ${
                  aspect !== 'original' ? 'border-scarlet-400 bg-scarlet-400 text-white' : 'border-current'
                }`}
              >
                {aspect === 'original' ? 'RATIO' : ASPECTS.find((a) => a.id === aspect)?.label}
              </span>
            </CtrlBtn>
            <CtrlBtn label="Fullscreen" onClick={fullscreen}>
              <I.Expand />
            </CtrlBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

function CtrlBtn({ label, onClick, active, children }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-lg transition-all hover:bg-white/15 active:scale-90 ${
        active ? 'text-white' : 'text-white/85'
      }`}
    >
      {children}
    </button>
  );
}

/** Progress bar over the edited (output) timeline. Scrubbing snaps to word edges. */
function ScrubBar() {
  const barRef = useRef(null);
  const fillRef = useRef(null);
  const knobRef = useRef(null);
  const duration = useEditorStore((s) => s.duration);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const edl = useMemo(() => buildEDL(removedRanges, duration), [removedRanges, duration]);
  const total = editedDuration(removedRanges, duration);
  const dragging = useRef(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = total > 0 ? sourceToOutput(player.time, edl) / total : 0;
      const pct = `${Math.min(100, Math.max(0, p * 100))}%`;
      if (fillRef.current) fillRef.current.style.width = pct;
      if (knobRef.current) knobRef.current.style.left = pct;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [edl, total]);

  const seekAt = (clientX) => {
    const r = barRef.current.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const { words, gaps, removedRanges: rr } = useEditorStore.getState();
    let t = snapSeek(outputToSource(p * total, edl), words, gaps, duration);
    const next = nextPlayableTime(t, rr, duration);
    if (next !== null) t = next;
    player.seek(t);
  };

  // Cut points marked on the bar (positions in the output timeline).
  const marks = [];
  let acc = 0;
  for (let i = 0; i < edl.length - 1; i++) {
    acc += edl[i].end - edl[i].start;
    marks.push(acc / total);
  }

  return (
    <div
      ref={barRef}
      className="group/bar relative flex h-4 cursor-pointer touch-none items-center"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && seekAt(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-[height] group-hover/bar:h-1.5">
        <div ref={fillRef} className="absolute inset-y-0 left-0 bg-scarlet-400" />
        {marks.map((m) => (
          <div key={m} className="absolute inset-y-0 w-[2px] bg-black/60" style={{ left: `${m * 100}%` }} />
        ))}
      </div>
      <div
        ref={knobRef}
        className="absolute h-3 w-3 -translate-x-1/2 scale-0 rounded-full bg-white shadow transition-transform group-hover/bar:scale-100"
      />
    </div>
  );
}

function OutputClock() {
  const ref = useRef(null);
  const duration = useEditorStore((s) => s.duration);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const edl = useMemo(() => buildEDL(removedRanges, duration), [removedRanges, duration]);
  const total = editedDuration(removedRanges, duration);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (ref.current) ref.current.textContent = formatClock(sourceToOutput(player.time, edl));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [edl]);
  return (
    <span className="ml-2 font-mono text-[12px] tabular-nums text-white/90">
      <span ref={ref}>0:00.00</span>
      <span className="text-white/50"> / {formatClock(total)}</span>
    </span>
  );
}
