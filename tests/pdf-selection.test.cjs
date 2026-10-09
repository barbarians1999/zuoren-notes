const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let clean, visible;
before(async () => { ({ cleanPdfRects: clean, visiblePdfHighlightRects: visible } = await import('../src/readers/pdfSelection.ts')); });
test('PDF rectangles clip, discard invalid nodes and deduplicate without mutating sidecars', () => {
  const rects = [{ x: -.01, y: .1, w: .11, h: .02 }, { x: 0, y: .1, w: .1, h: .02 }, { x: .9, y: .98, w: .2, h: .1 }, { x: 0, y: 0, w: 0, h: .01 }, { x: NaN, y: 0, w: 1, h: 1 }];
  const snapshot = structuredClone(rects), result = clean(rects, 1000, 1000);
  assert.equal(result.length, 2); assert.equal(result[0].x, 0); assert.ok(Math.abs(result[1].h - .02) < 1e-9);
  assert.deepEqual(rects, snapshot);
});
test('PDF geometry merges only same-line and same-direction fragments within one pixel', () => {
  const rect = (x, y, w = .1, angle = 0) => ({ x, y, w, h: .02, angle });
  assert.equal(clean([rect(.1, .1), rect(.2009, .1)], 1000, 1000).length, 1);
  assert.equal(clean([rect(.1, .1), rect(.202, .1)], 1000, 1000).length, 2);
  assert.equal(clean([rect(.1, .1), rect(.1, .13)], 1000, 1000).length, 2);
  assert.equal(clean([rect(.1, .1), rect(.15, .1, .1, 90)], 1000, 1000).length, 2);
  assert.equal(clean([rect(.1, .1), rect(.3, .1), rect(.2, .1)], 1000, 1000).length, 1, 'bridge rechecks all fragments');
  assert.equal(clean([rect(.1, .1), rect(.6, .1)], 1000, 1000).length, 2, 'columns never join');
  assert.deepEqual(clean([rect(.1, .1)], 0, 1000), []);
});
test('vertical PDF fragments merge along their writing direction, not across columns', () => {
  const a = { x: .1, y: .1, w: .02, h: .1, angle: 90 };
  assert.equal(clean([a, { ...a, y: .2005 }], 1000, 1000).length, 1);
  assert.equal(clean([a, { ...a, x: .13 }], 1000, 1000).length, 2);
});
test('saved highlights paint once and leave a selected area entirely to the blue overlay', () => {
  const rect = { x: .1, y: .1, w: .3, h: .02 }, cut = { x: .2, y: .1, w: .1, h: .02 };
  assert.equal(visible([rect, rect], [], 1000, 1000).length, 1);
  const parts = visible([rect, rect], [cut], 1000, 1000);
  assert.equal(parts.length, 2); assert.ok(Math.abs(parts.reduce((area, part) => area + part.w * part.h, 0) - .004) < 1e-9);
  for (const part of parts) assert.ok(part.x + part.w <= cut.x + 1e-9 || part.x >= cut.x + cut.w - 1e-9);
  assert.deepEqual(visible([rect], [rect], 1000, 1000), []);
});
