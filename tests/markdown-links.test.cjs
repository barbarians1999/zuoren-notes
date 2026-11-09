require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function linkTargets(source) {
  const { EditorState } = await import('@codemirror/state');
  const { syntaxTree } = await import('@codemirror/language');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const { markdownLinkURL } = await import('../src/editor/markdownLinks.ts');
  const { buildMarkdownLivePreview } = await import('../src/editor/markdownLivePreview.ts');
  const state = EditorState.create({ doc: source, extensions: [markdownSyntax()] });
  const tree = syntaxTree(state), urls = [], decorated = [];
  tree.iterate({ enter(ref) {
    if (ref.name === 'Link' || ref.name === 'Autolink') urls.push(markdownLinkURL(state, tree, ref.node));
  } });
  buildMarkdownLivePreview(state).between(0, state.doc.length, (_from, _to, value) => {
    const href = value.spec.attributes?.['data-markdown-link'];
    if (href !== undefined) decorated.push(href);
  });
  assert.equal(state.doc.toString(), source, 'link presentation preserves the UTF-16 source');
  return { urls, decorated };
}

async function readingTargets(source) {
  const { parseMarkdown } = await import('../src/editor/markdownParser.ts');
  const { decodeHTMLAttribute } = await import('entities');
  return [...parseMarkdown(source).matchAll(/<a href="([^"]*)"/g)].map(match => decodeHTMLAttribute(match[1]));
}

// Reproduction: Lezer's URL ranges still contain Markdown delimiters and
// escapes, whereas the reader uses Marked's rendered href attribute.
for (const [source, expected] of [
  ['[x](<./a b.md>)', './a%20b.md'],
  ['[x](a\\(b\\).md)', 'a(b).md'],
  ['<person@example.com>', 'mailto:person@example.com'],
  ['[x][id]\n\n[id]: <./a b.md>', './a%20b.md'],
  ['[x][]\n\n[x]: a\\(b\\).md', 'a(b).md'],
  ['[x]\n\n[x]: ./a&amp;b.md', './a&b.md'],
  ['[x](./a&amp;amp;b.md)', './a&amp;b.md'],
  ['[x](./a&copy;b.md)', './a©b.md'],
  ['[x](./a&#0000000065;b.md)', './aAb.md'],
  ['[x](./a&copy=2.md)', './a&copy=2.md'],
  ['[x](a\\q.md)', 'a%5Cq.md'],
  ['[x](a\\（b.md)', 'a%EF%BC%88b.md'],
  ['[x](<a\\\\(b).md>)', 'a%5C(b).md'],
  ['[x](./中文😀.md)', './%E4%B8%AD%E6%96%87%F0%9F%98%80.md'],
  ['[x](./a%20b.md)', './a%20b.md'],
  ['[x](./a%2520b.md)', './a%2520b.md'],
  ['[x](https://example.test/?a=1&amp;b=2)', 'https://example.test/?a=1&b=2'],
  ['[x](person@example.com)', 'person@example.com'],
  ['[x](#heading)', '#heading'],
  ['<mailto:person@example.com>', 'mailto:person@example.com'],
  ['<https://example.test/a\\(b)>', 'https://example.test/a%5C(b)'],
]) test('editor and reader link destinations agree: ' + JSON.stringify(source), async () => {
  const text = '😀 cursor\n\n' + source;
  assert.deepEqual(await readingTargets(text), [expected]);
  const result = await linkTargets(text);
  assert.deepEqual(result.urls, [expected]);
  assert.deepEqual(result.decorated, [expected], 'Ctrl/Cmd-click receives the normalized destination');
});

test('reference links still use the first matching definition and ignore unresolved labels', async () => {
  const source = '[x][ID] [missing]\n\n[id]: <./first file.md>\n[id]: ./second.md';
  assert.deepEqual(await readingTargets(source), ['./first%20file.md']);
  const result = await linkTargets(source);
  assert.deepEqual(result.urls, ['./first%20file.md', undefined]);
  assert.deepEqual(result.decorated, ['./first%20file.md']);
});

test('normalization exposes entity-obfuscated schemes to the existing IPC allowlist', async () => {
  for (const [source, target] of [
    ['[x](javascript&#58;alert(1))', 'javascript:alert(1)'],
    ['[x](data&colon;text/html,test)', 'data:text/html,test'],
    ['[x](javascript\\:alert(1))', 'javascript:alert(1)'],
  ]) {
    assert.deepEqual(await readingTargets(source), [target]);
    assert.deepEqual((await linkTargets(source)).urls, [target]);
    assert.equal(/^(?:https?:|mailto:)/i.test(target), false, 'no unsafe scheme becomes an allowed opener');
  }
});

test('images retain their raw destination contract so their decoder runs only once', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { syntaxTree } = await import('@codemirror/language');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const { markdownLinkURL } = await import('../src/editor/markdownLinks.ts');
  const { buildMarkdownLivePreview, markdownLivePreviewConfig } = await import('../src/editor/markdownLivePreview.ts');
  for (const [source, raw, decoded] of [
    ['![alt](<a b.png>)', '<a b.png>', 'a b.png'],
    ['![alt](a\\(b\\).png)', 'a\\(b\\).png', 'a(b).png'],
    ['![alt](a&amp;amp;b.png)', 'a&amp;amp;b.png', 'a&amp;b.png'],
    ['![alt][id]\n\n[id]: <a b.png>', '<a b.png>', 'a b.png'],
  ]) {
    const text = 'cursor\n\n' + source;
    const state = EditorState.create({ doc: text, extensions: [markdownSyntax(),
      markdownLivePreviewConfig.of({ notePath: '/notes/note.md', openImage: async () => {} })] });
    const tree = syntaxTree(state);
    tree.iterate({ enter(ref) {
      if (ref.name === 'Image') assert.equal(markdownLinkURL(state, tree, ref.node), raw);
    } });
    const images = [];
    buildMarkdownLivePreview(state).between(0, text.length, (_from, _to, value) => {
      if (value.spec.widget?.constructor.name === 'ImageWidget') images.push(value.spec.widget.source);
    });
    assert.deepEqual(images, [decoded]);
  }
});
