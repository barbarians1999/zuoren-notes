require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function setup(doc, selection, shared = false) {
  const { EditorState, EditorSelection } = await import('@codemirror/state');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const { markdownTypedFormatHandlers } = await import('../src/editor/markdownTypedFormat.ts');
  const extensions = [markdownSyntax(), EditorState.allowMultipleSelections.of(true)];
  let noteDocument;
  if (shared) {
    const { NoteDocument } = await import('../src/workspace/noteDocument.ts');
    const note = { content: doc, path: 'C:\\notes\\typed.md', hash: 'base', bom: false, eol: '\n' };
    noteDocument = new NoteDocument(note, 'recovery', () => ({}), { has: () => false }, () => {}, () => {}, () => {});
    noteDocument.ready = true;
    noteDocument.views.add({ id: 'tab', document: noteDocument, preview: false, mode: 'edit', selection: EditorSelection.cursor(0), scroll: { edit: 0, preview: 0 } });
  }
  let state = EditorState.create({ doc: shared ? noteDocument.state.doc : doc, selection, extensions }), handlers;
  const updateSignal = transaction => ({ docChanged: transaction.docChanged,
    selectionSet: !transaction.startState.selection.eq(transaction.newSelection), transactions: [transaction] });
  const view = {
    get state() { return state; }, set state(value) { state = value; }, composing: false,
    dispatch(transaction) {
      if (shared) noteDocument.dispatch(view, [transaction]);
      else { state = transaction.state || state.update(transaction).state; handlers?.update(updateSignal(transaction)); }
    },
    update(transactions) { for (const transaction of transactions) { state = transaction.state; handlers?.update(updateSignal(transaction)); } },
  };
  if (shared) noteDocument.attach(view, [...noteDocument.views][0]);
  handlers = markdownTypedFormatHandlers(() => noteDocument ? `${noteDocument.documentId.current}:tab` : '1:tab');
  return { view, handlers, noteDocument };
}

function press(handlers, view, key, extra = {}) {
  let prevented = false;
  const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false,
    preventDefault() { prevented = true; }, ...extra };
  return { handled: handlers.keydown(event, view), prevented };
}

test('formatting a selection crossing a fenced block preserves its delimiters', async () => {
  const doc = 'before\n\n```js\ninside\n```\nafter';
  const { view, handlers } = await setup(doc, { anchor: 0, head: doc.indexOf('```\nafter') + 3 });
  const result = press(handlers, view, '*');
  assert.equal(result.prevented, true); assert.equal(view.state.doc.toString(), doc);
  const { formatSelection } = await import('../src/editor/markdownCommands.ts');
  assert.equal(formatSelection(view.state, 'bold'), null);
});

test('typed asterisk shows italic immediately, then commits bold as one shared undo event', async () => {
  const { undo, redo } = await import('@codemirror/commands');
  const { view, handlers, noteDocument } = await setup('word', { anchor: 0, head: 4 }, true);
  assert.deepEqual(press(handlers, view, '*'), { handled: true, prevented: true });
  assert.equal(noteDocument.text, '*word*');
  assert.deepEqual(press(handlers, view, '*'), { handled: true, prevented: true });
  assert.equal(noteDocument.text, '**word**');
  assert.equal(noteDocument.revision, 2, 'the first key is a normal document edit, not delayed work');
  assert.equal(undoNote(noteDocument, view, undo), true);
  assert.equal(noteDocument.text, 'word', 'both key presses undo together');
  assert.equal(redoNote(noteDocument, view, redo), true);
  assert.equal(noteDocument.text, '**word**');
});

test('four identical keys are two undoable format operations, and later typing stays separate', async () => {
  const { undo } = await import('@codemirror/commands');
  const { Transaction } = await import('@codemirror/state');
  const { view, handlers, noteDocument } = await setup('word', { anchor: 0, head: 4 }, true);
  for (let i = 0; i < 4; i++) press(handlers, view, '*');
  assert.equal(noteDocument.text, 'word', 'two bold toggles return to the original source');
  view.dispatch(view.state.update({ changes: { from: 4, insert: '!' }, annotations: Transaction.userEvent.of('input.type') }));
  assert.equal(noteDocument.text, 'word!');
  assert.equal(noteDocument.runHistory(undo, view), true); assert.equal(noteDocument.text, 'word');
  assert.equal(noteDocument.runHistory(undo, view), true); assert.equal(noteDocument.text, '**word**');
  assert.equal(noteDocument.runHistory(undo, view), true); assert.equal(noteDocument.text, 'word');
});

