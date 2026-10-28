import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { drawFramed, previewStage } from '../lib/frame.js';
import { buildEDL, sourceToOutput } from '../lib/edl.js';
import { resolveBrolls, brollAt, drawBroll } from '../lib/overlays.js';
import { useMediaStore } from '../store/useMediaStore.js';
import { mediaElement, isReady, syncBroll, pauseAllBroll } from '../media/brollPreview.js';

/** Resolved B-roll + EDL, recomputed only when their inputs change (not every frame). */
function makeBrollCache() {
  let key = null;
  let value = null;
  return (s) => {
    if (!key || key[0] !== s.brolls || key[1] !== s.words || key[2] !== s.removedRanges || key[3] !== s.duration) {
      key = [s.brolls, s.words, s.removedRanges, s.duration];
      value = { edl: buildEDL(s.removedRanges, s.duration), resolved: resolveBrolls(s.brolls, s.words, s.removedRanges, s.duration) };
    }
    return value;
  };
}

/**
 * The picture you see in the preview: the <video> drawn every frame through the same
 * drawFramed() the exporter uses, inside the output's aspect ratio (crop or fit), then
 * the B-roll on screen (drawBroll(), also shared with the exporter).
 * The <video> underneath keeps playing the sound and decoding frames; this canvas
 * covers it completely.
 */
export default function PreviewCanvas({ videoRef, onClick }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let raf = 0;
    const brollCache = makeBrollCache();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cv = canvasRef.current;
      const v = videoRef.current;
      if (!cv || !v) return;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);

      const vw = v.videoWidth;
      const vh = v.videoHeight;
      if (!vw || !vh || v.readyState < 2) return; // no frame decoded yet
      const s = useEditorStore.getState();
      const { frame } = s;
      const stage = previewStage(w, h, vw, vh, frame);
      ctx.save();
      ctx.translate(stage.x, stage.y);
      ctx.beginPath();
      ctx.rect(0, 0, stage.w, stage.h);
      ctx.clip();
      drawFramed(ctx, v, vw, vh, frame, stage.w, stage.h);

      // B-roll on top of the main picture (subtitles are drawn above this by SubtitleCanvas).
      if (s.brolls.length) {
        const { edl, resolved } = brollCache(s);
        const T = sourceToOutput(v.currentTime, edl);
        const active = brollAt(resolved, T);
        const media = active ? useMediaStore.getState().media[active.mediaId] : null;
        syncBroll(active, media, T, !v.paused);
        if (media) {
          const el = mediaElement(media);
          if (isReady(el)) drawBroll(ctx, el, media.width, media.height, active, stage.w, stage.h, T, media.kind);
        }
      } else {
        pauseAllBroll();
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  return <canvas ref={canvasRef} onClick={onClick} className="absolute inset-0 h-full w-full cursor-pointer" />;
}
