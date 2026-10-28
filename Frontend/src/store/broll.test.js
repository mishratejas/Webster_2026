// B-roll at store level: add over words, one layer, undo/redo together with cuts,
// Delete removes the selected overlay, overlays follow cuts. Plus the export frame cursor.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useEditorStore } from './useEditorStore.js';
import { deleteOrRestoreSelection } from '../components/editActions.js';
import { resolveBrolls, BROLL_DEFAULTS } from '../lib/overlays.js';

const WORDS = [
  { id: 'w0', text: 'we', start: 1.0, end: 1.2 },
  { id: 'w1', text: 'went', start: 1.3, end: 1.6 },
  { id: 'w2', text: 'to', start: 1.7, end: 1.8 },
  { id: 'w3', text: 'the', start: 1.9, end: 2.0 },
  { id: 'w4', text: 'beach', start: 2.1, end: 2.6 },
];
const s = () => useEditorStore.getState();
const item = (id, startWordId, endWordId) => ({ id, mediaId: 'm1', ...BROLL_DEFAULTS, anchor: { startWordId, endWordId } });

beforeEach(() => {
  s().reset();
  useEditorStore.setState({ videoUrl: 'blob:test', duration: 6 });
  s().setTranscript(WORDS);
});

test('adding B-roll is one undoable step, interleaved correctly with cuts', () => {
  s().commitBrolls([item('b1', 'w3', 'w4')]); // step 1
  s().removeRange({ start: 1.0, end: 1.2 }); // step 2: cut "we"
  assert.equal(s().brolls.length, 1);
  s().undo(); // undo the cut only
  assert.deepEqual(s().removedRanges, []);
  assert.equal(s().brolls.length, 1);
  s().undo(); // undo the B-roll
  assert.equal(s().brolls.length, 0);
  s().redo();
  s().redo();
  assert.equal(s().brolls.length, 1);
  assert.deepEqual(s().removedRanges, [{ start: 1.0, end: 1.2 }]);
});

test('Delete removes the selected B-roll, not the words under it', () => {
  s().commitBrolls([item('b1', 'w3', 'w4')]);
  s().selectOverlay('b1');
  deleteOrRestoreSelection();
  assert.equal(s().brolls.length, 0);
  assert.deepEqual(s().removedRanges, []);
  assert.equal(s().selectedOverlayId, null);
});

test('selecting words deselects the B-roll; undo past its creation clears the selection', () => {
  s().commitBrolls([item('b1', 'w0', 'w1')]);
  s().selectOverlay('b1');
  s().setSelection({ anchor: 0, focus: 0 });
  assert.equal(s().selectedOverlayId, null);
  s().selectOverlay('b1');
  s().undo();
  assert.equal(s().selectedOverlayId, null);
});

test('cutting all of its words hides the B-roll; restoring brings it back', () => {
  s().commitBrolls([item('b1', 'w1', 'w2')]);
  const visible = () => resolveBrolls(s().brolls, s().words, s().removedRanges, s().duration).length;
  assert.equal(visible(), 1);
  s().removeRange({ start: 1.3, end: 1.8 });
  assert.equal(visible(), 0);
  s().undo();
  assert.equal(visible(), 1);
});

test('export frame cursor: moves forward only and holds the last frame', async () => {
  const { FrameCursor } = await import('../media/brollExport.js').catch(() => ({}));
  if (!FrameCursor) return; // mediabunny not installed in this environment
  const frames = [0, 0.5, 1.0, 1.5].map((timestamp) => ({ timestamp, canvas: { id: timestamp } }));
  const sink = {
    canvases: async function* () {
      yield* frames;
    },
  };
  const c = new FrameCursor(sink, 0);
  assert.equal((await c.frameAt(0.1)).timestamp, 0);
  assert.equal((await c.frameAt(0.99)).timestamp, 0.5);
  assert.equal((await c.frameAt(1.2)).timestamp, 1.0);
  assert.equal((await c.frameAt(9)).timestamp, 1.5); // past the end: last frame
});
