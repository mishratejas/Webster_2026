import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropRect, clampFrame, outputSize, fitRect, previewStage, drawFramed, aspectRatio } from './frame.js';

const f = (aspect, extra = {}) => ({ aspect, mode: 'crop', cx: 0.5, cy: 0.5, zoom: 1, ...extra });

test('original keeps the source untouched', () => {
  assert.deepEqual(cropRect(1920, 1080, f('original')), { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(outputSize(1920, 1080, f('original')), { width: 1920, height: 1080 });
  assert.equal(aspectRatio(f('original'), 1920, 1080), 1920 / 1080);
});

test('crop 9:16 from landscape keeps full height, centred', () => {
  const r = cropRect(1920, 1080, f('9:16'));
  assert.equal(r.h, 1080);
  assert.equal(r.w, 607.5);
  assert.equal(r.x, (1920 - 607.5) / 2);
  assert.deepEqual(outputSize(1920, 1080, f('9:16')), { width: 608, height: 1080 });
});

test('crop centre is clamped so the crop never leaves the source', () => {
  const left = cropRect(1920, 1080, f('1:1', { cx: 0 }));
  assert.equal(left.x, 0);
  const right = cropRect(1920, 1080, f('1:1', { cx: 1 }));
  assert.equal(right.x + right.w, 1920);
  const c = clampFrame(f('1:1', { cx: -3 }), 1920, 1080);
  assert.equal(c.cx, 540 / 1920); // centre of a crop pushed hard left
});

test('zoom shrinks the kept area but not the output size', () => {
  const z1 = cropRect(1920, 1080, f('16:9'));
  const z2 = cropRect(1920, 1080, f('16:9', { zoom: 2 }));
  assert.equal(z2.w, z1.w / 2);
  assert.deepEqual(outputSize(1920, 1080, f('16:9', { zoom: 2 })), outputSize(1920, 1080, f('16:9')));
});

test('fit makes a padded frame of the target ratio, long side capped at 1920', () => {
  assert.deepEqual(outputSize(1920, 1080, f('9:16', { mode: 'fit' })), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize(1080, 1920, f('16:9', { mode: 'fit' })), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(1280, 720, f('1:1', { mode: 'fit' })), { width: 1280, height: 1280 });
});

test('preview stage is the output ratio centred in the preview box', () => {
  const s = previewStage(800, 450, 1920, 1080, f('9:16'));
  assert.ok(Math.abs(s.h - 450) < 1e-9);
  assert.ok(Math.abs(s.w / s.h - 608 / 1080) < 1e-9);
  assert.ok(Math.abs(s.x - (800 - s.w) / 2) < 1e-9);
  assert.deepEqual(fitRect(100, 100, 1), { x: 0, y: 0, w: 100, h: 100 });
});

test('drawFramed: crop draws the crop region into the whole output', () => {
  const calls = [];
  const ctx = { drawImage: (...a) => calls.push(a) };
  drawFramed(ctx, 'IMG', 1920, 1080, f('1:1'), 500, 500);
  assert.deepEqual(calls, [['IMG', 420, 0, 1080, 1080, 0, 0, 500, 500]]);
});

test('drawFramed: fit draws the whole picture contained (background needs OffscreenCanvas)', () => {
  const calls = [];
  const ctx = { drawImage: (...a) => calls.push(a), fillRect() {}, save() {}, restore() {} };
  drawFramed(ctx, 'IMG', 1920, 1080, f('9:16', { mode: 'fit' }), 1080, 1920);
  const last = calls[calls.length - 1];
  assert.deepEqual(last.slice(0, 5), ['IMG', 0, 0, 1920, 1080]);
  assert.equal(last[7], 1080); // full width
  assert.ok(Math.abs(last[8] - 607.5) < 1e-9); // 1080 * 9/16 tall, centred
});