function undoNote(document, view, command) { return document.runHistory(command, view); }
function redoNote(document, view, command) { return document.runHistory(command, view); }

test('typing the same format toggles it off and keeps backward selection direction', async () => {
  const { view, handlers } = await setup('**word**', { anchor: 6, head: 2 });
  press(handlers, view, '*'); press(handlers, view, '*');
  assert.equal(view.state.doc.toString(), 'word');
  assert.ok(view.state.selection.main.anchor > view.state.selection.main.head);

  const strike = await setup('~~word~~', { anchor: 6, head: 2 });
  press(strike.handlers, strike.view, '~'); assert.equal(press(strike.handlers, strike.view, '~').handled, true);
  assert.equal(strike.view.state.doc.toString(), 'word');
  const plain = await setup('word', { anchor: 0, head: 4 });
  press(plain.handlers, plain.view, '~'); assert.equal(plain.view.state.doc.toString(), '~word~');
  press(plain.handlers, plain.view, '~'); assert.equal(plain.view.state.doc.toString(), '~~word~~');
});

test('single backtick toggles code, preserves UTF-16 selection offsets, and stays literal at an empty caret', async () => {
  const text = '中😀文', { view, handlers } = await setup(text, { anchor: text.length, head: 0 });
  press(handlers, view, '`');
  assert.equal(view.state.doc.toString(), '`中😀文`');
  assert.equal(view.state.selection.main.anchor, text.length + 1);
  assert.equal(view.state.selection.main.head, 1);
  const empty = await setup('abc', { anchor: 1 });
  assert.equal(press(empty.handlers, empty.view, '*').handled, false);
  assert.equal(press(empty.handlers, empty.view, '~').handled, false);
  assert.deepEqual(press(empty.handlers, empty.view, '`'), { handled: true, prevented: true });
  assert.equal(empty.view.state.doc.toString(), 'a`bc', 'no partner delimiter is inserted');
});

test('each selected backtick is a full code toggle with its own shared undo event', async () => {
  const { undo, redo } = await import('@codemirror/commands');
  const text = '中😀文', { view, handlers, noteDocument } = await setup(text, { anchor: 0, head: text.length }, true);
  press(handlers, view, '`');
  assert.equal(noteDocument.text, '`中😀文`');
  assert.equal(noteDocument.runHistory(undo, view), true); assert.equal(noteDocument.text, text);
  assert.equal(noteDocument.runHistory(redo, view), true); assert.equal(noteDocument.text, '`中😀文`');
  const reselection = view.state.update({ selection: { anchor: 1, head: 5 } }); view.state = reselection.state; handlers.update(reselection);
  press(handlers, view, '`'); assert.equal(noteDocument.text, text, 'the second key cancels the existing code mark');
  assert.equal(noteDocument.runHistory(undo, view), true); assert.equal(noteDocument.text, '`中😀文`');

  const inline = await setup('`word`', { anchor: 1, head: 5 });
  press(inline.handlers, inline.view, '`'); assert.equal(inline.view.state.doc.toString(), 'word');
  press(inline.handlers, inline.view, '`'); assert.equal(inline.view.state.doc.toString(), '`word`');
});

test('code blocks, IME, read-only state, and multiple selections keep their normal input path', async () => {
  const code = '```\nword\n```', start = code.indexOf('word'), block = await setup(code, { anchor: start, head: start + 4 });
  assert.deepEqual(press(block.handlers, block.view, '*'), { handled: false, prevented: false });
  assert.equal(block.view.state.doc.toString(), code);
  assert.deepEqual(press(block.handlers, block.view, '`'), { handled: true, prevented: true });
  assert.equal(block.view.state.doc.toString(), '```\n`\n```', 'code-area typing is literal');

  const ime = await setup('word', { anchor: 0, head: 4 });
  assert.equal(press(ime.handlers, ime.view, '*', { isComposing: true }).handled, false);
  const { EditorState, EditorSelection } = await import('@codemirror/state');
  const multiple = await setup('word', { anchor: 0, head: 4 });
  multiple.view.state = EditorState.create({ doc: 'word', selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(2, 4)]), extensions: [EditorState.allowMultipleSelections.of(true)] });
  assert.equal(press(multiple.handlers, multiple.view, '*').handled, false);
  const readOnly = await setup('word', { anchor: 0, head: 4 });
  readOnly.view.state = EditorState.create({ doc: 'word', selection: { anchor: 0, head: 4 }, extensions: [EditorState.readOnly.of(true)] });
  assert.equal(press(readOnly.handlers, readOnly.view, '*').handled, false);
});

