// The one store. Edit state is ONLY `removedRanges` (SRS §3.1); everything else the
// editor shows (deleted words, EDL, timeline clips) is derived from it with src/lib.
//
// Undo/redo keeps snapshots of removedRanges. They are tiny arrays, and snapshots
// can't drift the way replaying operations can. One stack covers every editing mode.

import { create } from 'zustand';
import { addRange, subtractRange } from '../lib/ranges.js';
import { deriveGaps, buildTranscriptItems, gapCutTimes, splitTarget } from '../lib/transcript.js';
import { itemsInRange } from '../lib/timeline.js';
import { FRAME_DEFAULTS, clampFrame } from '../lib/frame.js';

const HISTORY_LIMIT = 200;

/** Transcript items for the current edit state: gaps are divided at razor marks and cut edges. */
const deriveItems = (words, gaps, removedRanges, splits) =>
  buildTranscriptItems(words, gaps, gapCutTimes(splits, removedRanges));

const initialState = {
  // media
  file: null,
  videoUrl: null,
  duration: 0,
  videoWidth: 0,
  videoHeight: 0,

  // pipeline status: idle | loading | extracting | model | transcribing | ready | error
  status: 'idle',
  progress: 0, // 0..1 for the current stage
  statusText: '',
  error: null,
  device: null, // 'webgpu' | 'wasm'

  // transcript (fixed after transcription)
  words: [],
  gaps: [],
  items: [], // words + gap tokens in time order

  // edit state
  removedRanges: [],
  past: [],
  future: [],
  // Razor marks inside gaps (source seconds, sorted). They only divide a pause into
  // pieces you can select separately; they never change the output by themselves.
  // Undoable: splitsPast / splitsFuture run in step with past / future. Not saved with
  // projects (a mark that was used for a cut is already a cut edge in removedRanges).
  splits: [],
  splitsPast: [],
  splitsFuture: [],
  // B-roll overlays (lib/overlays.js), anchored to words. Undoable: brollsPast /
  // brollsFuture run in step with past / future. Not saved with cloud projects yet
  // (their media files only exist in this browser).
  brolls: [],
  brollsPast: [],
  brollsFuture: [],
  selectedOverlayId: null,

  // timeline visuals (derived from the media, not edit state)
  peaks: null, // Float32Array, 0..1 loudness per 10 ms
  thumbnails: [], // [{ t, url }] sorted by t
  energy: null, // Float32Array, RMS per 10 ms (acoustic evidence for filler detection)

  // filler review (UI state, not edit state: nothing changes until Apply commits cuts)
  // null | { phase: 'analyzing' | 'review' | 'applied' | 'error', candidates, selected, audioUsed, applied, error }
  fillerReview: null,

  // output framing (aspect ratio, crop / fit). Per video, not part of undo or saved projects.
  frame: FRAME_DEFAULTS,

  // ui
  selection: null, // { anchor, focus } indices into items
  selectionRange: null, // { start, end } exact time range from a timeline drag (overrides item bounds)
  activeWordId: null,
};

