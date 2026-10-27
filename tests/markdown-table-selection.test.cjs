require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function view(doc, selection) {
  const { EditorState } = await import('@codemirror/state');
  const { history } = await import('@codemirror/commands');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const target = {
    state: EditorState.create({ doc, selection, extensions: [markdownSyntax(), history()] }),
    focus() {},
  };
  target.dispatch = spec => { target.state = target.state.update(spec).state; };
  return target;
}

test('selected text in one table cell navigates in either direction without changing source', async () => {
  const { tableNextCell, tablePreviousCell } = await import('../src/editor/markdownTableNavigation.ts');
  const doc = '| alpha | beta |\n| --- | --- |\n| gamma | delta |';
  const start = doc.indexOf('alpha'), end = start + 'alpha'.length;

  for (const selection of [{ anchor: start, head: end }, { anchor: end, head: start }]) {
    const next = await view(doc, selection);
    assert.equal(tableNextCell(next), true);
    assert.equal(next.state.doc.toString(), doc);
    assert.deepEqual([next.state.selection.main.anchor, next.state.selection.main.head], [doc.indexOf('beta'), doc.indexOf('beta')]);

    const previousStart = doc.indexOf('beta'), previousEnd = previousStart + 'beta'.length;
    for (const previousSelection of [{ anchor: previousStart, head: previousEnd }, { anchor: previousEnd, head: previousStart }]) {
      const previous = await view(doc, previousSelection);
      assert.equal(tablePreviousCell(previous), true);
      assert.equal(previous.state.doc.toString(), doc);
      assert.deepEqual([previous.state.selection.main.anchor, previous.state.selection.main.head], [doc.indexOf('alpha'), doc.indexOf('alpha')]);
    }
  }
});

test('selected cell navigation uses UTF-16 offsets and supports escaped source pipes', async () => {
  const { tableNextCell } = await import('../src/editor/markdownTableNavigation.ts');
  const doc = '| 😀 word | escaped \\| pipe |\n| --- | --- |\n| body | next |';
  const start = doc.indexOf('😀'), end = start + '😀'.length;
  const emoji = await view(doc, { anchor: start, head: end });
  assert.equal(tableNextCell(emoji), true);
  assert.deepEqual([emoji.state.selection.main.anchor, emoji.state.selection.main.head], [doc.indexOf('escaped'), doc.indexOf('escaped')]);

  const pipe = doc.indexOf('\\|'), selectedPipe = await view(doc, { anchor: pipe, head: pipe + 2 });
  assert.equal(tableNextCell(selectedPipe), true);
  assert.equal(selectedPipe.state.doc.toString(), doc);
  assert.deepEqual([selectedPipe.state.selection.main.anchor, selectedPipe.state.selection.main.head], [doc.indexOf('body'), doc.indexOf('body')]);
});

test('source padding, delimiter pipes, and selections crossing cells or rows stay with indentation fallback', async () => {
  const { tableNextCell, tablePreviousCell } = await import('../src/editor/markdownTableNavigation.ts');
  const doc = '|  alpha  | beta |\n| --- | --- |\n| gamma | delta |';
  const paddingStart = doc.indexOf('|') + 1;
  const padding = await view(doc, { anchor: paddingStart, head: paddingStart + 1 });
  assert.equal(tableNextCell(padding), false, 'selection covers only source padding');

  const pipe = doc.indexOf('|', doc.indexOf('alpha'));
  const selectedPipe = await view(doc, { anchor: pipe, head: pipe + 1 });
  assert.equal(tableNextCell(selectedPipe), false, 'selection includes a real cell delimiter');

  const alpha = doc.indexOf('alpha'), beta = doc.indexOf('beta');
  const acrossCells = await view(doc, { anchor: alpha, head: beta + 'beta'.length });
  assert.equal(tableNextCell(acrossCells), false, 'selection spans adjacent cells in one row');

  const acrossRows = await view(doc, { anchor: alpha, head: doc.indexOf('gamma') + 2 });
  assert.equal(tablePreviousCell(acrossRows), false, 'selection spans rows');

  const emptyDoc = '| left |  | right |\n| --- | --- | --- |\n| a | b | c |';
  const emptyPadding = emptyDoc.indexOf('  |');
  const emptyCell = await view(emptyDoc, { anchor: emptyPadding, head: emptyPadding + 1 });
  assert.equal(tableNextCell(emptyCell), false, 'padding in a real empty cell is not selected cell text');
});

test('selecting the last header cell then pressing Tab reaches the first body cell', async () => {
  const { tableNextCell } = await import('../src/editor/markdownTableNavigation.ts');
  const doc = '| first | final |\n| --- | --- |\n| body | next |';
  const start = doc.indexOf('final');
  const v = await view(doc, { anchor: start, head: start + 'final'.length });
  assert.equal(tableNextCell(v), true);
  assert.equal(v.state.doc.toString(), doc);
  assert.deepEqual([v.state.selection.main.anchor, v.state.selection.main.head], [doc.indexOf('body'), doc.indexOf('body')]);
});

test('selecting the last body cell then Tab appends one undoable row', async () => {
  const { tableNextCell, tablePreviousCell } = await import('../src/editor/markdownTableNavigation.ts');
  const { undo } = await import('@codemirror/commands');
  const doc = '| a | b |\n| --- | --- |\n| x | final |';
  const start = doc.indexOf('final'), end = start + 'final'.length;
  const v = await view(doc, { anchor: start, head: end });
  assert.equal(tableNextCell(v), true);
  assert.equal(v.state.doc.toString(), doc + '\n|  |  |');
  assert.equal(undo(v), true);
  assert.equal(v.state.doc.toString(), doc, 'row append is undone in one step');

  const previous = await view(doc, { anchor: start, head: end });
  assert.equal(tablePreviousCell(previous), true);
  assert.equal(previous.state.doc.toString(), doc);
  assert.deepEqual([previous.state.selection.main.anchor, previous.state.selection.main.head], [doc.indexOf('x'), doc.indexOf('x')]);
});

test('selected-cell navigation declines during IME composition and in read-only state', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { tableNextCell } = await import('../src/editor/markdownTableNavigation.ts');
  const doc = '| alpha | beta |\n| --- | --- |\n| x | y |';
  const start = doc.indexOf('alpha'), selection = { anchor: start, head: start + 'alpha'.length };
  const composing = await view(doc, selection);
  composing.composing = true;
  assert.equal(tableNextCell(composing), false);

  const readonly = await view(doc, selection);
  readonly.state = EditorState.create({ doc, selection, extensions: [EditorState.readOnly.of(true)] });
  assert.equal(tableNextCell(readonly), false);
});
