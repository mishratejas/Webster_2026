// Text overlays (titles): add over the selected words, edit, remove. Same model as B-roll
// (anchored to words, one layer, undoable through commitTitles()).

import { useEditorStore, getSelectionSpan } from './useEditorStore.js';
import { useProjectStore } from '../account/useProjectStore.js';
import { anchorForRange, anchorRange, withoutOverlapping } from '../lib/overlays.js';
import { TITLE_DEFAULTS } from '../lib/titles.js';

const ed = () => useEditorStore.getState();
const toast = (text, kind = 'info') => useProjectStore.getState().showToast?.(text, kind);
let nextId = 1;

export const canAddTitle = (state) => state.status === 'ready' && Boolean(getSelectionSpan(state));

/** Add a title over the current selection. Its text starts as the selected words. */
export function addTitleOverSelection() {
  const s = ed();
  const span = getSelectionSpan(s);
  if (!span) {
    toast('Select the words the title should appear over first.', 'warn');
    return;
  }
  const anchor = anchorForRange(span.range, s.words);
  const r = anchorRange(anchor, new Map(s.words.map((w) => [w.id, w])));
  if (!r) return;
  const spoken = s.words
    .filter((w) => w.end > r.start + 1e-6 && w.start < r.end - 1e-6)
    .map((w) => w.text)
    .join(' ')
    .replace(/[.,!?;:]+$/, '');
  const text = spoken.length > 0 && spoken.length <= 60 ? spoken : 'Your title';
  const kept = withoutOverlapping(s.titles, r, s.words);
  const item = { id: `t${nextId++}`, anchor, text, ...TITLE_DEFAULTS };
  s.commitTitles([...kept, item]);
  ed().selectOverlay(item.id);
  if (kept.length < s.titles.length) toast('Replaced the title that was there (one title at a time).');
}

/** Change one title as an undoable edit. */
export function updateTitle(id, patch) {
  const s = ed();
  s.commitTitles(s.titles.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

export function removeTitle(id) {
  const s = ed();
  s.commitTitles(s.titles.filter((t) => t.id !== id));
}

// ---- typing and sliders: live while editing, one undo step when done ----
let before = null;

export function beginTitleEdit() {
  if (!before) before = ed().titles;
}

export function setTitleLive(id, patch) {
  beginTitleEdit();
  useEditorStore.setState({ titles: ed().titles.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

export function endTitleEdit() {
  if (!before) return;
  const after = ed().titles;
  const prev = before;
  before = null;
  if (after === prev) return;
  useEditorStore.setState({ titles: prev });
  ed().commitTitles(after);
}
