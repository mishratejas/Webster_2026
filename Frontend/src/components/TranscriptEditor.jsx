import { memo, useEffect, useMemo, useRef } from 'react';
import { useEditorStore, getSelectionSpan } from '../store/useEditorStore.js';
import { isSpanRemoved } from '../lib/edl.js';
import { gapLabel } from '../lib/transcript.js';
import { player } from '../media/player.js';
import { deleteOrRestoreSelection } from './editActions.js';
import { stepBoundary } from './Timeline.jsx';
import { KEEP } from '../lib/fillers.js';

/**
 * Read-only transcript (FR-3, FR-11). Each word and gap is its own element; there is no
 * contenteditable, so typing and pasting are impossible by construction.
 *
 * Selection is by whole items: click selects one, drag or shift-click extends.
 * Delete/Backspace cuts the selection; on an already-deleted selection it restores.
 */
export default function TranscriptEditor() {
  const items = useEditorStore((s) => s.items);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const selection = useEditorStore((s) => s.selection);
  const setSelection = useEditorStore((s) => s.setSelection);
  const dragging = useRef(false);

  const removed = useMemo(() => items.map((it) => isSpanRemoved(it, removedRanges)), [items, removedRanges]);

  // While a filler review is open, mark its candidates: 'cut' = selected, 'review' = not yet.
  const fillerReview = useEditorStore((s) => s.fillerReview);
  const proposals = useMemo(() => {
    const map = new Map();
    if (fillerReview?.phase !== 'review') return map;
    for (const c of fillerReview.candidates) {
      if (c.label === KEEP && !fillerReview.selected[c.id]) continue;
      for (const id of c.wordIds) map.set(id, fillerReview.selected[c.id] ? 'cut' : 'review');
    }
    return map;
  }, [fillerReview]);

  const span = getSelectionSpan({ selection, items });

  useEffect(() => {
    const stop = () => (dragging.current = false);
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);

  const onPointerDown = (index, e) => {
    e.preventDefault();
    if (e.shiftKey && selection) {
      setSelection({ anchor: selection.anchor, focus: index });
    } else {
      setSelection({ anchor: index, focus: index });
      player.seek(items[index].start);
    }
    dragging.current = true;
  };

  const onPointerEnter = (index) => {
    if (!dragging.current) return;
    const { selection: sel } = useEditorStore.getState();
    if (sel) setSelection({ anchor: sel.anchor, focus: index });
  };

  if (!items.length) {
    return <p className="text-subtle">No speech was found in this video.</p>;
  }

  return (
    <div className="select-none text-[17px] leading-[2.1] text-fg/90">
      {items.map((item, i) => (
        <Item
          key={item.id}
          item={item}
          index={i}
          removed={removed[i]}
          proposal={proposals.get(item.id) ?? null}
          selected={span ? i >= span.lo && i <= span.hi : false}
          onPointerDown={onPointerDown}
          onPointerEnter={onPointerEnter}
        />
      ))}
    </div>
  );
}

const Item = memo(function Item({ item, index, removed, proposal, selected, onPointerDown, onPointerEnter }) {
  const active = useEditorStore((s) => s.activeWordId === item.id);
  const ref = useRef(null);

  useEffect(() => {
    // Follow the playhead only while playing, so it doesn't fight the user's scrolling.
    const playing = player.element && !player.element.paused;
    if (active && playing) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);

  const base = 'cursor-pointer rounded-md px-[3px] py-[1px] transition-[background-color,color,box-shadow] duration-150';
  const state = [
    removed ? 'line-through decoration-accent decoration-2 text-subtle/70' : '',
    selected ? 'bg-accent-soft text-fg ring-1 ring-accent/40' : 'hover:bg-hover',
    active && !removed ? '!bg-highlight !text-highlight-fg shadow-[0_2px_12px_-2px_var(--c-highlight)]' : '',
    !removed && proposal === 'cut' ? 'underline decoration-wavy decoration-accent decoration-[1.5px] underline-offset-[5px]' : '',
    !removed && proposal === 'review' ? 'underline decoration-dotted decoration-highlight decoration-2 underline-offset-[5px]' : '',
  ].join(' ');

  const props = {
    ref,
    'data-index': index,
    'data-item-id': item.id,
    onPointerDown: (e) => onPointerDown(index, e),
    onPointerEnter: () => onPointerEnter(index),
  };

  if (item.kind === 'gap') {
    return (
      <span
        {...props}
        className={`${base} ${state} mx-0.5 inline-flex items-center gap-1 border border-dashed border-line-strong align-middle font-mono text-[11px] leading-5 text-subtle`}
      >
        <span className="inline-block h-1 w-1 rounded-full bg-current opacity-60" />
        {gapLabel(item)}
      </span>
    );
  }
  return (
    <span {...props} className={`${base} ${state}`}>
      {item.text}{' '}
    </span>
  );
});

/** Keyboard shortcuts for the transcript. Mounted once by the editor screen. */
export function useTranscriptShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea')) return;
      const s = useEditorStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteOrRestoreSelection();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
      } else if (e.key === 'Escape') {
        s.setSelection(null);
        s.selectOverlay(null);
      } else if (e.key === ' ') {
        e.preventDefault();
        player.togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Step the playhead word edge by word edge: never lands mid-word.
        e.preventDefault();
        stepBoundary(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}