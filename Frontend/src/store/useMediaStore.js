// B-roll media library: the video and image files picked for overlays in this session.
// Kept apart from the editor store because Files and object URLs can't go into undo
// history: overlays (undoable) reference media here by id. Nothing is uploaded.

import { create } from 'zustand';
import { readVideoMetadata } from '../media/extractAudio.js';

export const BROLL_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
export const BROLL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const BROLL_ACCEPT = [...BROLL_VIDEO_TYPES, ...BROLL_IMAGE_TYPES, '.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.webp'].join(',');
export const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac'];
/** Music: any audio file, or a video whose soundtrack should be used. */
export const MUSIC_ACCEPT = [...AUDIO_TYPES, ...BROLL_VIDEO_TYPES, '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac', '.mp4', '.webm', '.mov'].join(',');

function kindOf(file) {
  const name = file.name.toLowerCase();
  if (AUDIO_TYPES.includes(file.type) || /\.(mp3|wav|m4a|aac|ogg|oga|flac)$/.test(name)) return 'audio';
  if (BROLL_VIDEO_TYPES.includes(file.type) || /\.(mp4|webm|mov)$/.test(name)) return 'video';
  if (BROLL_IMAGE_TYPES.includes(file.type) || /\.(jpe?g|png|webp)$/.test(name)) return 'image';
  return null;
}

function readAudioDuration(url) {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => resolve(a.duration);
    a.onerror = () => reject(new Error("This audio file couldn't be opened."));
    a.src = url;
  });
}

function readImageSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("This image couldn't be opened."));
    img.src = url;
  });
}

let nextId = 1;

export const useMediaStore = create((set, get) => ({
  media: {}, // id -> { id, name, kind: 'video' | 'image', url, file, width, height, duration }

  /**
   * Read a picked file's size / duration and add it. Returns the media entry.
   * `allow` limits the kinds accepted (B-roll: video + image; music: audio + video).
   */
  async addMedia(file, { allow = ['video', 'image'] } = {}) {
    const kind = kindOf(file);
    if (!kind || !allow.includes(kind)) {
      throw new Error(
        allow.includes('audio')
          ? `"${file.name}" isn't supported. Use an MP3, WAV, M4A, AAC or OGG file, or a video's sound.`
          : `"${file.name}" isn't supported. Use an MP4, WebM or MOV video, or a JPG, PNG or WebP image.`,
      );
    }
    const url = URL.createObjectURL(file);
    try {
      let info;
      if (kind === 'audio') {
        info = { width: 0, height: 0, duration: await readAudioDuration(url) };
      } else if (kind === 'video') {
        const m = await readVideoMetadata(url);
        info = { width: m.videoWidth, height: m.videoHeight, duration: m.duration };
      } else {
        info = { ...(await readImageSize(url)), duration: Infinity };
      }
      if (kind !== 'audio' && allow.includes('image') && (!info.width || !info.height)) throw new Error(`"${file.name}" has no picture.`);
      const entry = { id: `m${nextId++}`, name: file.name, kind, url, file, ...info };
      set({ media: { ...get().media, [entry.id]: entry } });
      return entry;
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  },
}));
