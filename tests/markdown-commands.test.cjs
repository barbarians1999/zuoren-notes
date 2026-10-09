require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
async function view(doc, selection = { anchor: 0, head: doc.length }) {
  const { EditorState } = await import('@codemirror/state');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  return { state: EditorState.create({ doc, selection, extensions: [markdownSyntax()] }), dispatch(spec) { this.state = this.state.update(spec).state; }, focus() {} };
}
test('ordered/task/list commands toggle all selected lines and retain indentation', async () => {
  const { formatSourceBlock } = await import('../src/editor/markdownCommands.ts');
  for (const kind of ['ordered', 'task', 'bullet', 'quote', 'heading']) {
    const v = await view('one\n  two');
    formatSourceBlock(v, kind); formatSourceBlock(v, kind);
    assert.equal(v.state.doc.toString(), 'one\n  two', kind);
  }
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
