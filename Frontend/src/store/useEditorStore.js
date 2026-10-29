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

/**
 * Edit layers besides removedRanges. Each has `<layer>Past` / `<layer>Future` stacks that
 * move in step with past / future, so one undo step restores everything an edit changed.
 */
const LAYERS = ['splits', 'brolls', 'titles'];
const emptyLayers = () => Object.fromEntries(LAYERS.flatMap((k) => [[k, []], [`${k}Past`, []], [`${k}Future`, []]]));

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
  // Text overlays (lib/titles.js), same anchoring and history as B-roll.
  titles: [],
  titlesPast: [],
  titlesFuture: [],
  // The selected B-roll or title (ids are unique across both), or null.
  selectedOverlayId: null,

  // Background music with ducking (lib/ducking.js): null | { mediaId, volume, duck, duckDb,
  // loop, offset }. A setting like framing: per video, not part of undo or saved projects.
  music: null,

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
      ...emptyLayers(),
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
   * Replace removedRanges (and optionally other layers: { splits, brolls, titles }) and
   * record history. Every edit goes through here, so one undo step covers whatever the
   * edit changed.
   */
  commit: (next, layers = {}) => {
    const s = get();
    const patch = { removedRanges: next, past: [...s.past, s.removedRanges].slice(-HISTORY_LIMIT), future: [] };
    for (const k of LAYERS) {
      patch[k] = layers[k] ?? s[k];
      patch[`${k}Past`] = [...alignStack(s[`${k}Past`], s.past.length), s[k]].slice(-HISTORY_LIMIT);
      patch[`${k}Future`] = [];
    }
    get()._apply(patch);
    get()._dropStaleOverlaySelection();
  },

  /** Change the B-roll list as one undoable edit (cuts and other layers unchanged). */
  commitBrolls: (brolls) => get().commit(get().removedRanges, { brolls }),
  /** Change the title list as one undoable edit. */
  commitTitles: (titles) => get().commit(get().removedRanges, { titles }),

  /** Select a B-roll or title (clears the word selection). null deselects. */
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
    get().commit(removedRanges, { splits: [...splits, t].sort((a, b) => a - b) });
    set({ selection: null, selectionRange: null });
    return true;
  },

  undo: () => {
    const s = get();
    if (!s.past.length) return;
    const patch = { removedRanges: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.removedRanges, ...s.future] };
    for (const k of LAYERS) {
      const p = alignStack(s[`${k}Past`], s.past.length);
      patch[k] = p[p.length - 1];
      patch[`${k}Past`] = p.slice(0, -1);
      patch[`${k}Future`] = [s[k], ...alignStack(s[`${k}Future`], s.future.length)];
    }
    get()._apply(patch);
    get()._dropStaleOverlaySelection();
  },

  redo: () => {
    const s = get();
    if (!s.future.length) return;
    const patch = { removedRanges: s.future[0], past: [...s.past, s.removedRanges], future: s.future.slice(1) };
    for (const k of LAYERS) {
      const f = alignStack(s[`${k}Future`], s.future.length);
      patch[k] = f[0];
      patch[`${k}Past`] = [...alignStack(s[`${k}Past`], s.past.length), s[k]];
      patch[`${k}Future`] = f.slice(1);
    }
    get()._apply(patch);
    get()._dropStaleOverlaySelection();
  },

  _dropStaleOverlaySelection: () => {
    const { selectedOverlayId, brolls, titles } = get();
    if (selectedOverlayId && !brolls.some((b) => b.id === selectedOverlayId) && !titles.some((t) => t.id === selectedOverlayId)) {
      set({ selectedOverlayId: null });
    }
  },

  /** Put saved edits back (opening a saved project). Razor marks aren't saved, so they start empty. */
  loadEdits: ({ removedRanges, past = [], future = [] }) => {
    get()._apply({
      removedRanges,
      past,
      future,
      ...Object.fromEntries(LAYERS.flatMap((k) => [[k, []], [`${k}Past`, past.map(() => [])], [`${k}Future`, future.map(() => [])]])),
    });
  },

  // ---- media visuals ----
  setPeaks: (peaks) => set({ peaks }),
  setEnergy: (energy) => set({ energy }),
  setFillerReview: (fillerReview) => set({ fillerReview }),
  addThumbnail: (thumb) =>
    set({ thumbnails: [...get().thumbnails, thumb].sort((a, b) => a.t - b.t) }),

  // ---- music (not undoable, like framing) ----
  setMusic: (music) => set({ music }),
  updateMusic: (patch) => {
    const m = get().music;
    if (m) set({ music: { ...m, ...patch } });
  },

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
function alignStack(stack, length) {
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