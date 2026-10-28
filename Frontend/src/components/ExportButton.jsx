import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorStore } from '../store/useEditorStore.js';
import { buildEDL } from '../lib/edl.js';
import { runExport } from '../media/runExport.js';
import { useSubtitleStore } from '../store/useSubtitleStore.js';
import { useCaptionPages } from '../store/useCaptionPages.js';
import { useMediaStore } from '../store/useMediaStore.js';
import { resolveBrolls } from '../lib/overlays.js';

import * as I from './icons.jsx';

const btn =
  'inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold transition-all duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40';
const primary = 'bg-gradient-to-b from-scarlet-400 to-scarlet-600 text-white shadow-[0_8px_24px_-8px_var(--glow)] hover:brightness-110';
const secondary = 'border border-line bg-raised text-fg hover:bg-hover';

function formatBytes(n) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
}

function outputName(file) {
  const base = file?.name?.replace(/\.[^.]+$/, '') || 'video';
  return `${base}-edited.mp4`;
}

/** "Export MP4" button plus the progress / result dialog. */
export default function ExportButton() {
  const file = useEditorStore((s) => s.file);
  const status = useEditorStore((s) => s.status);
  const duration = useEditorStore((s) => s.duration);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const captionPages = useCaptionPages();

  // state: null | { phase: 'running', progress } | { phase: 'done', url, size, seconds, outLength, info } | { phase: 'error', message }
  const [job, setJob] = useState(null);
  const cancelRef = useRef(null);

  const edl = buildEDL(removedRanges, duration);
  const disabled = status !== 'ready' || !file || edl.length === 0 || job?.phase === 'running';

  // Free the download URL when the dialog closes or the component unmounts.
  useEffect(() => () => job?.url && URL.revokeObjectURL(job.url), [job]);

  const start = async () => {
    const outLength = edl.reduce((s, k) => s + (k.end - k.start), 0);
    const t0 = performance.now();
    setJob({ phase: 'running', progress: 0 });

    // Subtitles on in the preview -> burned into the export with the same style and layout.
    const sub = useSubtitleStore.getState();
    const captions = sub.enabled
      ? { pages: captionPages, styleId: sub.styleId, settings: { x: sub.x, y: sub.y, scale: sub.scale } }
      : null;

    // B-roll: resolved to output times here; the worker gets the media files (not copied).
    const ed = useEditorStore.getState();
    const items = resolveBrolls(ed.brolls, ed.words, ed.removedRanges, ed.duration);
    const library = useMediaStore.getState().media;
    const media = {};
    for (const it of items) {
      const m = library[it.mediaId];
      if (m) media[m.id] = { kind: m.kind, file: m.file, duration: Number.isFinite(m.duration) ? m.duration : null };
    }
    const overlays = items.length ? { items, media } : null;

    const { promise, cancel } = runExport(file, edl, {
      overlays,
      captions,
      frame: useEditorStore.getState().frame, // aspect ratio / crop / fit, as in the preview
      onProgress: (progress) => setJob({ phase: 'running', progress }),
    });
    cancelRef.current = cancel;

    try {
      const { blob, ...info } = await promise;
      const url = URL.createObjectURL(blob);
      setJob({ phase: 'done', url, size: blob.size, seconds: (performance.now() - t0) / 1000, outLength, info });
      download(url, outputName(file));
    } catch (err) {
      setJob(err.cancelled ? null : { phase: 'error', message: err.message });
    } finally {
      cancelRef.current = null;
    }
  };

  return (
    <>
      <button
        className={`${btn} ${primary}`}
        disabled={disabled}
        onClick={start}
        title={edl.length === 0 ? 'Everything is cut' : 'Render the edited video in your browser'}
      >
        <I.Download /> Export
      </button>

      {/* Portal to <body>: the header uses backdrop-filter, which would otherwise make this
          "fixed" overlay position itself relative to the header instead of the window. */}
      {job && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="panel fade-up w-full max-w-md p-6">
            {job.phase === 'running' && (
              <>
                <h2 className="text-lg font-semibold">Exporting…</h2>
                <p className="mt-1 text-sm text-muted">Rendering in your browser. Nothing is uploaded.</p>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-sunken">
                  <div className="shimmer h-full rounded-full transition-[width]" style={{ width: `${job.progress * 100}%` }} />
                </div>
                <div className="mt-2 text-right text-sm tabular-nums text-muted">
                  {Math.round(job.progress * 100)}%
                </div>
                <button className={`${btn} mt-4 ${secondary}`} onClick={() => cancelRef.current?.()}>
                  Cancel
                </button>
              </>
            )}

            {job.phase === 'done' && (
              <>
                <h2 className="text-lg font-semibold">Export finished</h2>
                <ul className="mt-3 space-y-1 text-sm text-muted">
                  <li>
                    {formatBytes(job.size)} · {job.info.width}×{job.info.height} · {job.info.videoCodec}
                    {job.info.audioCodec ? ` + ${job.info.audioCodec}` : ' (no audio)'}
                  </li>
                  {job.info.subtitles && <li>Subtitles burned in</li>}
                  {job.info.brolls > 0 && <li>{job.info.brolls} B-roll {job.info.brolls === 1 ? 'clip' : 'clips'}</li>}
                  <li>
                    Rendered in {job.seconds.toFixed(1)} s ({(job.outLength / job.seconds).toFixed(1)}× real time)
                  </li>
                </ul>
                <video src={job.url} controls className="mt-4 w-full rounded-lg bg-black" />
                <div className="mt-4 flex gap-2">
                  <button
                    className={`${btn} ${primary}`}
                    onClick={() => download(job.url, outputName(file))}
                  >
                    Download again
                  </button>
                  <button className={`${btn} ${secondary}`} onClick={() => setJob(null)}>
                    Close
                  </button>
                </div>
              </>
            )}

            {job.phase === 'error' && (
              <>
                <h2 className="text-lg font-semibold text-red-500">Export failed</h2>
                <p className="mt-2 text-sm text-muted">{job.message}</p>
                <button className={`${btn} mt-4 ${secondary}`} onClick={() => setJob(null)}>
                  Close
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}