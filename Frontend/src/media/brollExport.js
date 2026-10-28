// B-roll in the exporter (runs in the export worker). For each output frame it finds the
// overlay on screen, gets that B-roll's frame at the right media time, and draws it with
// the same drawBroll() the preview uses.
//
// Video B-roll is decoded with mediabunny (WebCodecs) through one forward-only cursor per
// overlay: output frames arrive in order, so each cursor only ever moves forward, and a
// clip is decoded once. Images are decoded once into an ImageBitmap.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from 'mediabunny';
import { brollAt, brollMediaTime, drawBroll } from '../lib/overlays.js';

/** Forward-only "frame at time t" over a CanvasSink: keeps the current and the next frame. */
export class FrameCursor {
  constructor(sink, start) {
    this.it = sink.canvases(Math.max(0, start));
    this.cur = null;
    this.peek = null;
    this.done = false;
  }

  async read() {
    if (this.done) return null;
    const r = await this.it.next();
    if (r.done) {
      this.done = true;
      return null;
    }
    return r.value; // { canvas, timestamp, duration }
  }

  /** The last frame that starts at or before t (holds the last frame after the clip ends). */
  async frameAt(t) {
    if (!this.cur) this.cur = await this.read();
    if (!this.peek) this.peek = await this.read();
    while (this.peek && this.peek.timestamp <= t + 1e-6) {
      this.cur = this.peek;
      this.peek = await this.read();
    }
    return this.cur;
  }

  async close() {
    try {
      await this.it.return?.();
    } catch {
      // already finished
    }
  }
}

/**
 * @param {{ items: Array, media: Record<string, { kind, file, duration }> }} overlays
 *   items: resolved overlays (with outStart / outEnd), sorted by outStart
 * @returns {Promise<{ draw(ctx, T, W, H): Promise<void>, close(): Promise<void> } | null>}
 */
export async function createBrollRenderer(overlays) {
  const items = overlays?.items ?? [];
  if (!items.length) return null;
  const media = overlays.media ?? {};

  const tracks = new Map(); // mediaId -> video track
  const bitmaps = new Map(); // mediaId -> ImageBitmap
  for (const id of new Set(items.map((i) => i.mediaId))) {
    const m = media[id];
    if (!m?.file) continue;
    if (m.kind === 'image') {
      bitmaps.set(id, await createImageBitmap(m.file));
    } else {
      const input = new Input({ source: new BlobSource(m.file), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (track) tracks.set(id, track);
    }
  }

  const cursors = new Map(); // overlay id -> FrameCursor

  return {
    /** Draw the B-roll on screen at output time T onto a W×H frame (nothing if none). */
    async draw(ctx, T, W, H) {
      const item = brollAt(items, T);
      // Close cursors for overlays that have finished, to free their decoders.
      for (const [id, c] of cursors) {
        const it = items.find((x) => x.id === id);
        if (!it || T >= it.outEnd) {
          await c.close();
          cursors.delete(id);
        }
      }
      if (!item) return;
      const m = media[item.mediaId];
      if (!m) return;

      if (m.kind === 'image') {
        const bmp = bitmaps.get(item.mediaId);
        if (bmp) drawBroll(ctx, bmp, bmp.width, bmp.height, item, W, H, T, 'image');
        return;
      }
      const track = tracks.get(item.mediaId);
      if (!track) return;
      const mt = brollMediaTime(item, T, m.duration);
      let cursor = cursors.get(item.id);
      if (!cursor) {
        cursor = new FrameCursor(new CanvasSink(track, { poolSize: 4 }), mt);
        cursors.set(item.id, cursor);
      }
      const frame = await cursor.frameAt(mt);
      if (frame) drawBroll(ctx, frame.canvas, frame.canvas.width, frame.canvas.height, item, W, H, T, 'video');
    },

    async close() {
      for (const c of cursors.values()) await c.close();
      cursors.clear();
      for (const b of bitmaps.values()) b.close?.();
    },
  };
}
