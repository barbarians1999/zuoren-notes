const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalNoteContent, sameNoteContent } = require('../src/noteContent.cjs');

test('canonical note content treats LF, CRLF, and lone CR as the same text', () => {
  const mixed = '标题\r\n第一行\r第二行\n';
  assert.equal(canonicalNoteContent(mixed), '标题\n第一行\n第二行\n');
  assert.equal(sameNoteContent('标题\n第一行\n第二行\n', mixed), true);
  assert.equal(sameNoteContent('标题\n第一行\n第三行\n', mixed), false);
});
