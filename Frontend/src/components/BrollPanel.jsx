import { useMemo } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { useMediaStore } from '../store/useMediaStore.js';
import { PIP_CORNERS } from '../lib/overlays.js';
import {
  updateBroll,
  removeBroll,
  replaceBrollMedia,
  beginBrollDrag,
  setBrollLive,
  endBrollDrag,
} from '../store/overlayActions.js';
import * as I from './icons.jsx';

const CORNER_LABEL = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' };

/**
 * Settings for the selected B-roll, floating at the preview's top-left: full screen or
 * picture-in-picture, PiP corner and size, fade, where the clip starts, replace, remove.
 * Every change is undoable (sliders: one step per drag).
 */
export default function BrollPanel() {
  const id = useEditorStore((s) => s.selectedOverlayId);
  const item = useEditorStore((s) => s.brolls.find((b) => b.id === s.selectedOverlayId));
  const words = useEditorStore((s) => s.words);
  const media = useMediaStore((s) => (item ? s.media[item.mediaId] : null));

  const covers = useMemo(() => {
    if (!item) return '';
    const a = item.anchor;
    if (!a?.startWordId) return 'a section without speech';
    const i = words.findIndex((w) => w.id === a.startWordId);
    const j = words.findIndex((w) => w.id === a.endWordId);
    if (i < 0 || j < 0) return '';
    const text = words.slice(i, j + 1).map((w) => w.text).join(' ');
    return `“${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`;
  }, [item, words]);

  if (!id || !item) return null;
  const close = () => useEditorStore.getState().selectOverlay(null);
  const slider = (onLive) => ({
    onPointerDown: beginBrollDrag,
    onKeyDown: beginBrollDrag,
    onChange: (e) => onLive(Number(e.target.value)),
    onPointerUp: endBrollDrag,
    onKeyUp: endBrollDrag,
    onBlur: endBrollDrag,
  });

  return (
    <div
      className="panel fade-up absolute left-3 top-3 z-30 flex max-h-[calc(100%-96px)] w-[280px] flex-col overflow-hidden text-fg"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-violet-600 text-[12px] text-white">
          <I.Film />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">B-roll</h3>
          <p className="truncate text-[11px] text-subtle" title={media?.name}>
            {media ? `${media.name} · ${media.kind === 'image' ? 'image' : `${media.duration.toFixed(1)}s video`}` : 'Missing media'}
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg"
          aria-label="Close B-roll settings"
        >
          <I.X />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {covers && (
          <p className="text-[11px] text-muted">
            Shown over {covers}. It follows these words when you edit.
          </p>
        )}

        <section>
          <Label>Show as</Label>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-sunken p-1">
            {[
              ['cutaway', 'Full screen'],
              ['pip', 'Picture-in-picture'],
            ].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => item.mode !== mode && updateBroll(item.id, { mode })}
                className={`rounded-lg py-1 text-xs font-medium transition-colors ${
                  item.mode === mode ? 'bg-raised text-fg shadow' : 'text-muted hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {item.mode === 'pip' && (
          <>
            <section>
              <Label>Corner</Label>
              <div className="grid grid-cols-2 gap-1">
                {PIP_CORNERS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => item.pip.corner !== c && updateBroll(item.id, { pip: { corner: c } })}
                    className={`rounded-lg border py-1 text-[11px] font-medium transition-colors ${
                      item.pip.corner === c ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'
                    }`}
                  >
                    {CORNER_LABEL[c]}
                  </button>
                ))}
              </div>
            </section>
            <section>
              <Label value={`${Math.round(item.pip.size * 100)}%`}>Size</Label>
              <input
                type="range"
                min={0.15}
                max={0.6}
                step={0.01}
                value={item.pip.size}
                {...slider((v) => setBrollLive(item.id, { pip: { size: v } }))}
                className="w-full accent-[var(--c-accent)]"
                aria-label="Picture-in-picture size"
              />
            </section>
          </>
        )}

        {media?.kind === 'video' && media.duration > 0.5 && (
          <section>
            <Label value={`${item.offset.toFixed(1)}s`}>Start clip at</Label>
            <input
              type="range"
              min={0}
              max={Math.max(0, media.duration - 0.2)}
              step={0.1}
              value={item.offset}
              {...slider((v) => setBrollLive(item.id, { offset: v }))}
              className="w-full accent-[var(--c-accent)]"
              aria-label="Where the B-roll clip starts"
            />
          </section>
        )}

        <label className="flex cursor-pointer items-center justify-between text-xs font-semibold text-muted">
          Fade in and out
          <input
            type="checkbox"
            checked={item.fade}
            onChange={() => updateBroll(item.id, { fade: !item.fade })}
            className="h-4 w-4 accent-[var(--c-accent)]"
          />
        </label>

        <p className="text-[11px] text-subtle">B-roll is muted; the main video's sound keeps playing.</p>

        <div className="flex gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={() => replaceBrollMedia(item.id)}
            className="flex-1 rounded-lg border border-line bg-raised py-1.5 text-xs font-medium hover:bg-hover"
          >
            Replace media
          </button>
          <button
            type="button"
            onClick={() => removeBroll(item.id)}
            className="flex-1 rounded-lg border border-red-500/40 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10 dark:text-red-300"
          >
            Remove
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
