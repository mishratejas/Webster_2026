 // Read a video file's metadata and pull its audio out as 16 kHz mono (FR-1).
//
// Phase 1 approach: let the browser decode the whole file with decodeAudioData.
// An OfflineAudioContext at 16 kHz resamples for us. This holds the file in memory,
// which is fine for a few hundred MB. A later upgrade is to demux and decode the audio
// track in a stream with mediabunny + WebCodecs AudioDecoder (shared with the exporter).

import { ACCEPTED_EXTENSIONS, ACCEPTED_TYPES, WHISPER_SAMPLE_RATE } from '../lib/config.js';

export function validateFile(file) {
  const name = file.name.toLowerCase();
  const okExt = ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
  const okType = !file.type || ACCEPTED_TYPES.includes(file.type);
  if (!okExt || !okType) {
    return `"${file.name}" isn't supported. Please use an MP4, WebM or MOV video.`;
  }
  return null;
}

/** Load the file into a <video> element just to read duration and size. */
export function readVideoMetadata(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      resolve({ duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
      video.removeAttribute('src');
      video.load();
    };
    video.onerror = () =>
      reject(new Error("This browser can't play this video. Try an H.264 MP4 or a WebM file."));
    video.src = url;
  });
}

/** Returns a Float32Array of mono samples at 16 kHz. */
export async function extractAudio(file) {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE);
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error("Couldn't read an audio track from this video. Does it have sound?");
  }

  const { numberOfChannels, length } = buffer;
  if (numberOfChannels === 1) return buffer.getChannelData(0).slice();

  // Downmix to mono by averaging the channels.
  const mono = new Float32Array(length);
  for (let c = 0; c < numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / numberOfChannels;
  }
  return mono;
}
