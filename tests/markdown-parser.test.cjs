require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Obsidian basic Markdown keeps single tildes literal and renders double-tilde strike', async () => {
  const { parseMarkdown } = await import('../src/editor/markdownParser.ts');
  assert.equal(parseMarkdown('~word~ and H~2~O and x^2^'), '<p>~word~ and H~2~O and x^2^</p>\n');
  assert.equal(parseMarkdown('~~word~~'), '<p><del>word</del></p>\n');
  assert.equal(parseMarkdown('`~~literal~~`'), '<p><code>~~literal~~</code></p>\n');
  assert.equal(parseMarkdown('\\~literal\\~'), '<p>~literal~</p>\n');
});

test('reading grammar preserves Tab list nesting, code boundaries and highlight content', async () => {
  const { parseMarkdown } = await import('../src/editor/markdownParser.ts');
  const nested = parseMarkdown('- parent\n\t- **bold** ==*highlight*==\n\t- [ ] task');
  assert.equal((nested.match(/<ul>/g) || []).length, 2);
  assert.ok(nested.includes('<strong>bold</strong>'));
  assert.ok(nested.includes('<mark><em>highlight</em></mark>'));
  assert.ok(nested.includes('type="checkbox"'));
  for (const source of ['\t**literal**', '    **literal**', '~~~\n**literal**\n~~~']) {
    const html = parseMarkdown(source);
    assert.ok(html.includes('<pre><code>**literal**'), source);
    assert.equal(html.includes('<strong>'), false, source);
  }
});
