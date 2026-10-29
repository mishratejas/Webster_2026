// Background music: pick, change settings, remove. A setting like framing (per video, not
// part of undo or saved projects); the file stays in this browser.

import { useEditorStore } from './useEditorStore.js';
import { useMediaStore, MUSIC_ACCEPT } from './useMediaStore.js';
import { useProjectStore } from '../account/useProjectStore.js';
import { MUSIC_DEFAULTS } from '../lib/ducking.js';

const toast = (text, kind = 'info') => useProjectStore.getState().showToast?.(text, kind);

function pickMusicFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = MUSIC_ACCEPT;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Pick a music file (or a video's sound) and use it, keeping the current settings if any. */
export async function chooseMusic() {
  const file = await pickMusicFile();
  if (!file) return;
  try {
    const media = await useMediaStore.getState().addMedia(file, { allow: ['audio', 'video'] });
    if (!(media.duration > 0) || !Number.isFinite(media.duration)) throw new Error(`"${file.name}" has no usable sound.`);
    const prev = useEditorStore.getState().music;
    useEditorStore.getState().setMusic({ ...MUSIC_DEFAULTS, ...(prev ?? {}), mediaId: media.id, offset: 0 });
  } catch (err) {
    toast(err.message, 'error');
  }
}

export const removeMusic = () => useEditorStore.getState().setMusic(null);
export const updateMusic = (patch) => useEditorStore.getState().updateMusic(patch);
