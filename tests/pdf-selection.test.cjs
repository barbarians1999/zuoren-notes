const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let clean, visible, closestSpan, caretMatches, caretCoversPoint, endpointDirections, pointsAfterScroll, pagesBetween, cachedPosition, createCache, layerState, layerChanged;
before(async () => { ({ cleanPdfRects: clean, visiblePdfHighlightRects: visible, closestPdfTextSpan: closestSpan, pdfCaretMatchesNearestSpan: caretMatches,
  pdfCaretCoversPoint: caretCoversPoint, pdfSelectionEndpointDirections: endpointDirections, pdfSelectionPointsAfterScroll: pointsAfterScroll,
  pdfPageNumbersBetween: pagesBetween, pdfTextPositionFromEndpointCache: cachedPosition, createPdfTextEndpointCache: createCache,
  pdfTextEndpointLayerState: layerState, pdfTextEndpointLayerChanged: layerChanged } = await import('../src/readers/pdfSelection.ts')); });
test('live drag keeps its original text anchor fixed as the PDF scroller moves', () => {
  assert.deepEqual(pointsAfterScroll({ x: 100, y: 200 }, { x: 150, y: 300 }, { x: 8, y: 20 }, { x: 23, y: 55 }), {
    anchor: { x: 85, y: 165 }, focus: { x: 150, y: 300 },
  });
  assert.deepEqual(pagesBetween(3, 6), [3, 4, 5, 6], 'forward drags pin every intermediate page');
  assert.deepEqual(pagesBetween(6, 3), [6, 5, 4, 3], 'reverse drags pin every intermediate page');
  assert.deepEqual(pagesBetween(1, 1.5), [], 'page ranges reject invalid endpoints');
});
test('a null anchor cache retries only when its text layer revision or first text node changes', () => {
  let layer = null;
  const page = { querySelector: selector => selector === '.canvas-holder .textLayer' ? layer : null };
  let state = layerState(page);
  assert.equal(state.layer, null);
  layer = { dataset: { textRevision: '1' }, querySelector: () => null };
  let next = layerState(page);
  assert.equal(layerChanged(state, next), true, 'a delayed text layer permits one new cache attempt');
  state = next; next = layerState(page);
  assert.equal(layerChanged(state, next), false, 'an unchanged empty layer does not trigger every frame');
  const firstSpan = {};
  layer.querySelector = () => firstSpan; next = layerState(page);
  assert.equal(layerChanged(state, next), true, 'the first inserted text span permits a retry');
  state = next; layer.dataset.textRevision = '2'; next = layerState(page);
  assert.equal(layerChanged(state, next), true, 'text rerender revision changes invalidate a null result');
  state = next; layer = null; next = layerState(page);
  assert.equal(layerChanged(state, next), true, 'removing the layer invalidates a previous probe');
});
test('cached anchor resolves ties in the current direction without rescanning the text layer', () => {
  const upper = {}, lower = {}, makeCandidate = (element, text, rect) => {
    const node = { data: text, parentElement: { closest: () => element } };
    element.isConnected = true; element.getBoundingClientRect = () => ({ width: rect.width, height: rect.height });
    return { element, rect, position: { node, offset: 1 }, text };
  };
  const layer = { dataset: { textRevision: '4' } }, candidates = [
    makeCandidate(upper, 'upper', { left: 10, top: 10, width: 20, height: 8 }),
    makeCandidate(lower, 'lower', { left: 10, top: 22, width: 20, height: 8 }),
  ];
  const root = { contains: () => true, querySelectorAll: () => { throw new Error('cached frames must not query page spans'); } };
  const cache = { layer, revision: '4', rotation: '', candidates };
  assert.equal(cachedPosition(root, cache, { x: 0, y: 1 }).node.data, 'lower');
  assert.equal(cachedPosition(root, cache, { x: 0, y: -1 }).node.data, 'upper', 'reversing the drag flips the cached tie winner');
  upper.getBoundingClientRect = () => ({ width: 21, height: 8 });
  assert.equal(cachedPosition(root, cache, { x: 0, y: 1 }), null, 'layout scaling invalidates cached character geometry');
  upper.getBoundingClientRect = () => ({ width: 20, height: 8 });
  layer.dataset.textRevision = '5';
  assert.equal(cachedPosition(root, cache, { x: 0, y: 1 }), null, 'a text layer revision invalidates cached endpoints');
});
test('anchor cache resolves a gap caret through the span owner document Range path', () => {
  const previous = { Node: global.Node, NodeFilter: global.NodeFilter, getComputedStyle: global.getComputedStyle };
  const node = { nodeType: 3, data: 'abc', get length() { return this.data.length; } };
  const rect = { left: 10, right: 22, top: 10, bottom: 20, width: 12, height: 10 };
  const span = { firstChild: node, isConnected: true, getBoundingClientRect: () => rect, closest: () => null };
  node.parentElement = { closest: () => span };
  let ranges = 0;
  const document = {
    caretRangeFromPoint: () => null, caretPositionFromPoint: () => null,
    createTreeWalker: () => { let visited = false; return { currentNode: null, nextNode() { if (visited) return false; visited = true; this.currentNode = node; return true; } }; },
    createRange: () => {
      ranges++; let offset = 0;
      return { setStart(_node, value) { offset = value; }, setEnd() {}, getBoundingClientRect: () => ({ left: 10 + offset * 4, right: 14 + offset * 4, top: 10, bottom: 20, width: 4, height: 10 }) };
    },
  };
  span.ownerDocument = document;
  const layer = { dataset: { textRevision: '1', mainRotation: '0' }, querySelectorAll: () => [span] };
  const holder = { getBoundingClientRect: () => ({ left: 0, right: 50, top: 0, bottom: 50 }), querySelector: () => layer };
  const root = { ownerDocument: document, querySelectorAll: selector => selector === '.canvas-holder' ? [holder] : [], contains: value => value === node };
  try {
    global.Node = { TEXT_NODE: 3 }; global.NodeFilter = { SHOW_TEXT: 4 };
    global.getComputedStyle = () => ({ transform: 'none', direction: 'ltr' });
    const cache = createCache(root, { x: 15.75, y: 15 });
    assert.ok(cache);
    assert.equal(cache.candidates[0].position.node, node);
    assert.equal(cache.candidates[0].position.offset, 1, 'the nearest glyph determines the cached caret');
    assert.equal(ranges, 3, 'the actual text-layer character geometry path ran once for each glyph');
  } finally {
    global.Node = previous.Node; global.NodeFilter = previous.NodeFilter; global.getComputedStyle = previous.getComputedStyle;
  }
});
test('a valid but distant native caret cannot override the line entered at an inter-line tie', () => {
  const upper = {}, lower = {}, point = { x: 15, y: 20 }, spans = [
    { element: upper, rect: { left: 10, right: 20, top: 10, bottom: 18, width: 10, height: 8 } },
    { element: lower, rect: { left: 10, right: 20, top: 22, bottom: 30, width: 10, height: 8 } },
  ];
  const downward = closestSpan(spans, point, { x: 0, y: 1 }), upward = closestSpan(spans, point, { x: 0, y: -1 });
  const makePosition = span => ({ nodeType: 3, length: 4, parentElement: { closest: () => span } });
  assert.equal(downward, lower); assert.equal(upward, upper);
  assert.equal(closestSpan(spans, point), lower, 'stationary gap points retain the lower-line default');
  assert.equal(caretMatches({ node: makePosition(upper), offset: 1 }, downward), false, 'stale native caret from the upper line must fall back during a downward drag');
  assert.equal(caretMatches({ node: makePosition(lower), offset: 1 }, downward), true, 'a native caret on the nearest line remains precise');
  assert.equal(caretMatches({ node: makePosition(lower), offset: 1 }, upward), false, 'reverse drags reject a caret on the line opposite the pointer direction');
  const left = {}, right = {}, across = [
    { element: left, rect: { left: 0, right: 8, top: 10, bottom: 20, width: 8, height: 10 } },
    { element: right, rect: { left: 12, right: 20, top: 10, bottom: 20, width: 8, height: 10 } },
  ];
  assert.equal(closestSpan(across, { x: 10, y: 15 }, { x: 1, y: 0 }), right, 'horizontal writing direction follows rightward motion');
  assert.equal(closestSpan(across, { x: 10, y: 15 }, { x: -1, y: 0 }), left, 'horizontal writing direction follows leftward motion');
  const toward = endpointDirections({ x: 20, y: 30 }, { x: 20, y: 10 });
  assert.deepEqual(toward, { start: { x: 0, y: -20 }, end: { x: 0, y: 20 } }, 'each endpoint tie resolves inward from its own edge');
});
test('long same-span text keeps endpoint carets and outside boundaries choose the nearest edge span', () => {
  const longLine = {}, other = {}, left = 0, right = 10000;
  const spans = [
    { element: longLine, rect: { left, right, top: 10, bottom: 20, width: right - left, height: 10 } },
    { element: other, rect: { left: 5, right: 20, top: 40, bottom: 50, width: 15, height: 10 } },
  ];
  const makePosition = (span, length) => ({ nodeType: 3, length, parentElement: { closest: () => span } });
  for (const offset of [0, 10000]) assert.equal(caretMatches({ node: makePosition(longLine, 10000), offset }, longLine), true);
  assert.equal(caretMatches({ node: makePosition(longLine, 10000), offset: -1 }, longLine), false);
  assert.equal(caretMatches({ node: makePosition(longLine, 10000), offset: 10001 }, longLine), false);
  assert.equal(closestSpan(spans, { x: -1, y: 15 }), longLine, 'left of a long line resolves to its first edge');
  assert.equal(closestSpan(spans, { x: 10001, y: 15 }), longLine, 'right of a long line resolves to its last edge');
  assert.equal(closestSpan(spans, { x: 10, y: 45 }), other, 'a closer neighboring span wins over a long line');
});
test('a native caret inside its span is accepted with one local bounds read', () => {
  let reads = 0;
  const span = { closest: () => null, getBoundingClientRect: () => { reads += 1; return { left: 10, right: 30, top: 10, bottom: 20 }; } };
  const position = { node: { nodeType: 3, length: 10000, parentElement: { closest: () => span } }, offset: 5000 };
  assert.equal(caretCoversPoint(position, { x: 20, y: 15 }), true);
  assert.equal(reads, 1, 'normal in-span carets need no page-wide span scan');
  assert.equal(caretCoversPoint(position, { x: 31, y: 15 }), false, 'out-of-span points still require nearest-point fallback');
  assert.equal(reads, 2);
});
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
