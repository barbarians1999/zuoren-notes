require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('EPUB teardown clears queued work but retains section hooks until the active location load settles', async () => {
  const { releaseEpubBook } = await import('../src/readers/epubBookRelease.ts');
  const events = []; let finish;
  const section = { hooks: { content: true } };
  const loading = new Promise(resolve => { finish = () => { assert.equal(section.hooks.content, true); events.push('active-load-finished'); resolve(); }; });
  const book = { locations: { q: { clear: () => events.push('queue-cleared') } }, destroy: () => { section.hooks = undefined; events.push('destroyed'); } };
  const disposal = releaseEpubBook(book, loading);
  assert.deepEqual(events, ['queue-cleared']); finish(); await disposal;
  assert.deepEqual(events, ['queue-cleared', 'active-load-finished', 'destroyed']);
});
test('EPUB cleanup also releases resources after rejected generation or before generation begins', async () => {
  const { releaseEpubBook } = await import('../src/readers/epubBookRelease.ts');
  let count = 0;
  await releaseEpubBook({ locations: {}, destroy: () => count++ }, Promise.reject(Error('read failed')));
  await releaseEpubBook({ locations: undefined, destroy: () => count++ }); assert.equal(count, 2);
});
