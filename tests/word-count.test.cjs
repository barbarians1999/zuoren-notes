const test = require('node:test');
const assert = require('node:assert/strict');

let countTextUnits;
let countMarkdownUnits;

test.before(async () => {
  ({ countTextUnits, countMarkdownUnits } = await import('../src/wordCount.ts'));
});

test('counts Han characters and continuous Latin or number words', () => {
  assert.equal(countTextUnits('我的 analysis 2026，PDF。'), 5);
  assert.equal(countMarkdownUnits('# 剩余价值\n\n这是 PDF research reader 2026。'), 10);
});

test('does not count Markdown link destinations or formatting punctuation', () => {
  assert.equal(countMarkdownUnits('[原文摘录](#reader-anchor-ABC123) 和 ![图表说明](attachments/a.png)'), 9);
  assert.equal(countMarkdownUnits('**重点**、`概念`，以及 —— 标点。'), 8);
});

test('empty and punctuation-only selections count as zero', () => {
  assert.equal(countTextUnits(''), 0);
  assert.equal(countTextUnits('，。！？——'), 0);
});
