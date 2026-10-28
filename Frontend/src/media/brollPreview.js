// Preview playback for B-roll: one hidden, muted element per media (a <video> or an
// <img>), kept in step with the main video's playhead so PreviewCanvas can draw it.
// B-roll is always muted (team decision); the main video carries the sound.

import { brollMediaTime } from '../lib/overlays.js';

const elements = new Map(); // mediaId -> HTMLVideoElement | HTMLImageElement

/** The element for a media entry, created on first use. */
export function mediaElement(media) {
  let el = elements.get(media.id);
  if (el) return el;
  if (media.kind === 'image') {
    el = new Image();
    el.src = media.url;
  } else {
    el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.src = media.url;
  }
  elements.set(media.id, el);
  return el;
}

/** True when the element has a frame ready to draw. */
export function isReady(el) {
  return el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el.readyState >= 2;
}

/**
 * Keep the active B-roll video at the right time; pause every other one.
 * While playing, small drift is tolerated (seeking every frame would stutter); while
 * paused or scrubbing, it's seeked precisely so the frame matches the playhead.
 */
export function syncBroll(active, media, T, playing) {
  for (const [id, el] of elements) {
    if (el instanceof HTMLVideoElement && (!active || id !== active.mediaId) && !el.paused) el.pause();
  }
  if (!active || !media || media.kind !== 'video') return;
  const el = mediaElement(media);
  const target = brollMediaTime(active, T, media.duration);
  const atEnd = target >= media.duration - 0.06; // hold the last frame
  if (playing && !atEnd) {
    if (el.paused) el.play().catch(() => {});
    if (Math.abs(el.currentTime - target) > 0.3 && !el.seeking) el.currentTime = target;
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - target) > 0.04 && !el.seeking) el.currentTime = target;
  }
}

/** Pause every B-roll element (e.g. when there's no B-roll on screen). */
export function pauseAllBroll() {
  for (const el of elements.values()) if (el instanceof HTMLVideoElement && !el.paused) el.pause();
}