test('continuation survives a pause, while first keys alone and later edits form separate undo events', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { markdownHistory } = await import('../src/editor/markdownFormatHistory.ts');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const { undo } = await import('@codemirror/commands');
  const { view, handlers, noteDocument } = await setup('word', { anchor: 0, head: 4 }, true);
  const originalNow = Date.now; let time = 1000; Date.now = () => time;
  try { press(handlers, view, '*'); time += 2000; press(handlers, view, '*'); }
  finally { Date.now = originalNow; }
  assert.equal(noteDocument.runHistory(undo, view), true);
  assert.equal(noteDocument.text, 'word', 'the 500 ms grouping window does not split the format pair');

  let state = EditorState.create({ doc: 'word', selection: { anchor: 0, head: 4 }, extensions: [markdownSyntax(), markdownHistory()] });
  const fake = { get state() { return state; }, dispatch(spec) { state = spec.state || state.update(spec).state; } };
  const solo = (await import('../src/editor/markdownTypedFormat.ts')).markdownTypedFormatHandlers(() => '1:tab');
  press(solo, fake, '*');
  assert.equal(undo(fake), true); assert.equal(state.doc.toString(), 'word', 'one key still creates a normal undo event');
});

test('selection and document identity changes invalidate a pending first key; paste is not keyboard input', async () => {
  const { view, handlers } = await setup('word', { anchor: 0, head: 4 });
  press(handlers, view, '*');
  handlers.paste({});
  press(handlers, view, '*');
  assert.equal(view.state.doc.toString(), 'word', 'the key after a paste starts a new operation instead of completing bold');
  const moved = view.state.update({ selection: { anchor: 1, head: 3 } });
  view.state = moved.state; handlers.update({ docChanged: moved.docChanged, selectionSet: !moved.startState.selection.eq(moved.newSelection), transactions: [moved] });
  press(handlers, view, '*');
  const replaced = view.state.update({ changes: { from: 0, to: view.state.doc.length, insert: 'other' }, selection: { anchor: 0, head: 5 } });
  view.state = replaced.state; handlers.update({ docChanged: replaced.docChanged, selectionSet: !replaced.startState.selection.eq(replaced.newSelection), transactions: [replaced] });
  press(handlers, view, '*');
  assert.equal(view.state.doc.toString(), '*other*', 'a different document cannot continue the old pair');
});

test('selected formatting waits for a complete paragraph parse before changing source', async () => {
  const { markdownTypedFormatHandlers } = await import('../src/editor/markdownTypedFormat.ts');
  for (const [doc, from, to, expected] of [
    ['**' + 'x'.repeat(4000) + '**\n\nnext', 12, 24, 'x'.repeat(4000) + '\n\nnext'],
    ['**first line\nsecond line**\n\nnext', 2, 7, 'first line\nsecond line\n\nnext'],
  ]) {
    const sample = await setup(doc, { anchor: from, head: to });
    press(sample.handlers, sample.view, '*'); press(sample.handlers, sample.view, '*');
    assert.equal(sample.view.state.doc.toString(), expected, 'the closing mark may be far away or on another line');
  }

  const timeout = await setup('selected text', { anchor: 0, head: 8 });
  let message = '', parseCalls = 0;
  const handlers = markdownTypedFormatHandlers(() => 'doc:tab', text => { message = text; }, () => { parseCalls++; return null; });
  const before = timeout.view.state;
  assert.deepEqual(press(handlers, timeout.view, '*'), { handled: true, prevented: true });
  assert.equal(timeout.view.state, before, 'a parse timeout leaves the document and selection untouched');
  assert.equal(message, '文档仍在解析，请稍后重试'); assert.equal(parseCalls, 1);

  const empty = await setup('word', { anchor: 2 });
  let emptyParses = 0;
  const literal = markdownTypedFormatHandlers(() => 'doc:tab', () => assert.fail('empty input should not report parser delay'), () => { emptyParses++; return null; });
  assert.equal(press(literal, empty.view, '*').handled, false);
  assert.equal(press(literal, empty.view, '`').handled, true);
  assert.equal(emptyParses, 0, 'empty caret typing does not depend on syntax parsing');
});

