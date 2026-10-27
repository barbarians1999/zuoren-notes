require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
async function view(doc, selection = { anchor: 0, head: doc.length }) {
  const { EditorState } = await import('@codemirror/state');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const target = { state: EditorState.create({ doc, selection, extensions: [markdownSyntax()] }), focus() {} };
  target.dispatch = spec => { target.state = target.state.update(spec).state; };
  return target;
}
test('ordered/task/list commands toggle all selected lines and retain indentation', async () => {
  const { formatSourceBlock } = await import('../src/editor/markdownCommands.ts');
  for (const kind of ['ordered', 'task', 'bullet', 'quote', 'heading']) {
    const v = await view('one\n  two');
    formatSourceBlock(v, kind); formatSourceBlock(v, kind);
    assert.equal(v.state.doc.toString(), 'one\n  two', kind);
  }
});

test('Enter continues lists and immediately exits an empty item, including the second item', async () => {
  const { continueMarkdown, exitEmptyBlockquote } = await import('../src/editor/markdownCommands.ts');
  for (const [doc, first, second] of [
    ['- first', '- first\n- ', '- first\n'],
    ['1. first', '1. first\n2. ', '1. first\n'],
    ['1) first', '1) first\n2) ', '1) first\n'],
    ['- [x] first', '- [x] first\n- [ ] ', '- [x] first\n']
  ]) {
    const v = await view(doc, { anchor: doc.length });
    assert.equal(continueMarkdown(v), true);
    assert.equal(v.state.doc.toString(), first);
    assert.equal(continueMarkdown(v), true);
    assert.equal(v.state.doc.toString(), second, 'a blank second item does not become a loose list');
  }
  const doc = '> > quoted\n> > ', quote = await view(doc, { anchor: doc.length });
  assert.equal(exitEmptyBlockquote(quote), true);
  assert.equal(quote.state.doc.toString(), '> > quoted\n> ');
  assert.equal(exitEmptyBlockquote(quote), true);
  assert.equal(quote.state.doc.toString(), '> > quoted\n');
});

test('Backspace on an empty list item exits the top level cleanly and outdents nested task markers', async () => {
  const { exitEmptyListItem } = await import('../src/editor/markdownCommands.ts');
  for (const [doc, expected] of [
    ['- parent\n- ', '- parent\n'], ['  - ', ''], ['>   - ', '> '],
    ['- parent\n    - ', '- parent\n- '], ['12. parent\n    3. ', '12. parent\n3. '],
    ['- parent\n \t- child\n \t  - ', '- parent\n \t- child\n \t- '],
    ['  - parent\n      - ', '  - parent\n  - '],
    ['- parent\n  - [x] \t', '- parent\n- [x] \t'], ['1. parent\n    2) [ ] ', '1. parent\n2) [ ] '], ['> - ', '> ']
  ]) {
    const v = await view(doc, { anchor: doc.length });
    assert.equal(exitEmptyListItem(v), true, doc);
    assert.equal(v.state.doc.toString(), expected, doc);
  }
  const ordinary = await view('- text', { anchor: 2 });
  assert.equal(exitEmptyListItem(ordinary), false);
});

