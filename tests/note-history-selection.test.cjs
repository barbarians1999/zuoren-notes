require('./typescript-loader.cjs');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let EditorState, EditorSelection, Transaction, indentUnit, undoDepth, redoDepth, isolateHistory;
let NoteDocument, undoNoteView, redoNoteView, markdownSyntax, keyHabitsTab, markdownHistory;
before(async () => {
  ({ EditorState, EditorSelection, Transaction } = await import('@codemirror/state'));
  ({ indentUnit } = await import('@codemirror/language'));
  ({ undoDepth, redoDepth, isolateHistory } = await import('@codemirror/commands'));
  ({ NoteDocument, undoNoteView, redoNoteView } = await import('../src/workspace/noteDocument.ts'));
  ({ markdownSyntax } = await import('../src/editor/markdownLanguage.ts'));
  ({ keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts'));
  ({ markdownHistory } = await import('../src/editor/markdownFormatHistory.ts'));
});
function fixture(source) {
  const events = { edits: 0, notifications: 0 };
  const note = { path: 'C:\\notes\\history.md', content: source, hash: 'base', bom: false, eol: '\n' };
  const document = new NoteDocument(note, 'history-fixture', () => ({}), { has: () => false },
    () => events.notifications++, () => events.edits++, () => {});
  document.ready = true;
  function mount(position = 0) {
    const tab = { id: String(document.views.size), document, preview: false, mode: 'edit',
      selection: EditorSelection.cursor(position), scroll: { edit: 0, preview: 0 } };
    const view = { composing: false, state: EditorState.create({ doc: document.state.doc, selection: tab.selection,
      extensions: [markdownSyntax(), indentUnit.of('\t'), EditorState.tabSize.of(4), EditorState.allowMultipleSelections.of(true)] }),
    update(transactions) { for (const transaction of transactions) this.state = transaction.state; },
    dispatch(spec) { document.dispatch(view, [view.state.update(spec)]); } };
    document.views.add(tab); view.detach = document.attach(view, tab);
    return view;
  }
  return { document, events, mount };
}
const caret = view => view.state.selection.main.head;
function select(view, selection) { view.dispatch({ selection: typeof selection === 'number' ? { anchor: selection } : selection }); }
function type(view, insert, isolated = true) {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type',
    annotations: isolated ? isolateHistory.of('full') : [] });
}
function sameSelection(actual, expected) { assert.ok(actual.eq(expected), JSON.stringify({ actual: actual.toJSON(), expected: expected.toJSON() })); }

test('rapid Tab no-op and typing undo/redo restore the active pane caret, not document position zero', () => {
  const source = '- Parent\n  - First child\n  - Child motion\n';
  const { document, mount } = fixture(source), view = mount(), other = mount(5);
  select(view, 33);
  assert.equal(keyHabitsTab(1)(view), true); assert.equal(caret(view), 34);
  const indented = document.text;
  assert.equal(keyHabitsTab(1)(view), true); assert.equal(document.text, indented);
  assert.equal(undoDepth(document.state), 1, 'rejected extra indentation creates no undo entry');
  select(view, view.state.doc.lineAt(caret(view)).to); assert.equal(caret(view), 42);
  type(view, '!'); assert.equal(caret(view), 43);
  assert.equal(undoNoteView(view), true); assert.equal(document.text, indented); assert.equal(caret(view), 42);
  assert.equal(undoNoteView(view), true); assert.equal(document.text, source); assert.equal(caret(view), 33);
  assert.equal(redoNoteView(view), true); assert.equal(document.text, indented); assert.equal(caret(view), 34);
  assert.equal(caret(other), 5); assert.equal(other.state.doc.toString(), document.text);
  assert.equal(undoDepth(document.state), 1); assert.equal(redoDepth(document.state), 1);
});

test('Shift-Tab restores a reversed UTF-16 selection in one undo step', () => {
  const source = '\t😀第一行\n\t第二行';
  const { document, mount } = fixture(source), view = mount(), other = mount(0);
  const before = EditorSelection.single(source.length, 1); select(view, before);
  assert.equal(keyHabitsTab(-1)(view), true); const after = view.state.selection;
  assert.equal(document.text, '😀第一行\n第二行'); assert.equal(undoDepth(document.state), 1);
  assert.equal(undoNoteView(view), true); assert.equal(document.text, source); sameSelection(view.state.selection, before);
  assert.equal(redoNoteView(view), true); sameSelection(view.state.selection, after); assert.equal(caret(other), 0);
});

