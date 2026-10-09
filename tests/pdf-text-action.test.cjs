const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let create;
before(async () => { ({ createPdfTextAction: create } = await import('../src/readers/pdfTextAction.ts')); });
const selection = () => ({ id: 'selection', pdfId: 'pdf', path: 'a.pdf', documentKey: {}, quote: 'one\n\ntwo', pages: [1, 2].map(page => ({ page, quote: page === 1 ? 'one' : 'two', rotation: 0, rects: [{ x: .1, y: .1, w: .1, h: .02 }], textRevision: 1 })) });
test('cross-page highlighting saves one batch and concurrent actions are single-flight', async () => {
  let writes = 0, inserts = 0, release, captured;
  const gate = new Promise(resolve => { release = resolve; });
  const run = create(selection(), 'highlight-and-excerpt', { sourceCurrent: () => true, targetCurrent: () => true,
    save: async items => { writes++; captured = items; await gate; return true; }, insert: async pages => { inserts++; assert.equal(pages.length, 2); return true; } });
  const first = run(), second = run(); assert.equal(first, second); release();
  assert.deepEqual(await first, { done: true, saved: true, inserted: true });
  await run(); assert.equal(writes, 1); assert.equal(inserts, 1); assert.deepEqual(captured.map(item => item.anchor.page), [1, 2]);
});
test('save failure retries identical IDs; excerpt failure never repeats saved highlights', async () => {
  let writes = 0, inserts = 0, ids;
  const run = create(selection(), 'highlight-and-excerpt', { sourceCurrent: () => true, targetCurrent: () => true,
    save: async items => { const next = items.map(item => item.id); if (ids) assert.deepEqual(next, ids); ids = next; return ++writes > 1; },
    insert: async () => ++inserts > 1 });
  let outcome = await run(); assert.equal(outcome.saved, false); assert.equal(inserts, 0);
  outcome = await outcome.retry(); assert.equal(outcome.saved, true); assert.equal(outcome.inserted, false);
  outcome = await outcome.retry(); assert.equal(outcome.done, true); assert.equal(writes, 2); assert.equal(inserts, 2);
});
test('source and target switches prevent late excerpt insertion and retries stay bound', async () => {
  let current = true, inserts = 0;
  const run = create(selection(), 'highlight-and-excerpt', { sourceCurrent: () => true, targetCurrent: () => current,
    save: async () => { current = false; return true; }, insert: async () => { inserts++; return true; } });
  const result = await run(); assert.equal(result.saved, true); assert.equal(result.done, false); assert.equal(inserts, 0);
  await result.retry(); assert.equal(inserts, 0);
  const stale = create(selection(), 'highlight', { sourceCurrent: () => false, targetCurrent: () => true, save: async () => assert.fail('stale save'), insert: async () => assert.fail('stale insert') });
  assert.equal((await stale()).saved, false);
});
test('thrown insert failure preserves partial success and an excerpt-only operation never saves', async () => {
  let inserts = 0;
  const run = create(selection(), 'highlight-and-excerpt', { sourceCurrent: () => true, targetCurrent: () => true, save: async () => true,
    insert: async () => { if (++inserts === 1) throw Error('injected'); return true; } });
  const result = await run(); assert.equal(result.saved, true); assert.match(result.error, /injected/); assert.equal((await result.retry()).done, true);
  assert.equal((await create(selection(), 'excerpt', { sourceCurrent: () => true, targetCurrent: () => true, save: async () => assert.fail('excerpt save'), insert: async () => true })()).inserted, true);
});
