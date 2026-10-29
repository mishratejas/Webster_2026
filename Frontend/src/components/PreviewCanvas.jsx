import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { drawFramed, previewStage } from '../lib/frame.js';
import { buildEDL, editedDuration, sourceToOutput } from '../lib/edl.js';
import { resolveBrolls, brollAt, drawBroll } from '../lib/overlays.js';
import { drawTitle } from '../lib/titles.js';
import { speechIntervals } from '../lib/ducking.js';
import { useMediaStore } from '../store/useMediaStore.js';
import { mediaElement, isReady, syncBroll, pauseAllBroll } from '../media/brollPreview.js';
import { syncMusic, stopMusic } from '../media/musicPreview.js';

/**
 * Everything the overlays need that only changes when the edit changes: the EDL, resolved
 * B-roll and titles (anchored words -> output times), speech intervals for ducking.
 * Recomputed only when its inputs change, not every frame.
 */
function makeEditCache() {
  let key = null;
  let value = null;
  return (s) => {
    const k = [s.brolls, s.titles, s.words, s.removedRanges, s.duration];
    if (!key || k.some((x, i) => x !== key[i])) {
      key = k;
      value = {
        edl: buildEDL(s.removedRanges, s.duration),
        total: editedDuration(s.removedRanges, s.duration),
        brolls: resolveBrolls(s.brolls, s.words, s.removedRanges, s.duration),
        titles: resolveBrolls(s.titles, s.words, s.removedRanges, s.duration), // same anchoring model
        speech: speechIntervals(s.words, s.removedRanges, s.duration),
      };
    }
    return value;
  };
}

/**
 * The picture you see in the preview: the <video> drawn every frame through the same
 * drawFramed() the exporter uses, inside the output's aspect ratio (crop or fit), then
 * the B-roll and title on screen (drawBroll() / drawTitle(), also shared with the exporter).
 * It also keeps the background music in step and sets its ducked volume every frame.
 * The <video> underneath keeps playing the sound and decoding frames; this canvas
 * covers it completely.
 */
export default function PreviewCanvas({ videoRef, onClick }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let raf = 0;
    const editCache = makeEditCache();
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

      // Layers on top of the main picture: B-roll, then the title. (Subtitles are drawn
      // above all of this by SubtitleCanvas.)
      const c = editCache(s);
      const T = sourceToOutput(v.currentTime, c.edl);
      const library = useMediaStore.getState().media;
      if (c.brolls.length) {
        const active = brollAt(c.brolls, T);
        const media = active ? library[active.mediaId] : null;
        syncBroll(active, media, T, !v.paused);
        if (media) {
          const el = mediaElement(media);
          if (isReady(el)) drawBroll(ctx, el, media.width, media.height, active, stage.w, stage.h, T, media.kind);
        }
      } else {
        pauseAllBroll();
      }
      const title = brollAt(c.titles, T);
      if (title) drawTitle(ctx, title, T, stage.w, stage.h);
      ctx.restore();

      // Background music, ducked under speech.
      syncMusic(s.music, s.music ? library[s.music.mediaId] : null, v, T, c.speech, c.total);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      stopMusic();
      pauseAllBroll();
    };
  }, [videoRef]);

  return <canvas ref={canvasRef} onClick={onClick} className="absolute inset-0 h-full w-full cursor-pointer" />;
}
