import { useEditorStore, getSelectionSpan } from '../store/useEditorStore.js';
import { isSpanRemoved } from '../lib/edl.js';
import { rangeIsRemoved } from '../lib/timeline.js';

/** True when every selected item is already deleted (so the action is "restore"). */
export function selectionIsRemoved(state) {
  const span = getSelectionSpan(state);
  if (!span) return false;
  if (state.selectionRange) return rangeIsRemoved(span.range, state.removedRanges);
  for (let i = span.lo; i <= span.hi; i++) {
    if (!isSpanRemoved(state.items[i], state.removedRanges)) return false;
  }
  return true;
}

export function deleteOrRestoreSelection() {
  const s = useEditorStore.getState();
  // A selected B-roll or title takes priority: Delete removes the overlay, not the words under it.
  if (s.selectedOverlayId) {
    const id = s.selectedOverlayId;
    if (s.brolls.some((b) => b.id === id)) s.commitBrolls(s.brolls.filter((b) => b.id !== id));
    else if (s.titles.some((t) => t.id === id)) s.commitTitles(s.titles.filter((t) => t.id !== id));
    return;
  }
  const span = getSelectionSpan(s);
  if (!span) return;
  if (selectionIsRemoved(s)) s.restoreRange(span.range);
  else s.removeRange(span.range);
}