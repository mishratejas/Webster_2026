// Preview playback for background music: one hidden <audio>, kept at the right position
// for the main playhead (in OUTPUT time, so cuts are skipped in the music too), with its
// volume set every frame from the ducking curve (lib/ducking.js), the same curve the
// exporter mixes with.

import { musicGain, musicTime } from '../lib/ducking.js';

let el = null;
let elMediaId = null;

/**
 * @param {object} music     editor store `music` (or null)
 * @param {object|null} m   its media entry from useMediaStore
 * @param {HTMLVideoElement} main
 * @param {number} T         output time of the main playhead
 * @param {Array} intervals  speech intervals (output time)
 * @param {number} total     edited length (output)
 */
export function syncMusic(music, m, main, T, intervals, total) {
  if (!music || !m) {
    stopMusic();
    return;
  }
  if (elMediaId !== m.id) {
    stopMusic();
    el = document.createElement('audio');
    el.preload = 'auto';
    el.src = m.url;
    elMediaId = m.id;
  }
  const mt = musicTime(T, music, m.duration);
  el.muted = main.muted;
  if (mt === null) {
    if (!el.paused) el.pause();
    return;
  }
  el.volume = Math.min(1, musicGain(T, music, intervals, total) * (main.volume ?? 1));
  if (!main.paused) {
    if (el.paused) el.play().catch(() => {});
    if (Math.abs(el.currentTime - mt) > 0.25 && !el.seeking) el.currentTime = mt;
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - mt) > 0.05 && !el.seeking) el.currentTime = mt;
  }
}

export function stopMusic() {
  if (el && !el.paused) el.pause();
  if (!el) return;
  el.removeAttribute('src');
  el.load();
  el = null;
  elMediaId = null;
}
