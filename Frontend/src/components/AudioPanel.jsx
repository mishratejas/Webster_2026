import { useEffect } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { useMediaStore } from '../store/useMediaStore.js';
import { chooseMusic, removeMusic, updateMusic } from '../store/musicActions.js';
import * as I from './icons.jsx';

/**
 * Background music with automatic ducking, floating over the preview (top-right).
 * Ducking is keyed to the transcript: the music drops while (kept) words are spoken.
 */
export default function AudioPanel({ onClose }) {
  const music = useEditorStore((s) => s.music);
  const media = useMediaStore((s) => (music ? s.media[music.mediaId] : null));

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
        <span className="grid h-6 w-6 place-items-center rounded-md bg-teal-600 text-[13px] text-white">♪</span>
        <h3 className="text-sm font-semibold">Music</h3>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg"
          aria-label="Close music settings"
        >
          <I.X />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {!music || !media ? (
          <>
            <p className="text-xs text-muted">
              Add a background track. It drops automatically while someone is speaking (based on the
              transcript) and comes back up in the pauses.
            </p>
            <button
              type="button"
              onClick={chooseMusic}
              className="w-full rounded-xl bg-gradient-to-b from-scarlet-400 to-scarlet-600 py-2 text-sm font-semibold text-white hover:brightness-110"
            >
              Add music
            </button>
            <p className="text-[11px] text-subtle">MP3, WAV, M4A, AAC, OGG, or a video's sound. Stays on this device.</p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-xl border border-line bg-sunken px-3 py-2">
              <span className="text-teal-500">♪</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium" title={media.name}>
                {media.name}
              </span>
              <span className="font-mono text-[10px] text-subtle">{formatDur(media.duration)}</span>
            </div>

            <section>
              <Label value={`${Math.round(music.volume * 100)}%`}>Volume</Label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={music.volume}
                onChange={(e) => updateMusic({ volume: Number(e.target.value) })}
                className="w-full accent-[var(--c-accent)]"
                aria-label="Music volume"
              />
            </section>

            <section>
              <label className="flex cursor-pointer items-center justify-between text-xs font-semibold text-muted">
                Lower under speech (ducking)
                <input
                  type="checkbox"
                  checked={music.duck}
                  onChange={() => updateMusic({ duck: !music.duck })}
                  className="h-4 w-4 accent-[var(--c-accent)]"
                />
              </label>
              {music.duck && (
                <div className="mt-2">
                  <Label value={`${music.duckDb} dB`}>Lower by</Label>
                  <input
                    type="range"
                    min={-30}
                    max={-4}
                    step={1}
                    value={music.duckDb}
                    onChange={(e) => updateMusic({ duckDb: Number(e.target.value) })}
                    className="w-full accent-[var(--c-accent)]"
                    aria-label="Ducking amount"
                    style={{ direction: 'rtl' }}
                  />
                  <p className="mt-1 text-[11px] text-subtle">
                    Follows your edits: cut a sentence and its dip disappears too.
                  </p>
                </div>
              )}
            </section>

            {media.duration > 1 && (
              <section>
                <Label value={formatDur(music.offset)}>Start music at</Label>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, media.duration - 1)}
                  step={0.5}
                  value={music.offset}
                  onChange={(e) => updateMusic({ offset: Number(e.target.value) })}
                  className="w-full accent-[var(--c-accent)]"
                  aria-label="Where the music starts"
                />
              </section>
            )}

            <label className="flex cursor-pointer items-center justify-between text-xs font-semibold text-muted">
              Loop if the video is longer
              <input
                type="checkbox"
                checked={music.loop}
                onChange={() => updateMusic({ loop: !music.loop })}
                className="h-4 w-4 accent-[var(--c-accent)]"
              />
            </label>

            <div className="flex gap-2 border-t border-line pt-3">
              <button
                type="button"
                onClick={chooseMusic}
                className="flex-1 rounded-lg border border-line bg-raised py-1.5 text-xs font-medium hover:bg-hover"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={removeMusic}
                className="flex-1 rounded-lg border border-red-500/40 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10 dark:text-red-300"
              >
                Remove
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatDur(s) {
  if (!Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function Label({ children, value }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between text-xs font-semibold text-muted">
      <span>{children}</span>
      {value != null && <span className="font-mono tabular-nums text-subtle">{value}</span>}
    </div>
  );
}