export const useEditorStore = create((set, get) => ({
  ...initialState,

  // ---- pipeline ----
  setStatus: (status, statusText = '', progress = 0) => set({ status, statusText, progress, error: null }),
  setProgress: (progress, statusText) => set(statusText ? { progress, statusText } : { progress }),
  setError: (error) => set({ status: 'error', error }),
  setDevice: (device) => set({ device }),

  loadMedia: ({ file, videoUrl, duration, videoWidth, videoHeight }) => {
    const old = get().videoUrl;
    if (old) URL.revokeObjectURL(old);
    set({ ...initialState, file, videoUrl, duration, videoWidth, videoHeight, status: 'loading' });
  },

  setTranscript: (words) => {
    const sorted = [...words].sort((a, b) => a.start - b.start);
    const gaps = deriveGaps(sorted, get().duration);
    set({
      words: sorted,
      gaps,
      items: buildTranscriptItems(sorted, gaps),
      removedRanges: [],
      past: [],
      future: [],
      splits: [],
      splitsPast: [],
      splitsFuture: [],
      brolls: [],
      brollsPast: [],
      brollsFuture: [],
      selectedOverlayId: null,
      selection: null,
      fillerReview: null,
      status: 'ready',
      progress: 1,
      statusText: '',
    });
  },

  reset: () => {
    const old = get().videoUrl;
    if (old) URL.revokeObjectURL(old);
    set(initialState);
  },

  // ---- editing ----
  /** Apply a new edit state: re-derive the transcript items and keep the selection on the same times. */
  _apply: (patch) => {
    const s = get();
    const removedRanges = patch.removedRanges ?? s.removedRanges;
    const splits = patch.splits ?? s.splits;
    const items = deriveItems(s.words, s.gaps, removedRanges, splits);
    set({ ...patch, items, ...remapSelection(s, items) });
  },

  /**
   * Replace removedRanges (and optionally splits / B-roll) and record history. Every
   * edit goes through here, so one undo step covers whatever the edit changed.
   */
  commit: (next, nextSplits, nextBrolls) => {
    const { removedRanges, past, splits, splitsPast, brolls, brollsPast } = get();
    get()._apply({
      removedRanges: next,
      splits: nextSplits ?? splits,
      brolls: nextBrolls ?? brolls,
      past: [...past, removedRanges].slice(-HISTORY_LIMIT),
      splitsPast: [...alignSplits(splitsPast, past.length), splits].slice(-HISTORY_LIMIT),
      brollsPast: [...alignSplits(brollsPast, past.length), brolls].slice(-HISTORY_LIMIT),
      future: [],
      splitsFuture: [],
      brollsFuture: [],
    });
  },

  /** Change the B-roll list as one undoable edit (cuts and splits unchanged). */
  commitBrolls: (nextBrolls) => {
    const s = get();
    s.commit(s.removedRanges, s.splits, nextBrolls);
    if (s.selectedOverlayId && !nextBrolls.some((b) => b.id === s.selectedOverlayId)) set({ selectedOverlayId: null });
  },

  /** Select a B-roll (clears the word selection). null deselects. */
  selectOverlay: (id) => set({ selectedOverlayId: id, ...(id ? { selection: null, selectionRange: null } : {}) }),

  removeRange: (range) => get().commit(addRange(get().removedRanges, range)),
  restoreRange: (range) => get().commit(subtractRange(get().removedRanges, range)),

  /**
   * Razor: divide the pause under t into two pieces. Only works inside a gap (words can't
   * be split). Returns true when a split was made. Undoable like any edit.
   */
  addSplit: (t) => {
    const { gaps, removedRanges, splits } = get();
    if (!splitTarget(t, gaps, gapCutTimes(splits, removedRanges))) return false;
    get().commit(removedRanges, [...splits, t].sort((a, b) => a - b));
    set({ selection: null, selectionRange: null });
    return true;
  },

  undo: () => {
    const s = get();
    if (!s.past.length) return;
    const sp = alignSplits(s.splitsPast, s.past.length);
    const bp = alignSplits(s.brollsPast, s.past.length);
    get()._apply({
      removedRanges: s.past[s.past.length - 1],
      splits: sp[sp.length - 1],
      brolls: bp[bp.length - 1],
      past: s.past.slice(0, -1),
      splitsPast: sp.slice(0, -1),
      brollsPast: bp.slice(0, -1),
      future: [s.removedRanges, ...s.future],
      splitsFuture: [s.splits, ...alignSplits(s.splitsFuture, s.future.length)],
      brollsFuture: [s.brolls, ...alignSplits(s.brollsFuture, s.future.length)],
    });
    get()._dropStaleOverlaySelection();
  },

  redo: () => {
    const s = get();
    if (!s.future.length) return;
    const sf = alignSplits(s.splitsFuture, s.future.length);
    const bf = alignSplits(s.brollsFuture, s.future.length);
    get()._apply({
      removedRanges: s.future[0],
      splits: sf[0],
      brolls: bf[0],
      past: [...s.past, s.removedRanges],
      splitsPast: [...alignSplits(s.splitsPast, s.past.length), s.splits],
      brollsPast: [...alignSplits(s.brollsPast, s.past.length), s.brolls],
      future: s.future.slice(1),
      splitsFuture: sf.slice(1),
      brollsFuture: bf.slice(1),
    });
    get()._dropStaleOverlaySelection();
  },

  _dropStaleOverlaySelection: () => {
    const { selectedOverlayId, brolls } = get();
    if (selectedOverlayId && !brolls.some((b) => b.id === selectedOverlayId)) set({ selectedOverlayId: null });
  },

  /** Put saved edits back (opening a saved project). Razor marks aren't saved, so they start empty. */
  loadEdits: ({ removedRanges, past = [], future = [] }) => {
    get()._apply({
      removedRanges,
      past,
      future,
      splits: [],
      splitsPast: past.map(() => []),
      splitsFuture: future.map(() => []),
      brolls: [],
      brollsPast: past.map(() => []),
      brollsFuture: future.map(() => []),
    });
  },

  // ---- media visuals ----
  setPeaks: (peaks) => set({ peaks }),
  setEnergy: (energy) => set({ energy }),
  setFillerReview: (fillerReview) => set({ fillerReview }),
  addThumbnail: (thumb) =>
    set({ thumbnails: [...get().thumbnails, thumb].sort((a, b) => a.t - b.t) }),

  // ---- framing ----
  setFrame: (patch) => {
    const { frame, videoWidth, videoHeight } = get();
    set({ frame: clampFrame({ ...frame, ...patch }, videoWidth, videoHeight) });
  },

  // ---- ui ----
  setSelection: (selection) => set({ selection, selectionRange: null, ...(selection ? { selectedOverlayId: null } : {}) }),
  /** Select an exact (already snapped) time range from the timeline. */
  setRangeSelection: (range) => {
    if (!range || range.end - range.start < 1e-3) {
      set({ selection: null, selectionRange: null });
      return;
    }
    const hit = itemsInRange(get().items, range);
    set({ selectionRange: range, selection: hit ? { anchor: hit.lo, focus: hit.hi } : null, selectedOverlayId: null });
  },
  setActiveWordId: (id) => {
    if (get().activeWordId !== id) set({ activeWordId: id });
  },
}));

