require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
async function fixture(doc, anchor = 0) {
  const { EditorState } = await import('@codemirror/state');
  const { ensureSyntaxTree } = await import('@codemirror/language');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [markdownSyntax()] });
  const tree = ensureSyntaxTree(state, doc.length, 500);
  const nodes = name => { const found = []; tree.iterate({ enter(ref) { if (ref.name === name) found.push(ref.node); } }); return found; };
  return { state, tree, nodes };
}

test('nested code keeps every line, blank line, literal indent and UTF-16 click positions', async () => {
  const { projectCodeBlock, projectedSourcePosition } = await import('../src/editor/markdownProjection.ts');
  for (const [opening, prefix, before] of [['> ```js', '> ', ''], ['  ```js', '  ', '- parent\n\n'], ['> > ```js', '> > ', '']]) {
    const doc = 'cursor\n\n' + before + opening + '\n' + prefix + 'first\n' + prefix + '\n' + prefix + '  第二行😀\n' + prefix + '```';
    const { state, nodes } = await fixture(doc);
    const block = projectCodeBlock(state, nodes('FencedCode')[0]);
    assert.equal(block.content.text, 'first\n\n  第二行😀');
    for (const text of ['first', '第二行', '😀']) {
      const shown = block.content.text.indexOf(text), source = doc.indexOf(text);
      for (let offset = 0; offset <= text.length; offset++) assert.equal(projectedSourcePosition(block.content, shown + offset), source + offset, text + ': ' + offset);
    }
    assert.equal(state.doc.toString(), doc);
  }
});

test('empty and unclosed fences keep a safe source anchor without changing the document', async () => {
  const { projectCodeBlock, projectedSourcePosition } = await import('../src/editor/markdownProjection.ts');
  for (const doc of ['cursor\n\n> ```\n> ```', 'cursor\n\n- ```\n  one\n  two', 'cursor\n\n~~~\n&amp; \\*literal\\*\n~~~']) {
    const { state, nodes } = await fixture(doc);
    const projection = projectCodeBlock(state, nodes('FencedCode')[0]);
    const position = projectedSourcePosition(projection.content, 0);
    assert.ok(position >= projection.from && position <= projection.to);
    if (doc.includes('two')) assert.equal(projection.content.text, 'one\ntwo');
    if (doc.includes('&amp;')) assert.equal(projection.content.text, '&amp; \\*literal\\*');
    assert.equal(state.doc.toString(), doc);
  }
});

test('quoted and deeply nested tables render as tables with aligned source cells and references', async () => {
  const { projectTable, projectedSourcePosition } = await import('../src/editor/markdownProjection.ts');
  const { parseMarkdown } = await import('../src/editor/markdownParser.ts');
  for (const [before, prefix] of [['', '> '], ['- outer\n  - inner\n\n', '    ']]) {
    const doc = 'cursor\n\n' + before + prefix + '| A | B |\n' + prefix + '| :--- | ---: |\n' + prefix + '| **加粗** | [linked][id] |\n' + prefix + '| short |\n\n[id]: https://example.com';
    const { state, tree, nodes } = await fixture(doc);
    const projection = projectTable(state, nodes('Table')[0], tree);
    const html = parseMarkdown(projection.content.text + projection.references);
    assert.match(html, /<table>/); assert.match(html, /align="left"/); assert.match(html, /align="right"/);
    assert.match(html, /href="https:\/\/example.com"/);
    assert.equal(projection.cells.length, 6, 'missing cells retain their own safe click target');
    assert.equal(projection.cells[2].text, '加粗');
    assert.equal(projectedSourcePosition(projection.cells[2], 1), doc.indexOf('加粗') + 1);
    assert.equal(projection.cells[3].text, 'linked');
    assert.equal(projection.cells[5].text, '');
    assert.equal(state.doc.toString(), doc);
  }
});

test('heading labels share parsed text semantics for formats, entities, links and code', async () => {
  const { markdownOutline } = await import('../src/editor/markdownCommands.ts');
  const doc = '## **标题** \\*literal\\* &amp; &#x1F600; [linked][id] ` padded ` ##\n\n[id]: /target\n\nSetext __heading__\n===\n';
  const { state } = await fixture(doc);
  const headings = markdownOutline({ state });
  assert.deepEqual(headings.map(item => item.text), ['标题 *literal* & 😀 linked padded', 'Setext heading']);
  assert.deepEqual(headings.map(item => item.level), [2, 1]);
  assert.equal(headings[1].line, 4);
  assert.equal(markdownOutline({ state }), headings, 'selection-independent document index is cached');
  assert.equal(state.doc.toString(), doc);
});

test('empty table cells retain their column when header and body omit parsed text nodes', async () => {
  const { projectTable } = await import('../src/editor/markdownProjection.ts');
  for (const doc of ['| | B |\n| --- | --- |\n| | y |', '| A | B |\n| --- | --- |\n| x ||\n|  | z |']) {
    const { state, tree, nodes } = await fixture(doc);
    const projection = projectTable(state, nodes('Table')[0], tree);
    assert.deepEqual(projection.cells.map(cell => cell.text), doc.startsWith('| |') ? ['', 'B', '', 'y'] : ['A', 'B', 'x', '', '', 'z']);
  }
});

