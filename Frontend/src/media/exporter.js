// Client-side export (FR-6): source file + EDL -> cut MP4. No server involved.
//
// Pipeline (SRS §7.2), for each kept range of the EDL:
//   video: decode frames (WebCodecs, via mediabunny CanvasSink) -> draw on an
//          OffscreenCanvas -> encode (CanvasSource) at the rebased timestamp
//   audio: decode samples (AudioSampleSink) -> trim to the exact sample -> 5 ms
//          fade at each cut edge (no clicks) -> encode (AudioSampleSource)
//   both tracks use the same running `offset`, so they stay in sync across cuts.
// Then mux to MP4 (mediabunny) and return the bytes.
//
// Video goes through a canvas on purpose: aspect ratios, burned-in subtitles,
// titles and b-roll (Victory tier) are just extra drawing steps in drawFrame().
//
// Works in a Web Worker or on the main thread (uses OffscreenCanvas only).

import {
  Input,
  Output,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  ALL_FORMATS,
  CanvasSink,
  CanvasSource,
  AudioSampleSink,
  AudioSampleSource,
  AudioSample,
  QUALITY_HIGH,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
} from 'mediabunny';
import { drawCaption, findPageAt } from '../lib/captions.js';
import { getCaptionStyle } from '../lib/captionStyles.js';
import { drawFramed, outputSize } from '../lib/frame.js';
import { createBrollRenderer } from './brollExport.js';

const FADE_S = 0.005; // audio fade at every cut edge

/**
 * @param {{ file: File|Blob, edl: Array<{start:number,end:number}>, onProgress?: (p:number)=>void,
 *           captions?: { pages, styleId, settings } | null }} opts
 *   captions: burned-in subtitles, drawn with the same drawCaption() the preview uses.
 *   frame: aspect ratio / crop / fit (lib/frame.js), drawn with the same drawFramed().
 *   overlays: B-roll { items (resolved, output-timed), media: { id: { kind, file, duration } } }.
 * @returns {Promise<{ buffer: ArrayBuffer, videoCodec: string, audioCodec: string|null, width: number, height: number }>}
 */
export async function exportVideo({ file, edl, onProgress, captions = null, frame = null, overlays = null }) {
  if (!edl.length) throw new Error('Nothing to export: everything has been cut.');

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!videoTrack) throw new Error('This file has no video track.');

  // Output size follows the chosen aspect ratio (Original = the source size).
  const { width, height } = outputSize(videoTrack.displayWidth, videoTrack.displayHeight, frame);

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width, height });
  if (!videoCodec) throw new Error("This browser can't encode video. Please use the latest Chrome or Edge.");

  const audioCodec = audioTrack
    ? await getFirstEncodableAudioCodec(['aac', 'opus'], {
        numberOfChannels: audioTrack.numberOfChannels,
        sampleRate: audioTrack.sampleRate,
      })
    : null;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH });
  output.addVideoTrack(videoSource);

  let audioSource = null;
  if (audioCodec) {
    audioSource = new AudioSampleSource({ codec: audioCodec, quality: QUALITY_HIGH });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  // ---- progress: fraction of edited duration done, averaged over the tracks ----
  const total = edl.reduce((s, k) => s + (k.end - k.start), 0);
  let videoDone = 0;
  let audioDone = 0;
  const report = () => {
    const p = audioSource ? (videoDone + audioDone) / (2 * total) : videoDone / total;
    onProgress?.(Math.min(1, p));
  };

  const captionStyle = captions?.pages?.length ? getCaptionStyle(captions.styleId) : null;
  const broll = await createBrollRenderer(overlays);

  /**
   * One output frame: the framed video picture, then B-roll, then subtitles on top.
   * t = source time (subtitles are timed in source seconds), T = output time (B-roll).
   */
  const drawFrame = async (frameCanvas, t, T) => {
    drawFramed(ctx, frameCanvas, frameCanvas.width, frameCanvas.height, frame, width, height);
    if (broll) await broll.draw(ctx, T, width, height);
    if (captionStyle) {
      const page = findPageAt(captions.pages, t);
      if (page) drawCaption(ctx, page, t, captionStyle, captions.settings, width, height);
    }
    // Next: titles get drawn here.
  };

  const videoJob = async () => {
    const sink = new CanvasSink(videoTrack, { poolSize: 2 });
    let offset = 0;
    for (const k of edl) {
      for await (const frame of sink.canvases(k.start, k.end)) {
        // The first frame can start before the cut point; clamp it to the kept range.
        const start = Math.max(frame.timestamp, k.start);
        const end = Math.min(frame.timestamp + (frame.duration || 1 / 30), k.end);
        if (end - start <= 1e-6) continue;
        const T = offset + (start - k.start); // this frame's time in the output
        await drawFrame(frame.canvas, start, T);
        await videoSource.add(T, end - start);
        videoDone = offset + (end - k.start);
        report();
      }
      offset += k.end - k.start;
    }
    videoSource.close();
  };

  const audioJob = async () => {
    if (!audioSource) return;
    const sink = new AudioSampleSink(audioTrack);
    let offset = 0;
    for (const k of edl) {
      for await (const sample of sink.samples(k.start, k.end)) {
        try {
          const trimmed = trimAudioSample(sample, k, offset);
          if (trimmed) {
            await audioSource.add(trimmed);
            trimmed.close();
          }
          audioDone = Math.min(offset + (k.end - k.start), offset + (sample.timestamp + sample.duration - k.start));
          report();
        } finally {
          sample.close();
        }
      }
      offset += k.end - k.start;
    }
    audioSource.close();
  };

  // Run both tracks together so the muxer can interleave them.
  try {
    await Promise.all([videoJob(), audioJob()]);
  } finally {
    await broll?.close();
  }
  await output.finalize();

  return {
    buffer: output.target.buffer,
    videoCodec,
    audioCodec,
    width,
    height,
    subtitles: Boolean(captionStyle),
    brolls: overlays?.items?.length ?? 0,
  };
}

/** Cut an AudioSample down to the kept range k, fade the edges, and rebase its timestamp. */
function trimAudioSample(sample, k, offset) {
  const { sampleRate: sr, numberOfChannels: ch, numberOfFrames: n, timestamp: ts } = sample;
  const first = Math.max(0, Math.ceil((k.start - ts) * sr));
  const last = Math.min(n, Math.floor((k.end - ts) * sr));
  if (last <= first) return null;

  const len = last - first;
  const data = new Float32Array(len * ch); // planar: channel 0, then channel 1, ...
  const plane = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    data.set(plane.subarray(first, last), c * len);
  }

  // Short fade-in/out at the cut edges so cuts don't click.
  for (let i = 0; i < len; i++) {
    const t = ts + (first + i) / sr;
    const gain = Math.min(1, (t - k.start) / FADE_S, (k.end - t) / FADE_S);
    if (gain >= 1) continue;
    for (let c = 0; c < ch; c++) data[c * len + i] *= Math.max(0, gain);
  }

  return new AudioSample({
    data,
    format: 'f32-planar',
    numberOfChannels: ch,
    sampleRate: sr,
    timestamp: offset + (ts + first / sr - k.start),
  });
}
