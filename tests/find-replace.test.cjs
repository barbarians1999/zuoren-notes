const test = require('node:test');
const assert = require('node:assert/strict');

let findLiteralMatches;
let replaceLiteralMatch;
let replaceAllLiteralMatches;
let replaceAllLiteral;
let stepMatchIndex;

test.before(async () => {
  ({ findLiteralMatches, replaceLiteralMatch, replaceAllLiteralMatches, replaceAllLiteral, stepMatchIndex } = await import('../src/findReplace.ts'));
});

test('empty query yields no matches and no replacements', () => {
  assert.deepEqual(findLiteralMatches('正文', ''), []);
  assert.deepEqual(replaceAllLiteral('正文', '', '替换'), { text: '正文', count: 0 });
});

test('treats query and replacement metacharacters literally', () => {
  const source = 'a.*[b]$ a.*[b]$';
  const matches = findLiteralMatches(source, 'a.*[b]$');
  assert.equal(matches.length, 2);
  assert.deepEqual(replaceAllLiteralMatches(source, matches, '$&'), { text: '$& $&', count: 2 });
});

test('case matching is optional and literal', () => {
  assert.deepEqual(findLiteralMatches('Cat cat CAT', 'cat'), [{ from: 0, to: 3 }, { from: 4, to: 7 }, { from: 8, to: 11 }]);
  assert.deepEqual(findLiteralMatches('Cat cat CAT', 'cat', true), [{ from: 4, to: 7 }]);
});

test('Chinese and emoji offsets retain UTF-16 positions', () => {
  assert.deepEqual(findLiteralMatches('前🌙目标🌙后', '🌙目标'), [{ from: 1, to: 5 }]);
  assert.deepEqual(findLiteralMatches('🙂🙂', '🙂'), [{ from: 0, to: 2 }, { from: 2, to: 4 }]);
});

test('literal matches do not overlap', () => {
  assert.deepEqual(findLiteralMatches('aaaaa', 'aa'), [{ from: 0, to: 2 }, { from: 2, to: 4 }]);
});

test('next and previous navigation wrap and handle no current result', () => {
  assert.equal(stepMatchIndex(3, -1, 1), 0);
  assert.equal(stepMatchIndex(3, -1, -1), 2);
  assert.equal(stepMatchIndex(3, 2, 1), 0);
  assert.equal(stepMatchIndex(3, 0, -1), 2);
  assert.equal(stepMatchIndex(0, 0, 1), -1);
});

test('replace current and delete replacement text', () => {
  const matches = findLiteralMatches('甲 乙 甲', '甲');
  assert.deepEqual(replaceLiteralMatch('甲 乙 甲', matches, 1, ''), { text: '甲 乙 ', count: 1 });
  assert.deepEqual(replaceLiteralMatch('甲 乙 甲', matches, 8, '丙'), { text: '甲 乙 甲', count: 0 });
});

test('replace all handles empty replacement and literal dollar sequences', () => {
  assert.deepEqual(replaceAllLiteral('one one one', 'one', '', true), { text: '  ', count: 3 });
  assert.deepEqual(replaceAllLiteral('a+a+a+', 'a+', '[$&]', true), { text: '[$&][$&][$&]', count: 3 });
});

test('sparse case-fold offsets agree with the original per-code-point mapping', () => {
  function reference(text, query, sensitive, limit) {
    let folded = ''; const offsets = [];
    for (let from = 0; from < text.length;) { const character = String.fromCodePoint(text.codePointAt(from)), to = from + character.length;
      const mapped = sensitive ? character : character.toLowerCase(); folded += mapped;
      for (let i = 0; i < mapped.length; i++) offsets.push({ from, to }); from = to;
    }
    const needle = sensitive ? query : query.toLowerCase(), result = []; let cursor = 0;
    while (cursor <= folded.length - needle.length) { const at = folded.indexOf(needle, cursor); if (at < 0) break;
      result.push({ from: offsets[at].from, to: offsets[at + needle.length - 1].to }); if (result.length >= limit) break; cursor = at + needle.length;
    }
    return result;
  }
  const texts = ['AİBC İİ end', '前🌙İ🙂𐐀ΣΟΣ后', 'i\u0307 İ I', 'x\ud83dy\ude00z', 'İİİ', 'ABC xyz'];
  for (const text of texts) for (const query of ['i', 'İ', '\u0307', 'bc', '🌙', '🙂', '\ud83d', '\ude42', 'Σ', 'ΟΣ', '𐐨', 'end'])
    for (const sensitive of [true, false]) for (const limit of [1, Infinity]) assert.deepEqual(findLiteralMatches(text, query, sensitive, limit), reference(text, query, sensitive, limit), JSON.stringify({ text, query, sensitive, limit }));
  assert.deepEqual(replaceAllLiteral('İ X İ', 'i', 'Y'), { text: 'Y X Y', count: 2 });
});