test('table Tab walks header/body cells, consumes the first Shift-Tab, and appends a row once', async () => {
  const { tableNextCell, tablePreviousCell } = await import('../src/editor/markdownTableNavigation.ts');
  const doc = '| A | B |\n| --- | --- |\n| x | y |';
  const v = await view(doc, { anchor: doc.indexOf('A') });
  assert.equal(tablePreviousCell(v), true); assert.equal(v.state.selection.main.head, doc.indexOf('A'));
  for (const text of ['B', 'x', 'y']) { assert.equal(tableNextCell(v), true); assert.equal(v.state.selection.main.head, v.state.doc.toString().indexOf(text)); }
  assert.equal(tableNextCell(v), true);
  assert.equal(v.state.doc.toString(), doc + '\n|  |  |');
  assert.equal(v.state.selection.main.head, v.state.doc.toString().indexOf('|  |  |') + 2);
  const { history, undo } = await import('@codemirror/commands');
  const { EditorState } = await import('@codemirror/state');
  const { ensureSyntaxTree } = await import('@codemirror/language');
  const { projectTable } = await import('../src/editor/markdownProjection.ts');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const parsed = await view(doc), baseTree = ensureSyntaxTree(parsed.state, doc.length, 500), tableNode = (() => { let found; baseTree.iterate({ enter(ref) { if (ref.name === 'Table') found = ref.node; } }); return found; })();
  const lastTable = projectTable(parsed.state, tableNode, baseTree), lastRow = (() => { let found; for (let child = tableNode.firstChild; child; child = child.nextSibling) if (child.name === 'TableRow') found = child; return found; })();
  for (const boundary of [lastTable.cells.at(-1).to, lastRow.to, parsed.state.doc.lineAt(lastRow.to).to]) {
    const atEnd = await view(doc, { anchor: boundary });
    atEnd.state = EditorState.create({ doc, selection: { anchor: boundary }, extensions: [markdownSyntax(), history()] });
    assert.equal(tableNextCell(atEnd), true, 'last cell/row/line end belongs to the final table row');
    assert.equal(atEnd.state.doc.toString(), doc + '\n|  |  |');
    assert.equal(undo(atEnd), true);
    assert.equal(atEnd.state.doc.toString(), doc, 'boundary row append undoes once');
  }
  const nextLine = await view(doc + '\n', { anchor: doc.length + 1 });
  assert.equal(tableNextCell(nextLine), false, 'the empty line after a table is outside it');
  const empty = '| A |\n| --- |', q = await view(empty, { anchor: empty.indexOf('A') });
  q.state = EditorState.create({ doc: empty, selection: { anchor: empty.indexOf('A') }, extensions: [(await import('../src/editor/markdownLanguage.ts')).markdownSyntax(), history()] });
  assert.equal(tableNextCell(q), true);
  assert.equal(q.state.doc.toString(), empty + '\n|  |');
  assert.equal(undo(q), true);
  assert.equal(q.state.doc.toString(), empty, 'row creation is one undo event');
  const ordered = '12. | A |\n    | --- |', orderedView = await view(ordered, { anchor: ordered.indexOf('A') });
  assert.equal(tableNextCell(orderedView), true);
  assert.equal(orderedView.state.doc.toString(), ordered + '\n    |  |', 'continuation indent matches the full ordered marker width');
  const quote = '> | A |\n> | --- |\n> | x |', quoted = await view(quote, { anchor: quote.indexOf('x') });
  assert.equal(tableNextCell(quoted), true);
  assert.equal(quoted.state.doc.toString(), quote + '\n> |  |');
  const separator = '| A | B |\n| --- | --- |\n| x | y |', middle = separator.indexOf('---'), onSeparator = await view(separator, { anchor: middle });
  assert.equal(tableNextCell(onSeparator), true); assert.equal(onSeparator.state.selection.main.head, separator.indexOf('x'));
  const backward = await view(separator, { anchor: middle });
  assert.equal(tablePreviousCell(backward), true); assert.equal(backward.state.selection.main.head, separator.indexOf('B'));
  const composing = await view(doc, { anchor: doc.indexOf('A') }); composing.composing = true;
  assert.equal(tableNextCell(composing), false, 'IME composition remains native');
  const readonly = await view(doc, { anchor: doc.indexOf('A') });
  readonly.state = EditorState.create({ doc, selection: { anchor: doc.indexOf('A') }, extensions: [(await import('../src/editor/markdownLanguage.ts')).markdownSyntax(), EditorState.readOnly.of(true)] });
  assert.equal(tableNextCell(readonly), false, 'read-only state is never changed');
  const nested = '- item\n\n  | a | b |\n  | --- | --- |\n  | x | y |', nestedView = await view(nested, { anchor: nested.indexOf('y') });
  assert.equal(tableNextCell(nestedView), true);
  assert.equal(nestedView.state.doc.toString(), nested + '\n  |  |  |');
  let tree = ensureSyntaxTree(nestedView.state, nestedView.state.doc.length, 500), listOwned = false;
  tree.iterate({ enter(ref) { if (ref.name === 'Table') for (let parent = ref.node.parent; parent; parent = parent.parent) if (parent.name === 'ListItem') listOwned = true; } });
  assert.equal(listOwned, true, 'appended row remains in its list item');
  const tabQuote = '>\t| a | b |\n>\t| --- | --- |\n>\t| x | y |', tabView = await view(tabQuote, { anchor: tabQuote.indexOf('y') });
  assert.equal(tableNextCell(tabView), true);
  assert.equal(tabView.state.doc.toString(), tabQuote + '\n>\t|  |  |', 'literal tab quote continuation survives');
  for (const [source, anchor, expected] of [
    ['a | b\n--- | ---\nx | y', 'y', 'a | b\n--- | ---\nx | y\n|  |  |'],
    ['a | b\n--- | ---\nx \\| y | z', 'z', 'a | b\n--- | ---\nx \\| y | z\n|  |  |'],
    ['> a | b\n> --- | ---\n> x | y', 'y', '> a | b\n> --- | ---\n> x | y\n> |  |  |'],
    ['- item\n\n  a | b\n  --- | ---\n  x | y', 'y', '- item\n\n  a | b\n  --- | ---\n  x | y\n  |  |  |']
  ]) {
    const sample = await view(source, { anchor: source.lastIndexOf(anchor) });
    assert.equal(tableNextCell(sample), true, source);
    assert.equal(sample.state.doc.toString(), expected);
    tree = ensureSyntaxTree(sample.state, sample.state.doc.length, 500);
    const tables = []; tree.iterate({ enter(ref) { if (ref.name === 'Table') tables.push(ref.node); } });
    assert.equal(tables.length, 1, 'appended row stays in the original table');
    const projection = projectTable(sample.state, tables[0], tree);
    assert.deepEqual(projection.cells.slice(0, 4).map(cell => cell.text), source.includes('\\|') ? ['a', 'b', 'x | y', 'z'] : ['a', 'b', 'x', 'y']);
  }
});

