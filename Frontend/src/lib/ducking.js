// Background music with automatic ducking: the music drops while words are spoken and
// comes back up in the pauses. "Speech" comes straight from the transcript: the kept
// words, mapped to OUTPUT time, so cutting a sentence also removes its dip.
//
// Pure functions, used by the preview (to set the <audio> volume every frame) and by the
// exporter (to mix the music under the main soundtrack sample by sample).

import { buildEDL, isSpanRemoved, sourceToOutput } from './edl.js';

export const MUSIC_DEFAULTS = { volume: 0.35, duck: true, duckDb: -14, loop: true, offset: 0 };
export const DUCK_ATTACK_S = 0.15; // ramp down before a word starts
export const DUCK_RELEASE_S = 0.4; // ramp back up after speech ends
export const MUSIC_FADE_IN_S = 0.5;
export const MUSIC_FADE_OUT_S = 1.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const dbToGain = (db) => 10 ** (db / 20);

/**
 * Output-time intervals where someone is speaking: one per kept word (padded a little),
 * merged when the gap between them is short, so the music doesn't pump between words.
 */
export function speechIntervals(words, removedRanges, duration, { mergeGap = 0.35, pad = 0.05 } = {}) {
  const edl = buildEDL(removedRanges, duration);
  const out = [];
  for (const w of words) {
    if (isSpanRemoved(w, removedRanges)) continue;
    const s = Math.max(0, sourceToOutput(w.start, edl) - pad);
    const e = sourceToOutput(w.end, edl) + pad;
    if (e <= s) continue;
    const last = out[out.length - 1];
    if (last && s - last.end <= mergeGap) last.end = Math.max(last.end, e);
    else out.push({ start: s, end: e });
  }
  return out;
}

/** Ducking multiplier at output time T: 1 = full music, dbToGain(duckDb) = fully ducked. */
export function duckFactor(T, intervals, duckDb = MUSIC_DEFAULTS.duckDb, attack = DUCK_ATTACK_S, release = DUCK_RELEASE_S) {
  if (!intervals.length) return 1;
  const d = dbToGain(duckDb);
  // First interval whose release tail reaches T (binary search on end).
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid].end + release < T) lo = mid + 1;
    else hi = mid;
  }
  let f = 1;
  for (let i = Math.max(0, lo - 1); i <= Math.min(intervals.length - 1, lo + 1); i++) {
    const { start, end } = intervals[i];
    let g = 1;
    if (T >= start && T <= end) g = d;
    else if (T < start && T >= start - attack) g = 1 + (d - 1) * ((T - (start - attack)) / attack);
    else if (T > end && T <= end + release) g = d + (1 - d) * ((T - end) / release);
    f = Math.min(f, g);
  }
  return f;
}

/** Music volume (0..1) at output time T: volume × ducking × fade in at the start / out at the end. */
export function musicGain(T, music, intervals, totalOut) {
  if (!music) return 0;
  const duck = music.duck ? duckFactor(T, intervals, music.duckDb) : 1;
  const fadeIn = clamp(T / MUSIC_FADE_IN_S, 0, 1);
  const fadeOut = Number.isFinite(totalOut) ? clamp((totalOut - T) / MUSIC_FADE_OUT_S, 0, 1) : 1;
  return clamp((music.volume ?? MUSIC_DEFAULTS.volume) * duck * fadeIn * fadeOut, 0, 1);
}

/** Position in the music file at output time T, or null once a non-looping track has ended. */
export function musicTime(T, music, musicDuration) {
  const t = (music?.offset ?? 0) + T;
  if (!(musicDuration > 0)) return t;
  if (t < musicDuration) return t;
  return music?.loop ? t % musicDuration : null;
}