/**
 * Keep splitsPast / brollsPast (and the futures) the same length as past / future. They
 * can only drift if something sets past/future directly; missing entries mean "none".
 */
function alignSplits(stack, length) {
  if (stack.length === length) return stack;
  if (stack.length > length) return stack.slice(stack.length - length);
  return [...Array(length - stack.length).fill([]), ...stack];
}

/** After an edit the items can change (gaps split); keep the selection on the same time range. */
function remapSelection(state, items) {
  const span = getSelectionSpan(state);
  if (!span) return { selection: null, selectionRange: null };
  const hit = itemsInRange(items, span.range);
  return {
    selection: hit ? { anchor: hit.lo, focus: hit.hi } : null,
    selectionRange: state.selectionRange ?? null,
  };
}

/** Selected items as { lo, hi, range } or null. */
export function getSelectionSpan(state) {
  const { selection, selectionRange, items } = state;
  if (selectionRange) {
    const lo = selection ? Math.min(selection.anchor, selection.focus) : null;
    const hi = selection ? Math.max(selection.anchor, selection.focus) : null;
    return { lo, hi, range: selectionRange };
  }
  if (!selection || !items.length) return null;
  const lo = Math.min(selection.anchor, selection.focus);
  const hi = Math.max(selection.anchor, selection.focus);
  return { lo, hi, range: { start: items[lo].start, end: items[hi].end } };
}