test('formatting plain brackets as a link never removes brackets as an unresolved reference', async () => {
  const { formatSourceSelection } = await import('../src/editor/markdownCommands.ts');
  const v = await view('[ordinary]', { anchor: 4 });
  formatSourceSelection(v, 'link');
  assert.ok(v.state.doc.toString().startsWith('[ord'), 'the original leading bracket remains');
  assert.ok(v.state.doc.toString().endsWith('inary]'), 'the original trailing bracket remains');
  assert.ok(v.state.doc.toString().includes('https://'), 'the command adds an actual link instead of unwrapping literal brackets');
});
test('inline formats toggle without serializing unrelated source', async () => {
  const { formatSourceSelection } = await import('../src/editor/markdownCommands.ts');
  for (const kind of ['bold', 'italic', 'strike', 'highlight', 'code']) {
    const v = await view('text'); formatSourceSelection(v, kind); formatSourceSelection(v, kind);
    assert.equal(v.state.doc.toString(), 'text', kind);
  }
});
test('table insertion preserves existing text and creates valid GFM delimiter row', async () => {
  const { formatSourceBlock } = await import('../src/editor/markdownCommands.ts');
  const v = await view('existing'); formatSourceBlock(v, 'table');
  assert.match(v.state.doc.toString(), /^existing\n\n\| 列一 \| 列二 \|\n\| --- \| --- \|/);
});

test('inline toggles recognize a caret, partial selection and selected delimiters', async () => {
  const { formatSourceSelection } = await import('../src/editor/markdownCommands.ts');
  for (const [kind, marker] of [['bold', '**'], ['italic', '*'], ['strike', '~~'], ['highlight', '=='], ['code', '`']]) {
    const doc = 'prefix ' + marker + 'word' + marker + ' suffix', start = 7 + marker.length;
    for (const selection of [{ anchor: start + 2 }, { anchor: start + 1, head: start + 3 }, { anchor: 7, head: start + 4 + marker.length }, { anchor: start + 3, head: start + 1 }]) {
      const v = await view(doc, selection); formatSourceSelection(v, kind);
      assert.equal(v.state.doc.toString(), 'prefix word suffix', kind);
      assert.equal(v.state.selection.main.anchor > v.state.selection.main.head, (selection.head ?? selection.anchor) < selection.anchor, 'keep selection direction');
    }
    const empty = await view('word', { anchor: 2 });
    formatSourceSelection(empty, kind); formatSourceSelection(empty, kind);
    assert.equal(empty.state.doc.toString(), 'word', kind + ' empty placeholder');
    assert.equal(empty.state.selection.main.head, 2);
  }
});

test('nested emphasis toggles only the requested style, not literal delimiters', async () => {
  const { formatSourceSelection } = await import('../src/editor/markdownCommands.ts');
  for (const [kind, expected] of [['bold', '*word*'], ['italic', '**word**']]) {
    const v = await view('***word***', { anchor: 5 }); formatSourceSelection(v, kind);
    assert.equal(v.state.doc.toString(), expected);
  }
  const bold = await view('**word**', { anchor: 2, head: 6 });
  formatSourceSelection(bold, 'italic'); assert.equal(bold.state.doc.toString(), '***word***');
  formatSourceSelection(bold, 'italic'); assert.equal(bold.state.doc.toString(), '**word**');
  for (const doc of ['`**word**`', '\\*word*']) {
    const v = await view(doc, { anchor: doc.indexOf('word') + 2 });
    formatSourceSelection(v, 'bold'); formatSourceSelection(v, 'bold');
    assert.equal(v.state.doc.toString(), doc);
  }
  for (const doc of ['`**word**`', '```\n**word**\n```']) {
    const start = doc.indexOf('word'), v = await view(doc, { anchor: start, head: start + 4 });
    formatSourceSelection(v, 'bold');
    assert.equal(v.state.doc.toString(), doc, 'formatting inside code never removes literal delimiters');
  }
});

