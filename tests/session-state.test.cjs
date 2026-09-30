const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  movePathBefore,
  resolveScrollTop,
  sanitizeScrollMemory,
  upsertScrollMemory,
} = require('../src/sessionState.cjs');

test('tab order helper moves one known path before another without mutating input', () => {
  const tabs = ['C:\\a.md', 'C:\\b.md', 'C:\\c.md'];
  assert.deepEqual(movePathBefore(tabs, 'C:\\c.md', 'C:\\a.md'), ['C:\\c.md', 'C:\\a.md', 'C:\\b.md']);
  assert.deepEqual(tabs, ['C:\\a.md', 'C:\\b.md', 'C:\\c.md']);
  assert.deepEqual(movePathBefore(tabs, 'C:\\missing.md', 'C:\\a.md'), tabs);
});

test('scroll memory keeps the newest value per pane, file, and mode and contains no note text', () => {
  const oldEntry = { pane: 'primary', path: 'C:\\notes\\a.md', mode: 'edit', scrollTop: 120, ratio: .2 };
  const newEntry = { ...oldEntry, scrollTop: 420, ratio: .7 };
  const preview = { ...oldEntry, mode: 'preview', scrollTop: 60, ratio: .1 };
  const saved = upsertScrollMemory([oldEntry, preview], newEntry);
  assert.deepEqual(saved, [preview, newEntry]);
  assert.equal(JSON.stringify(saved).includes('content'), false);
  assert.deepEqual(sanitizeScrollMemory([{ ...oldEntry, content: '正文' }, oldEntry]), [oldEntry]);
});

test('scroll restore uses absolute position when possible and ratio after layout shrinks', () => {
  const entry = { pane: 'secondary', path: 'D:\\notes\\b.md', mode: 'preview', scrollTop: 800, ratio: .8 };
  assert.equal(resolveScrollTop(entry, 1000), 800);
  assert.equal(resolveScrollTop(entry, 500), 400);
});