test('a changed shared document id cannot continue the previous note operation', async () => {
  const { view } = await setup('word', { anchor: 0, head: 4 });
  let identity = '14:tab-one';
  const { markdownTypedFormatHandlers } = await import('../src/editor/markdownTypedFormat.ts');
  const handlers = markdownTypedFormatHandlers(() => identity);
  press(handlers, view, '*'); identity = '14:tab-two';
  press(handlers, view, '*');
  assert.equal(view.state.doc.toString(), 'word', 'the same document in another tab starts a fresh toggle');
});

test('selection leave-and-return, undo/redo, composition, and external shared edits clear pending state', async () => {
  const { undo, redo } = await import('@codemirror/commands');
  const select = await setup('word', { anchor: 0, head: 4 });
  press(select.handlers, select.view, '*');
  const away = select.view.state.update({ selection: { anchor: 0 } }); select.view.state = away.state; select.handlers.update({ docChanged: away.docChanged, selectionSet: !away.startState.selection.eq(away.newSelection), transactions: [away] });
  const back = select.view.state.update({ selection: { anchor: 1, head: 5 } }); select.view.state = back.state; select.handlers.update({ docChanged: back.docChanged, selectionSet: !back.startState.selection.eq(back.newSelection), transactions: [back] });
  press(select.handlers, select.view, '*');
  assert.equal(select.view.state.doc.toString(), 'word', 'returning to the same selection cannot revive a cleared pair');

  const reconfigured = await setup('word', { anchor: 0, head: 4 });
  press(reconfigured.handlers, reconfigured.view, '*');
  reconfigured.handlers.update({ docChanged: false, selectionSet: false, transactions: [{ reconfigured: true }] });
  press(reconfigured.handlers, reconfigured.view, '*');
  assert.equal(reconfigured.view.state.doc.toString(), 'word', 'a compartment or state reconfiguration clears pending state');

  const history = await setup('word', { anchor: 0, head: 4 }, true);
  press(history.handlers, history.view, '*'); history.noteDocument.runHistory(undo, history.view); history.noteDocument.runHistory(redo, history.view);
  history.view.state = history.view.state.update({ selection: { anchor: 1, head: 5 } }).state;
  press(history.handlers, history.view, '*');
  assert.equal(history.noteDocument.text, 'word', 'undo and redo invalidate the pending key');
  history.handlers.compositionstart({});
  press(history.handlers, history.view, '*');
  assert.equal(history.noteDocument.text, '*word*');

  const external = await setup('word', { anchor: 0, head: 4 }, true);
  press(external.handlers, external.view, '*');
  const { EditorSelection, Transaction } = await import('@codemirror/state');
  const tab = { id: 'other-tab', document: external.noteDocument, preview: false, mode: 'edit', selection: EditorSelection.cursor(4), scroll: { edit: 0, preview: 0 } };
  external.noteDocument.views.add(tab);
  let otherState = external.noteDocument.state.update({ selection: { anchor: 4 } }).state;
  const otherView = { get state() { return otherState; }, update(transactions) { for (const transaction of transactions) otherState = transaction.state; } };
  external.noteDocument.attach(otherView, tab);
  const externalChange = otherState.update({ changes: { from: 4, insert: '!' }, annotations: Transaction.userEvent.of('input.type') });
  external.noteDocument.dispatch(otherView, [externalChange]);
  press(external.handlers, external.view, '*');
  assert.equal(external.noteDocument.text, 'wor!d', 'an edit arriving from another view invalidates the pair');
});

test('Backspace remains native around empty placeholders', async () => {
  const { view, handlers } = await setup('**', { anchor: 1 });
  assert.equal(press(handlers, view, 'Backspace').handled, false);
  view.state = view.state.update({ changes: { from: 0, to: 2, insert: '*' }, selection: { anchor: 1 } }).state;
  assert.equal(view.state.doc.toString(), '*');
});