test('links and inline code containing backticks toggle without nesting or changing content', async () => {
  const { formatSourceSelection } = await import('../src/editor/markdownCommands.ts');
  const link = await view('word'); formatSourceSelection(link, 'link'); formatSourceSelection(link, 'link');
  assert.equal(link.state.doc.toString(), 'word');
  const caret = await view('[word](https://example.com)', { anchor: 3 }); formatSourceSelection(caret, 'link');
  assert.equal(caret.state.doc.toString(), 'word');
  for (const content of ['a`b', '`word`', ' word ']) {
    const v = await view(content); formatSourceSelection(v, 'code'); formatSourceSelection(v, 'code');
    assert.equal(v.state.doc.toString(), content);
  }
});

test('second Enter exits an empty indent without leaving a Tab or spaces on the new line', async () => {
  const { exitEmptyIndent } = await import('../src/editor/markdownCommands.ts');
  const { insertNewlineContinueMarkup } = await import('@codemirror/lang-markdown');
  const { insertNewlineAndIndent } = await import('@codemirror/commands');
  const { indentUnit } = await import('@codemirror/language');
  const { EditorState } = await import('@codemirror/state');
  for (const indent of ['\t', '\t\t', '    ', '        ', ' \t  ']) {
    const doc = indent + 'text', v = await view(doc, { anchor: doc.length });
    v.state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [
      (await import('../src/editor/markdownLanguage.ts')).markdownSyntax(), indentUnit.of('\t'), EditorState.tabSize.of(4)
    ] });
    // CodeMirror's StateCommands destructure dispatch, unlike ViewCommands.
    v.dispatch = spec => { v.state = v.state.update(spec).state; };
    const enter = () => exitEmptyIndent(v) || insertNewlineContinueMarkup(v) || insertNewlineAndIndent(v);
    assert.equal(exitEmptyIndent(v), false, 'the first Enter still continues a nonempty indented line');
    enter();
    assert.match(v.state.doc.lineAt(v.state.selection.main.head).text, /^[\t ]+$/);
    assert.equal(exitEmptyIndent(v), true);
    assert.equal(v.state.doc.toString(), doc + '\n\n', JSON.stringify(indent));
    assert.equal(v.state.selection.main.head, v.state.doc.line(v.state.doc.lines).from);
    v.dispatch({ changes: { from: v.state.selection.main.head, insert: 'next' } });
    assert.equal(v.state.doc.toString(), doc + '\n\nnext', 'new text starts at column zero');
  }
});

test('empty indent exit preserves fenced code, nested containers, selections and mid-line carets', async () => {
  const { exitEmptyIndent } = await import('../src/editor/markdownCommands.ts');
  for (const doc of ['```text\n\tcode\n\t\n```', '~~~\n  code\n  \n~~~', '- parent\n\tcontinuation\n\t\n\tmore', '> quoted\n>\t', '<pre>\n\t\n</pre>']) {
    const anchor = doc.lastIndexOf('\t') >= 0 ? doc.lastIndexOf('\t') + 1 : doc.indexOf('\n  \n') + 3;
    const v = await view(doc, { anchor });
    assert.equal(exitEmptyIndent(v), false, doc);
    assert.equal(v.state.doc.toString(), doc);
  }
  for (const [doc, selection] of [
    ['text\n', { anchor: 5 }], ['text\n  ', { anchor: 6 }], ['text\n\t', { anchor: 5, head: 6 }],
    ['text\n\t', { ranges: [{ anchor: 0 }, { anchor: 6 }], mainIndex: 1 }]
  ]) {
    const { EditorSelection, EditorState } = await import('@codemirror/state');
    const v = await view(doc, selection.ranges ? { anchor: 0 } : selection);
    if (selection.ranges) v.state = EditorState.create({ doc, selection: EditorSelection.create(selection.ranges.map(r => EditorSelection.cursor(r.anchor)), selection.mainIndex), extensions: [EditorState.allowMultipleSelections.of(true), (await import('../src/editor/markdownLanguage.ts')).markdownSyntax()] });
    assert.equal(exitEmptyIndent(v), false, doc);
  }
});
