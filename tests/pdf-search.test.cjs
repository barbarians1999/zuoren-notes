const test = require('node:test');
const assert = require('node:assert/strict');

let pdfPageText;
let collectPdfSearchMatches;
let normalizePdfSearchText;
let normalizePdfSearchTextWithMap;
let findPdfPageMatches;

test.before(async () => {
  ({ pdfPageText, collectPdfSearchMatches, normalizePdfSearchText, normalizePdfSearchTextWithMap, findPdfPageMatches } = await import('../src/pdfSearch.ts'));
});

test('builds readable PDF page text without splitting Chinese characters', () => {
  assert.equal(pdfPageText([{ str: '剩余' }, { str: '价值', hasEOL: true }, { str: 'surplus' }, { str: 'value' }]), '剩余价值 surplus value');
});

test('collects matches in page and occurrence order', () => {
  assert.deepEqual(collectPdfSearchMatches(['第一处 资本 第二处资本', '资本与劳动'], '资本').map(({ page, occurrence }) => ({ page, occurrence })), [
    { page: 1, occurrence: 0 },
    { page: 1, occurrence: 1 },
    { page: 2, occurrence: 0 },
  ]);
});

test('PDF search supports case sensitivity and result limits', () => {
  assert.equal(collectPdfSearchMatches(['Capital capital', 'capital'], 'capital', true).length, 2);
  assert.equal(collectPdfSearchMatches(['Capital capital', 'capital'], 'capital', false, 2).length, 2);
});

test('normalizes whitespace and retains raw offsets for DOM ranges', () => {
  const normalized = normalizePdfSearchTextWithMap('a\r\n  b');
  assert.equal(normalized.text, 'a b');
  assert.equal(normalized.starts[2], 5);
  assert.equal(normalized.ends[2], 6);
  assert.equal(normalizePdfSearchText('甲\n\t乙'), '甲 乙');
});

test('finds literal cross-item text and regex punctuation', () => {
  const text = pdfPageText([{ str: 'surplus' }, { str: 'value' }, { str: 'a.*[b]' }]);
  assert.equal(findPdfPageMatches(text, 'surplus   value').length, 1);
  assert.equal(findPdfPageMatches(text, 'a.*[b]').length, 1);
});
