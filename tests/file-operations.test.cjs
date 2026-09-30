const test = require('node:test');
const assert = require('node:assert/strict');
const { MutationBarrier, normalizeWindowsPath, sameOrDescendantPath, remapDescendantPath } = require('../src/fileOperations.cjs');

test('matches Windows paths case-insensitively and only at a separator boundary', () => {
  assert.equal(sameOrDescendantPath('D:\\Notes\\Chapter\\one.md', 'd:/notes'), true);
  assert.equal(sameOrDescendantPath('D:\\Notes-old\\one.md', 'D:\\Notes'), false);
  assert.equal(sameOrDescendantPath('D:\\Notes', 'D:\\Notes\\'), true);
});

test('remaps a renamed file or folder subtree without touching unrelated paths', () => {
  assert.equal(remapDescendantPath('D:\\Notes\\Chapter\\one.md', 'D:\\Notes\\Chapter', 'D:\\Notes\\第一章'), 'D:\\Notes\\第一章\\one.md');
  assert.equal(remapDescendantPath('D:\\Notes-old\\one.md', 'D:\\Notes', 'D:\\Archive'), 'D:\\Notes-old\\one.md');
  assert.equal(normalizeWindowsPath('D:/Notes/'), 'D:\\Notes');
});

test('mutation barriers release descendants and expire instead of blocking path reuse forever', () => {
  const barrier = new MutationBarrier(1_000);
  barrier.block('D:\\Notes\\Old');
  assert.equal(barrier.has('d:/notes/old/draft.md'), true);
  barrier.release('D:\\Notes\\Old\\draft.md');
  assert.equal(barrier.has('D:\\Notes\\Old\\draft.md'), false);

  barrier.block('D:\\Notes\\Deleted');
  assert.equal(barrier.has('D:\\Notes\\Deleted\\new.md', Date.now() + 500), true);
  assert.equal(barrier.has('D:\\Notes\\Deleted\\new.md', Date.now() + 1_001), false);
});
