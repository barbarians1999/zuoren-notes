require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/readers/epubSearch.ts');
const sections = Array.from({ length: 4 }, (_, index) => ({ index, href: `chapter-${index}.xhtml` }));

test('EPUB search scans sequentially, continues past damaged sections and reports progress', async () => {
  const { collectEpubMatches } = await load();
  const progress = []; let concurrent = 0;
  const result = await collectEpubMatches(sections, async section => {
    assert.equal(++concurrent, 1);
    try { if (section.index === 1) throw Error('damaged'); return [{ cfi: `cfi-${section.index}`, excerpt: 'match' }]; }
    finally { concurrent--; }
  }, { signal: new AbortController().signal, onProgress: status => progress.push(status.processed) });
  assert.equal(result.errors, 1); assert.equal(result.processed, 4);
  assert.deepEqual(result.results.map(item => item.sectionIndex), [0, 2, 3]);
  assert.deepEqual(progress, [1, 2, 3, 4]);
});
test('cancelled EPUB searches cannot publish a late section or start another', async () => {
  const { collectEpubMatches } = await load();
  const controller = new AbortController(); let calls = 0, updates = 0;
  await assert.rejects(collectEpubMatches(sections, async () => {
    calls++; controller.abort(); return [{ cfi: 'late', excerpt: 'late' }];
  }, { signal: controller.signal, onProgress: () => updates++ }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(updates, 0);
});
test('EPUB result caps are explicit and stop excess chapter work', async () => {
  const { collectEpubMatches } = await load(); let calls = 0;
  const result = await collectEpubMatches(sections, async (_section, limit) => {
    calls++; assert.equal(limit, 3); return [0, 1, 2].map(index => ({ cfi: `cfi-${index}`, excerpt: 'match' }));
  }, { signal: new AbortController().signal, limit: 2 });
  assert.equal(result.results.length, 2); assert.equal(result.truncated, true); assert.equal(calls, 1);
});
test('bounded literal search retains Unicode offsets and existing default behavior', async () => {
  const { findLiteralMatches } = await import('../src/findReplace.ts');
  assert.deepEqual(findLiteralMatches('İx İx İx', 'x', false, 2), [{ from: 1, to: 2 }, { from: 4, to: 5 }]);
  assert.equal(findLiteralMatches('aaa', 'a').length, 3);
  assert.deepEqual(findLiteralMatches('aaa', 'a', false, 0), []);
});
