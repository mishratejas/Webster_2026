import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorForRange,
  resolveBrolls,
  brollAt,
  brollMediaTime,
  brollAlpha,
  withoutOverlapping,
  pipRect,
  drawBroll,
} from './overlays.js';

const words = [
  { id: 'w0', text: 'we', start: 1.0, end: 1.2 },
  { id: 'w1', text: 'went', start: 1.3, end: 1.6 },
  { id: 'w2', text: 'to', start: 1.7, end: 1.8 },
  { id: 'w3', text: 'the', start: 1.9, end: 2.0 },
  { id: 'w4', text: 'beach', start: 2.1, end: 2.6 },
];
const broll = (id, anchor, extra = {}) => ({ id, mediaId: 'm1', anchor, mode: 'cutaway', fade: true, offset: 0, ...extra });

test('a selection anchors to its first and last word, or to time over silence', () => {
  assert.deepEqual(anchorForRange({ start: 1.25, end: 2.05 }, words), { startWordId: 'w1', endWordId: 'w3' });
  assert.deepEqual(anchorForRange({ start: 3, end: 4 }, words), { start: 3, end: 4 });
});

test('overlays follow cuts: moved by earlier cuts, shortened by inner cuts, gone if all cut', () => {
  const b = broll('b1', { startWordId: 'w1', endWordId: 'w4' }); // 1.3 .. 2.6
  const [r0] = resolveBrolls([b], words, [], 10);
  assert.deepEqual([r0.outStart, r0.outEnd], [1.3, 2.6]);

  const [r1] = resolveBrolls([b], words, [{ start: 0, end: 1.0 }], 10); // cut before it
  assert.deepEqual([r1.outStart, r1.outEnd].map((x) => +x.toFixed(6)), [0.3, 1.6]);

  const [r2] = resolveBrolls([b], words, [{ start: 1.7, end: 1.8 }], 10); // cut "to" inside it
  assert.ok(Math.abs(r2.outEnd - r2.outStart - 1.2) < 1e-9);

  assert.equal(resolveBrolls([b], words, [{ start: 1.25, end: 2.7 }], 10).length, 0); // all cut
});

test('B-roll runs on output time: continuous through cuts, holds its last frame', () => {
  const [r] = resolveBrolls([broll('b1', { startWordId: 'w0', endWordId: 'w4' }, { offset: 2 })], words, [{ start: 1.7, end: 1.8 }], 10);
  // output 1.0 -> media 2.0; output just after the cut keeps counting smoothly
  assert.equal(brollMediaTime(r, r.outStart, 30), 2);
  assert.ok(Math.abs(brollMediaTime(r, r.outStart + 1, 30) - 3) < 1e-9);
  assert.equal(brollMediaTime(r, r.outStart + 99, 3), 2.95); // clip shorter than the overlay
});

test('fades in and out; at most one overlay on screen', () => {
  const resolved = resolveBrolls([broll('b1', { start: 4, end: 6 }), broll('b2', { start: 7, end: 8 })], words, [], 10);
  assert.equal(brollAt(resolved, 5).id, 'b1');
  assert.equal(brollAt(resolved, 6.5), null);
  assert.equal(brollAlpha(resolved[0], 4), 0);
  assert.equal(brollAlpha(resolved[0], 5), 1);
  assert.equal(brollAlpha({ ...resolved[0], fade: false }, 4), 1);
});

test('one layer: a new B-roll replaces the ones it overlaps', () => {
  const existing = [broll('b1', { startWordId: 'w0', endWordId: 'w1' }), broll('b2', { start: 5, end: 6 })];
  const kept = withoutOverlapping(existing, { start: 1.5, end: 2.0 }, words);
  assert.deepEqual(kept.map((b) => b.id), ['b2']);
});

test('PiP box sits in its corner, keeps the media aspect and stays inside the frame', () => {
  const r = pipRect({ corner: 'br', size: 0.3 }, 1920, 1080, 1280, 720);
  assert.ok(Math.abs(r.w / r.h - 1920 / 1080) < 1e-9);
  assert.ok(r.x + r.w <= 1280 && r.y + r.h <= 720);
  assert.ok(r.x > 640 && r.y > 360);
});

test('drawBroll covers the whole frame in cutaway mode', () => {
  const calls = [];
  const ctx = { save() {}, restore() {}, drawImage: (...a) => calls.push(a), set globalAlpha(v) {} };
  const [r] = resolveBrolls([broll('b1', { start: 4, end: 6 }, { fade: false })], words, [], 10);
  drawBroll(ctx, 'IMG', 1000, 1000, r, 1600, 900, 5); // square media into 16:9 frame
  const [, sx, sy, sw, sh, dx, dy, dw, dh] = calls[0];
  assert.deepEqual([dx, dy, dw, dh], [0, 0, 1600, 900]);
  assert.equal(sw, 1000);
  assert.equal(sh, 562.5); // cropped to 16:9, centred
  assert.equal(sy, (1000 - 562.5) / 2);
  assert.equal(sx, 0);
});