test('table cell source targets trim padding and keep UTF-16 row and column identities', async () => {
  const { projectTable } = await import('../src/editor/markdownProjection.ts');
  const doc = '| A | 😀 |\n| --- | --- |\n|  | x |';
  const { state, nodes } = await fixture(doc), table = projectTable(state, nodes('Table')[0]);
  assert.deepEqual(table.cells.map(({ row, column }) => [row, column]), [[0,0],[0,1],[1,0],[1,1]]);
  assert.equal(doc.slice(table.cells[1].from, table.cells[1].to), '😀');
  assert.equal(doc.slice(table.cells[2].from, table.cells[2].to), '');
});

test('table reference link titles omit quote syntax on continuation lines', async () => {
  const { projectTable } = await import('../src/editor/markdownProjection.ts');
  const { parseMarkdown } = await import('../src/editor/markdownParser.ts');
  const doc = '> | A | B |\n> | --- | --- |\n> | [link][id] | y |\n>\n> [id]: /url "first\n> second"';
  const { state, tree, nodes } = await fixture(doc), table = projectTable(state, nodes('Table')[0], tree);
  assert.match(parseMarkdown(table.content.text + table.references), /title="first\nsecond"/);
});

test('inline text projection keeps unresolved punctuation and literal code contents', async () => {
  const { projectInlineText, projectedSourcePosition } = await import('../src/editor/markdownProjection.ts');
  const doc = '\\*plain\\* &amp; &#x1F600; [missing][id] `&amp;`';
  const { state, tree, nodes } = await fixture(doc);
  const text = projectInlineText(state, nodes('Paragraph')[0], tree);
  assert.equal(text.text, '*plain* & 😀 [missing][id] &amp;');
  assert.equal(projectedSourcePosition(text, text.text.indexOf('plain') + 2), doc.indexOf('plain') + 2);
  const emoji = text.text.indexOf('😀');
  assert.equal(projectedSourcePosition(text, emoji), doc.indexOf('&#x1F600;'));
  assert.equal(projectedSourcePosition(text, emoji + 2), doc.indexOf('&#x1F600;') + 9);
});

test('inline code projection matches CommonMark padding and continuation-container rendering', async () => {
  const { projectInlineText, projectedSourcePosition } = await import('../src/editor/markdownProjection.ts');
  const { parseMarkdown } = await import('../src/editor/markdownParser.ts');
  for (const [doc, expected] of [
    ['> > `a\n> > b`', 'a b'],
    ['  > `a\n  > b`', 'a b'],
    ['- root\n  - `a\n    b`', 'a b'],
    ['> - `a\n>   b`', 'a b'],
    ['- `a\n\tb`', 'a   b'],
    ['- `  a  `', ' a '],
  ]) {
    const { state, nodes } = await fixture(doc);
    const projection = projectInlineText(state, nodes('InlineCode')[0]);
    assert.equal(projection.text, expected, doc);
    const html = parseMarkdown(doc), start = html.indexOf('<code>'), end = html.indexOf('</code>', start);
    assert.equal(html.slice(start + '<code>'.length, end), expected, doc);
    const anchor = expected.indexOf(doc.includes('x') ? 'x' : 'b');
    if (anchor >= 0) assert.equal(projectedSourcePosition(projection, anchor), doc.indexOf(doc.includes('x') ? 'x' : 'b'), doc);
  }
});

test('quote depth is explicit once per line and block replacements own their container prefixes', async () => {
  const { buildMarkdownLivePreview } = await import('../src/editor/markdownLivePreview.ts');
  const doc = 'cursor\n\n> outer\n> > inner\n> > > deepest\n\n1. > ```\n   > one\n   > two\n   > ```';
  const { state } = await fixture(doc);
  const ranges = []; buildMarkdownLivePreview(state).between(0, doc.length, (from, to, value) => ranges.push({ from, to, spec: value.spec }));
  const quotes = ranges.filter(range => range.spec.class === 'cm-md-quote');
  assert.deepEqual(quotes.map(range => Number(range.spec.attributes['data-quote-depth'])), [1, 2, 3]);
  const block = ranges.find(range => range.spec.widget?.constructor.name === 'CodeBlockWidget');
  assert.equal(block.from, doc.indexOf('1. >'));
  assert.equal(block.spec.widget.code, 'one\ntwo');
  assert.equal(block.spec.widget.projection.context.quoteDepth, 1);
  assert.equal(block.spec.widget.projection.context.markers[0].label, '1.');
  assert.equal(ranges.some(range => range !== block && range.from >= block.from && range.from < block.to), false, 'no duplicated hidden marker or orphan quote line');
  const active = await fixture(doc, doc.indexOf('two'));
  const widgets = []; buildMarkdownLivePreview(active.state).between(0, doc.length, (_from, _to, value) => { if (value.spec.widget) widgets.push(value.spec.widget.constructor.name); });
  assert.equal(widgets.includes('CodeBlockWidget'), false, 'editing the block reveals original Markdown');
});
