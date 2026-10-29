// Background music in the exporter (runs in the export worker): decode the part of the
// music file the edited video needs, then mix it under each block of main-video audio
// with the same ducking curve the preview uses (lib/ducking.js).
//
// The music runs on OUTPUT time, like B-roll: it plays straight through the cuts in the
// main video, and its volume dips wherever kept words are spoken.

import { Input, BlobSource, ALL_FORMATS, AudioSampleSink } from 'mediabunny';
import { musicGain, musicTime } from '../lib/ducking.js';

/** Decode [from, to) of an audio track into planar Float32 channels at its own rate. */
async function decodeRange(track, from, to) {
  const rate = track.sampleRate;
  const channels = Math.max(1, Math.min(2, track.numberOfChannels)); // stereo is plenty for music
  const length = Math.max(1, Math.ceil((to - from) * rate) + rate); // +1 s slack
  const out = Array.from({ length: channels }, () => new Float32Array(length));
  const sink = new AudioSampleSink(track);
  for await (const sample of sink.samples(from, to)) {
    try {
      const n = sample.numberOfFrames;
      const at = Math.round((sample.timestamp - from) * rate);
      const plane = new Float32Array(n);
      for (let c = 0; c < channels; c++) {
        sample.copyTo(plane, { planeIndex: Math.min(c, sample.numberOfChannels - 1), format: 'f32-planar' });
        const dst = out[c];
        for (let i = 0; i < n; i++) {
          const j = at + i;
          if (j >= 0 && j < length) dst[j] = plane[i];
        }
      }
    } finally {
      sample.close();
    }
  }
  return { rate, channels: out, start: from, length };
}

/**
 * @param {{ file: Blob, settings: object, duration: number, speech: Array, total: number }} music
 * @returns {Promise<{ mix(data, numberOfChannels, frames, sampleRate, T0): void } | null>}
 */
export async function createMusicMixer(music) {
  if (!music?.file || !music.settings) return null;
  const input = new Input({ source: new BlobSource(music.file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) return null;
  const { settings, speech, total } = music;
  const duration = music.duration > 0 ? music.duration : await input.computeDuration();
  const offset = settings.offset ?? 0;

  // Only decode what the edit will play: [offset, offset + total), or the whole file
  // when it has to loop back to the start.
  const wraps = settings.loop && offset + total > duration;
  const from = wraps ? 0 : Math.min(offset, duration);
  const to = Math.min(duration, offset + total);
  if (to <= from) return null;
  const pcm = await decodeRange(track, from, to);

  /** Music sample (linear interpolation) for channel c at music time mt. */
  const sampleAt = (c, mt) => {
    const ch = pcm.channels[Math.min(c, pcm.channels.length - 1)];
    const x = (mt - pcm.start) * pcm.rate;
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= pcm.length) return 0;
    const f = x - i;
    return ch[i] * (1 - f) + ch[i + 1] * f;
  };

  return {
    /**
     * Add the ducked music to `data` (planar f32, `frames` per channel) in place.
     * T0 = output time of the first frame.
     */
    mix(data, numberOfChannels, frames, sampleRate, T0) {
      const T1 = T0 + frames / sampleRate;
      // The ducking curve changes slowly: compute it at both ends and blend across the block.
      const g0 = musicGain(T0, settings, speech, total);
      const g1 = musicGain(T1, settings, speech, total);
      if (g0 <= 0 && g1 <= 0) return;
      for (let i = 0; i < frames; i++) {
        const T = T0 + i / sampleRate;
        const mt = musicTime(T, settings, duration);
        if (mt === null) continue;
        const g = g0 + (g1 - g0) * (i / frames);
        for (let c = 0; c < numberOfChannels; c++) {
          const k = c * frames + i;
          const v = data[k] + g * sampleAt(c, mt);
          data[k] = v > 1 ? 1 : v < -1 ? -1 : v;
        }
      }
    },
  };
}
