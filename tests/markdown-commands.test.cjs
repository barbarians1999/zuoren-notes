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
