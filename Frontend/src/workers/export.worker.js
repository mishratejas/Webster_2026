// Runs the exporter off the main thread so the UI stays responsive.
//
// In:  { type: 'export', file, edl }
// Out: { type: 'progress', progress }  |  { type: 'done', buffer, videoCodec, audioCodec, width, height }
//      { type: 'error', message }

import { exportVideo } from '../media/exporter.js';

self.onmessage = async ({ data }) => {
  if (data.type !== 'export') return;
  let last = -1;
  try {
    const result = await exportVideo({
      file: data.file,
      edl: data.edl,
      captions: data.captions ?? null,
      frame: data.frame ?? null,
      overlays: data.overlays ?? null,
      music: data.music ?? null,
      onProgress: (p) => {
        // Throttle: only post when progress moves by 0.5% or more.
        if (p - last >= 0.005 || p === 1) {
          last = p;
          self.postMessage({ type: 'progress', progress: p });
        }
      },
    });
    self.postMessage({ type: 'done', ...result }, [result.buffer]);
  } catch (err) {
    console.error('[export]', err);
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