test('each pane contributes its own selection to shared history without moving the other pane', () => {
  const { document, mount } = fixture('abcdefghij'), left = mount(), right = mount();
  select(left, 3); type(left, 'L'); select(right, 8); type(right, 'R');
  assert.equal(caret(left), 4); assert.equal(caret(right), 9);
  assert.equal(undoNoteView(right), true); assert.equal(document.text, 'abcLdefghij'); assert.equal(caret(right), 8); assert.equal(caret(left), 4);
  assert.equal(undoNoteView(left), true); assert.equal(document.text, 'abcdefghij'); assert.equal(caret(left), 3); assert.equal(caret(right), 7);
  assert.equal(redoNoteView(left), true); assert.equal(caret(left), 4); assert.equal(caret(right), 8);
  assert.equal(redoNoteView(right), true); assert.equal(document.text, 'abcLdefgRhij'); assert.equal(caret(right), 9); assert.equal(caret(left), 4);
});

test('moving the active caret does not create an edit, and redo returns to the edit position', () => {
  const { document, events, mount } = fixture('abcdefghij'), view = mount(), other = mount(1);
  select(view, 3); type(view, '!'); select(view, 9);
  const revision = document.revision, edits = events.edits;
  assert.equal(undoDepth(document.state), 1); assert.equal(undoNoteView(view), true);
  assert.equal(caret(view), 3); assert.equal(caret(other), 1);
  assert.equal(redoNoteView(view), true); assert.equal(caret(view), 4);
  assert.equal(document.revision, revision + 2); assert.equal(events.edits, edits + 2);
  assert.equal(undoDepth(document.state), 1); assert.equal(redoDepth(document.state), 0);
});

test('multiple UTF-16 ranges and main index match native CodeMirror undo and redo', async () => {
  const { document, mount } = fixture('😀abcdefghi'), view = mount(), other = mount(0);
  const before = EditorSelection.create([EditorSelection.range(4, 2), EditorSelection.cursor(8)], 1);
  select(view, before);
  const transaction = view.state.update(view.state.changeByRange(range => ({ changes: { from: range.from, to: range.to, insert: '中' },
    range: EditorSelection.cursor(range.from + 1) })));
  let reference = EditorState.create({ doc: document.text, selection: before,
    extensions: [markdownHistory(), EditorState.allowMultipleSelections.of(true)] });
  reference = reference.update({ changes: transaction.changes, selection: transaction.newSelection }).state;
  const { undo, redo } = await import('@codemirror/commands');
  const run = command => command({ state: reference, dispatch: transaction => { reference = transaction.state; } });
  document.dispatch(view, [transaction]); const changed = document.text;
  assert.equal(undoNoteView(view), true); sameSelection(view.state.selection, before); assert.equal(document.text, '😀abcdefghi');
  assert.equal(run(undo), true); sameSelection(view.state.selection, reference.selection);
  assert.equal(redoNoteView(view), true); assert.equal(run(redo), true);
  sameSelection(view.state.selection, reference.selection); assert.equal(document.text, changed);
  assert.equal(caret(other), 0);
});

test('selection synchronization preserves adjacent typing grouping and no-origin history commands', async () => {
  const { document, events, mount } = fixture('body'), view = mount();
  const revision = document.revision, edited = events.edits; select(view, 4);
  assert.equal(document.revision, revision); assert.equal(events.edits, edited); assert.equal(undoDepth(document.state), 0);
  type(view, 'a', false); type(view, 'b', false); assert.equal(undoDepth(document.state), 1);
  const { undo, redo } = await import('@codemirror/commands');
  assert.equal(document.runHistory(undo), true); assert.equal(document.text, 'body');
  assert.equal(document.runHistory(redo), true); assert.equal(document.text, 'bodyab');
  assert.equal(undoDepth(document.state), 1);
});
