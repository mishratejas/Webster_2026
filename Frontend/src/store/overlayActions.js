// B-roll actions: add over the selected words, edit, remove. Every change is one
// undoable edit through the editor store's commitBrolls().

import { useEditorStore, getSelectionSpan } from './useEditorStore.js';
import { useMediaStore, BROLL_ACCEPT } from './useMediaStore.js';
import { useProjectStore } from '../account/useProjectStore.js';
import { anchorForRange, anchorRange, withoutOverlapping, BROLL_DEFAULTS } from '../lib/overlays.js';

const ed = () => useEditorStore.getState();
const toast = (text, kind = 'info') => useProjectStore.getState().showToast?.(text, kind);
let nextId = 1;

/** Open a file picker for a B-roll video or image. Resolves to the File, or null if cancelled. */
export function pickBrollFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = BROLL_ACCEPT;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** True when there's a selection to put B-roll over. */
export const canAddBroll = (state) => state.status === 'ready' && Boolean(getSelectionSpan(state));

/**
 * Add B-roll over the current selection (words in the transcript, chips or a range on the
 * timeline). Picks a file, anchors to the selected words, replaces any B-roll it overlaps.
 */
export async function addBrollOverSelection(file = null) {
  const s = ed();
  const span = getSelectionSpan(s);
  if (!span) {
    toast('Select the words the B-roll should cover first.', 'warn');
    return;
  }
  const range = { ...span.range };
  const picked = file ?? (await pickBrollFile());
  if (!picked) return;

  let media;
  try {
    media = await useMediaStore.getState().addMedia(picked);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const now = ed();
  const anchor = anchorForRange(range, now.words);
  const r = anchorRange(anchor, new Map(now.words.map((w) => [w.id, w])));
  if (!r) return;
  const replaced = withoutOverlapping(now.brolls, r, now.words);
  const item = { id: `b${nextId++}`, mediaId: media.id, ...BROLL_DEFAULTS, pip: { ...BROLL_DEFAULTS.pip }, anchor };
  now.commitBrolls([...replaced, item]);
  ed().selectOverlay(item.id);
  if (replaced.length < now.brolls.length) toast('Replaced the B-roll that was there (one B-roll at a time).');
}

/** Change one B-roll as an undoable edit. */
export function updateBroll(id, patch) {
  const s = ed();
  s.commitBrolls(s.brolls.map((b) => (b.id === id ? { ...b, ...patch, pip: { ...b.pip, ...(patch.pip ?? {}) } } : b)));
}

export function removeBroll(id) {
  const s = ed();
  s.commitBrolls(s.brolls.filter((b) => b.id !== id));
}

/** Swap the media of a B-roll (keeps its words, mode and position). */
export async function replaceBrollMedia(id) {
  const file = await pickBrollFile();
  if (!file) return;
  try {
    const media = await useMediaStore.getState().addMedia(file);
    updateBroll(id, { mediaId: media.id, offset: 0 });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- sliders: live while dragging, one undo step on release ----
let dragBefore = null;

export function beginBrollDrag() {
  if (!dragBefore) dragBefore = ed().brolls; // already dragging: keep the original "before"
}

/** Live change without history (used while a slider moves). */
export function setBrollLive(id, patch) {
  if (!dragBefore) beginBrollDrag();
  useEditorStore.setState({
    brolls: ed().brolls.map((b) => (b.id === id ? { ...b, ...patch, pip: { ...b.pip, ...(patch.pip ?? {}) } } : b)),
  });
}

/** Turn the live changes since beginBrollDrag() into a single undoable edit. */
export function endBrollDrag() {
  if (!dragBefore) return;
  const after = ed().brolls;
  const before = dragBefore;
  dragBefore = null;
  if (after === before) return;
  useEditorStore.setState({ brolls: before });
  ed().commitBrolls(after);
}
