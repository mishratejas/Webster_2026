// Starts an export in a fresh worker. Cancelling just terminates the worker.

/**
 * @returns {{ promise: Promise<{ blob: Blob, videoCodec, audioCodec, width, height }>, cancel: () => void }}
 */
export function runExport(file, edl, { onProgress, captions = null, frame = null, overlays = null } = {}) {
  const worker = new Worker(new URL('../workers/export.worker.js', import.meta.url), { type: 'module' });
  let rejectFn;

  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        onProgress?.(data.progress);
      } else if (data.type === 'done') {
        worker.terminate();
        const { buffer, ...info } = data;
        resolve({ blob: new Blob([buffer], { type: 'video/mp4' }), ...info });
      } else if (data.type === 'error') {
        worker.terminate();
        reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Export worker crashed'));
    };
    // Plain objects only: the EDL is copied, the File is shared without copying its bytes.
    worker.postMessage({ type: 'export', file, edl: edl.map((k) => ({ start: k.start, end: k.end })), captions, frame, overlays });
  });

  const cancel = () => {
    worker.terminate();
    const err = new Error('Export cancelled');
    err.cancelled = true;
    rejectFn?.(err);
  };

  return { promise, cancel };
}
