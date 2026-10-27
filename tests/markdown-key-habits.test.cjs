require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function view(doc, selection = { anchor: doc.length }, extra = []) {
  const { EditorState } = await import('@codemirror/state');
  const { history } = await import('@codemirror/commands');
  const { indentUnit } = await import('@codemirror/language');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const target = {
    state: EditorState.create({ doc, selection, extensions: [markdownSyntax(), history(), indentUnit.of('\t'), EditorState.tabSize.of(4), ...extra] }),
    focus() {},
  };
  target.dispatch = spec => {
    target.lastTransaction = spec.state ? spec : target.state.update(spec);
    target.state = target.lastTransaction.state;
  };
  return target;
}

test('fenced code Enter preserves the exact physical indentation and dedents blank lines by four columns', async () => {
  const { keyHabitsEnter } = await import('../src/editor/markdownKeyHabits.ts');
  const { insertNewlineAndIndent } = await import('@codemirror/commands');
  const newline = '\n';
  for (const indent of ['    ', '\t']) {
    const doc = ['```', `${indent}alpha beta`, '```'].join(newline), cursor = doc.indexOf('alpha') + 3;
    const v = await view(doc, { anchor: cursor });
    assert.equal(keyHabitsEnter(v), true);
    assert.equal(v.state.doc.toString(), ['```', `${indent}alp`, `${indent}ha beta`, '```'].join(newline), JSON.stringify(indent));
  }

  const blank = ['```', '        ', '```'].join(newline), blankCursor = blank.indexOf('        ') + 8;
  const empty = await view(blank, { anchor: blankCursor });
  assert.equal(keyHabitsEnter(empty), true);
  assert.equal(empty.state.doc.toString(), ['```', '    ', '```'].join(newline));
  assert.equal(empty.state.selection.main.head, empty.state.doc.toString().indexOf('    ') + 4);

  const midBlank = await view(blank, { anchor: blank.indexOf('        ') + 4 });
  assert.equal(keyHabitsEnter(midBlank), false, 'blank-line indentation is not rewritten when the cursor is inside it');
  assert.equal(midBlank.state.doc.toString(), blank);

  const oneTab = ['```', '\t', '```'].join(newline), tabCursor = oneTab.indexOf('\t') + 1;
  const tab = await view(oneTab, { anchor: tabCursor });
  assert.equal(keyHabitsEnter(tab), true);
  assert.equal(tab.state.doc.toString(), oneTab.replace('\t', ''));

  const zero = ['```', '', '```'].join(newline), atZero = await view(zero, { anchor: zero.indexOf(newline) + 1 });
  assert.equal(keyHabitsEnter(atZero), false, 'zero-indent empty code lines remain with the default Enter handler');
  assert.equal(insertNewlineAndIndent(atZero), true);
  assert.equal(atZero.state.doc.toString(), ['```', '', '', '```'].join(newline));
});

test('fenced code Enter retains quote and list container prefixes', async () => {
  const { keyHabitsEnter } = await import('../src/editor/markdownKeyHabits.ts');
  const quote = ['> ```', '>     alpha beta', '> ```'].join('\n'), quoteCursor = quote.indexOf('alpha') + 3;
  const quoted = await view(quote, { anchor: quoteCursor });
  assert.equal(keyHabitsEnter(quoted), true);
  assert.equal(quoted.state.doc.toString(), ['> ```', '>     alp', '>     ha beta', '> ```'].join('\n'));

  const list = ['- item', '', '  ```', '          alpha beta', '  ```'].join('\n'), listCursor = list.indexOf('alpha') + 3;
  const nested = await view(list, { anchor: listCursor });
  assert.equal(keyHabitsEnter(nested), true);
  assert.equal(nested.state.doc.toString(), ['- item', '', '  ```', '          alp', '          ha beta', '  ```'].join('\n'));

  const blankQuote = ['> ```', '>         ', '> ```'].join('\n'), blankQuotePos = blankQuote.indexOf('         ') + 9;
  const quotedBlank = await view(blankQuote, { anchor: blankQuotePos });
  assert.equal(keyHabitsEnter(quotedBlank), true);
  assert.equal(quotedBlank.state.doc.toString(), ['> ```', '>     ', '> ```'].join('\n'));

  const blankList = ['- item', '', '  ```', '          ', '  ```'].join('\n'), blankListPos = blankList.indexOf('          ') + 10;
  const listedBlank = await view(blankList, { anchor: blankListPos });
  assert.equal(keyHabitsEnter(listedBlank), true);
  assert.equal(listedBlank.state.doc.toString(), ['- item', '', '  ```', '      ', '  ```'].join('\n'));
});

test('fenced code Enter declines selections, composition, read-only state, and non-code contexts', async () => {
  const { EditorSelection, EditorState } = await import('@codemirror/state');
  const { keyHabitsEnter } = await import('../src/editor/markdownKeyHabits.ts');
  const doc = ['```', '    alpha', '```'].join('\n'), start = doc.indexOf('alpha');
  const selected = await view(doc, { anchor: start, head: start + 2 });
  assert.equal(keyHabitsEnter(selected), false);
  const indentationCursor = await view(doc, { anchor: doc.indexOf('    ') + 2 });
  assert.equal(keyHabitsEnter(indentationCursor), false, 'nonempty code indentation uses the default Enter handler');
  assert.equal(indentationCursor.state.doc.toString(), doc);
  const composing = await view(doc, { anchor: start }); composing.composing = true;
  assert.equal(keyHabitsEnter(composing), false);
  const readonly = await view(doc, { anchor: start });
  readonly.state = EditorState.create({ doc, selection: { anchor: start }, extensions: [EditorState.readOnly.of(true)] });
  assert.equal(keyHabitsEnter(readonly), false);
  const prose = await view('    ordinary text', { anchor: 8 });
  assert.equal(keyHabitsEnter(prose), false);
  const close = await view(doc, { anchor: doc.length - 3 });
  assert.equal(keyHabitsEnter(close), false, 'the closing fence remains with the default Enter handler');
  const multiple = await view(doc, { anchor: 0 }, [EditorState.allowMultipleSelections.of(true)]);
  multiple.state = multiple.state.update({ selection: EditorSelection.create([EditorSelection.cursor(start), EditorSelection.cursor(doc.length - 3)]) }).state;
  assert.equal(keyHabitsEnter(multiple), false);
});

test('Shift-Enter continues list bodies without adding a marker and aligns task and ordered continuations', async () => {
  const { keyHabitsShiftEnter } = await import('../src/editor/markdownKeyHabits.ts');
  const { undo } = await import('@codemirror/commands');
  const { marked } = await import('marked');
  for (const [doc, marker, expected] of [
    ['- alpha beta', 'alpha', '- alpha \n  beta'],
    ['12. alpha beta', 'alpha', '12. alpha \n    beta'],
    ['- [x] alpha beta', 'alpha', '- [x] alpha \n  beta'],
    ['> - [ ] alpha beta', 'alpha', '> - [ ] alpha \n>   beta'],
    ['  - alpha beta', 'alpha', '  - alpha \n    beta'],
  ]) {
    const cursor = doc.indexOf(marker) + marker.length + 1, v = await view(doc, { anchor: cursor });
    assert.equal(keyHabitsShiftEnter(v), true, doc);
    assert.equal(v.state.doc.toString(), expected, doc);
    const html = await marked.parse(v.state.doc.toString());
    assert.equal((html.match(/<li>/g) ?? []).length, 1, 'continuation stays in the same list item');
    assert.match(html, /alpha[\s\S]*beta/);
  }
  const oneStep = await view('- alpha beta', { anchor: '- alpha '.length });
  assert.equal(keyHabitsShiftEnter(oneStep), true);
  assert.equal(undo(oneStep), true);
  assert.equal(oneStep.state.doc.toString(), '- alpha beta', 'Shift-Enter is one undoable transaction');

  const task = '- [x] alpha beta', checkbox = await view(task, { anchor: task.indexOf('[x]') + 1 });
  assert.equal(keyHabitsShiftEnter(checkbox), false, 'the caret must be after the task marker');
});

test('Shift-Enter declines prose, code, selected text, IME composition, and read-only state', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { keyHabitsShiftEnter } = await import('../src/editor/markdownKeyHabits.ts');
  const prose = await view('plain paragraph', { anchor: 6 });
  assert.equal(keyHabitsShiftEnter(prose), false);
  const codeDoc = ['- item', '', '  ```', '    code', '  ```'].join('\n'), code = await view(codeDoc, { anchor: codeDoc.indexOf('code') });
  assert.equal(keyHabitsShiftEnter(code), false);
  const task = '- [x] alpha';
  const selected = await view(task, { anchor: task.indexOf('alpha'), head: task.indexOf('alpha') + 2 });
  assert.equal(keyHabitsShiftEnter(selected), false);
  const composing = await view(task, { anchor: task.length }); composing.composing = true;
  assert.equal(keyHabitsShiftEnter(composing), false);
  const readonly = await view(task, { anchor: task.length });
  readonly.state = EditorState.create({ doc: task, selection: { anchor: task.length }, extensions: [EditorState.readOnly.of(true)] });
  assert.equal(keyHabitsShiftEnter(readonly), false);
});

test('Tab changes only selected physical lines and ordered-list renumbering undoes as one transaction', async () => {
  const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
  const { undo } = await import('@codemirror/commands');
  const doc = '1. first\n2. second\n3. third', second = doc.indexOf('2.');
  const v = await view(doc, { anchor: second });
  assert.equal(keyHabitsTab(1)(v), true);
  assert.equal(v.state.doc.toString(), '1. first\n\t1. second\n2. third');
  assert.equal(undo(v), true);
  assert.equal(v.state.doc.toString(), doc);

  const prose = await view('first\nsecond\nthird', { anchor: 0, head: 'first\nsecond'.length });
  assert.equal(keyHabitsTab(1)(prose), true);
  assert.equal(prose.state.doc.toString(), '\tfirst\n\tsecond\nthird');
});

test('Tab renumbers a loose ordered list without touching other lines and undoes once', async () => {
  const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
  const { undo } = await import('@codemirror/commands');
  const doc = '1. first\n\n2. second\n\n3. third';
  const v = await view(doc, { anchor: doc.indexOf('2. second') });
  assert.equal(keyHabitsTab(1)(v), true);
  assert.equal(v.state.doc.toString(), '1. first\n\n\t1. second\n\n2. third');
  assert.equal(undo(v), true); assert.equal(v.state.doc.toString(), doc);
});

test('Tab preserves ordered list starts and delimiters, and avoids unrelated lists', async () => {
  const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
  const doc = '7) first\n8) second\n9) third\n\n4. separate\n5. list', cursor = doc.indexOf('8)');
  const v = await view(doc, { anchor: cursor });
  assert.equal(keyHabitsTab(1)(v), true);
  assert.equal(v.state.doc.toString(), '7) first\n\t1) second\n8) third\n\n4. separate\n5. list');

  const nestedDoc = '1. parent\n\t1. child\n\t2. child two\n2. sibling';
  const backward = await view(nestedDoc, { anchor: nestedDoc.indexOf('\t1.') + 1 });
  assert.equal(keyHabitsTab(-1)(backward), true);
  assert.equal(backward.state.doc.toString(), '1. parent\n2. child\n\t1. child two\n3. sibling');
});

test('ordered numbering changes only selected list markers and their original same-level siblings', async () => {
  const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
  const { undo } = await import('@codemirror/commands');
  for (const [doc, cursorText, expected] of [
    ['5. first\n   continuation\n42. second', 'continuation', '5. first\n\t   continuation\n42. second'],
    ['1. parent\n2. selected\n   4. child1\n   8. child2\n3. sibling\n\n5. other\n42. untouched', '2. selected', '1. parent\n\t1. selected\n   4. child1\n   8. child2\n2. sibling\n\n5. other\n42. untouched'],
    ['5. one\n6. two\n7. three', '5. one', '\t5. one\n6. two\n7. three'],
    ['5. parent\n   - unordered child\n42. second', 'unordered child', '5. parent\n\t   - unordered child\n42. second'],
  ]) {
    const v = await view(doc, { anchor: doc.indexOf(cursorText) });
    assert.equal(keyHabitsTab(1)(v), true, cursorText);
    assert.equal(v.state.doc.toString(), expected, cursorText);
    assert.equal(undo(v), true, 'indent and any affected sibling numbering undo together');
    assert.equal(v.state.doc.toString(), doc, 'undo restores exact source and line identities');
  }
});

test('Shift-Tab removes exactly four visible columns while preserving the remaining source whitespace', async () => {
  const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
  for (const [source, expected] of [
    ['    text', 'text'],
    ['        text', '    text'],
    ['\t    text', '    text'],
    ['    \ttext', '\ttext'],
    ['  \t  text', '  text'],
  ]) {
    const v = await view(source, { anchor: source.length });
    assert.equal(keyHabitsTab(-1)(v), true, JSON.stringify(source));
    assert.equal(v.state.doc.toString(), expected, JSON.stringify(source));
  }

  const original = '  text', roundTrip = await view(original, { anchor: original.length });
  assert.equal(keyHabitsTab(1)(roundTrip), true);
  assert.equal(roundTrip.state.doc.toString(), '\t  text');
  assert.equal(keyHabitsTab(-1)(roundTrip), true);
  assert.equal(roundTrip.state.doc.toString(), original);

  const { undo } = await import('@codemirror/commands');
  assert.equal(undo(roundTrip), true);
  assert.equal(roundTrip.state.doc.toString(), '\t  text', 'Shift-Tab is one undoable transaction');
  assert.equal(undo(roundTrip), true);
  assert.equal(roundTrip.state.doc.toString(), original, 'Tab is one undoable transaction');
});

test('Tab handlers decline during IME composition, read-only, or multi-cursor state', async () => {
  const { EditorSelection, EditorState } = await import('@codemirror/state');
  const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
  const doc = 'first\nsecond';
  const composing = await view(doc, { anchor: 0 }); composing.composing = true;
  assert.equal(keyHabitsTab(1)(composing), false);
  const readonly = await view(doc, { anchor: 0 });
  readonly.state = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [EditorState.readOnly.of(true)] });
  assert.equal(keyHabitsTab(1)(readonly), false);
  const multiple = await view(doc, { anchor: 0 }, [EditorState.allowMultipleSelections.of(true)]);
  multiple.state = multiple.state.update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(doc.length)]) }).state;
  assert.equal(keyHabitsTab(1)(multiple), false);
});

test('ordered-list Tab consumes an incomplete parse without partially indenting the document', async () => {
  const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
  const doc = '1. first\n2. second\n3. third', selected = doc.indexOf('2.');
  const v = await view(doc, { anchor: selected }), errors = [];
  assert.equal(keyHabitsTab(1, message => errors.push(message), () => null)(v), true);
  assert.equal(v.state.doc.toString(), doc, 'the indent and renumber are both deferred');
  assert.deepEqual(errors, ['列表仍在解析，请稍后重试']);
});

test('selected parent and child items are both renumbered while an unselected child remains byte-for-byte unchanged', async () => {
  const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
  const { undo } = await import('@codemirror/commands');
  const doc = '1. parent\n2. selected\n   4. child1\n   8. child2\n3. sibling';
  const from = doc.indexOf('2. selected'), child = doc.indexOf('   4. child1'), to = child + '   4. child1'.length;
  const v = await view(doc, { anchor: from, head: to });
  assert.equal(keyHabitsTab(1)(v), true);
  assert.equal(v.state.doc.toString(), '1. parent\n\t1. selected\n\t   1. child1\n   8. child2\n2. sibling');
  assert.equal(undo(v), true);
  assert.equal(v.state.doc.toString(), doc);
});

test('Backspace at a nonempty list body start removes only this line marker and one delimiter', async () => {
  const { keyHabitsNonemptyListBackspace } = await import('../src/editor/markdownKeyHabits.ts');
  const { undo } = await import('@codemirror/commands');
  for (const [doc, text, expected] of [
    ['- 苹果\n- 香蕉', '香蕉', '- 苹果\n\n香蕉'],
    ['  - 香蕉', '香蕉', '香蕉'],
    ['>   - 香蕉', '香蕉', '> 香蕉'],
    ['1. 苹果\n2. 香蕉', '香蕉', '1. 苹果\n\n香蕉'],
    ['- [x] first\n- [ ] 中文😀', '中文😀', '- [x] first\n\n中文😀'],
    ['- 苹果\n- 香蕉', '苹果', '苹果\n- 香蕉'],
    ['> - first\n> - second', 'second', '> - first\n> \n> second'],
    ['- parent\n  - child\n- sibling', 'child', '- parent\n  child\n- sibling'],
    ['-   body', 'body', '  body'],
    ['  -   body', 'body', '  body'],
    ['>   -   body', 'body', '>   body'],
    ['- \tbody', 'body', '\tbody'],
  ]) {
    const start = doc.indexOf(text), v = await view(doc, { anchor: start });
    assert.equal(keyHabitsNonemptyListBackspace(v), true, doc);
    assert.equal(v.state.doc.toString(), expected, doc);
    assert.equal(v.state.selection.main.head, expected.indexOf(text), doc);
    assert.equal(undo(v), true, 'marker removal is one undoable transaction');
    assert.equal(v.state.doc.toString(), doc);
  }
});

test('Backspace creates Markdown block boundaries without losing ordered lists, quote scope, or nested parents', async () => {
  const { keyHabitsNonemptyListBackspace } = await import('../src/editor/markdownKeyHabits.ts');
  const { marked } = await import('marked');
  const { undo } = await import('@codemirror/commands');
  for (const [doc, text, expected, htmlPattern] of [
    ['- 苹果\n- 香蕉', '香蕉', '- 苹果\n\n香蕉', /<p>香蕉<\/p>/],
    ['- 苹果\n1. 香蕉', '香蕉', '- 苹果\n\n香蕉', /<p>香蕉<\/p>/],
    ['1. 苹果\n- 香蕉', '香蕉', '1. 苹果\n\n香蕉', /<p>香蕉<\/p>/],
    ['- 苹果\n\n- 香蕉', '香蕉', '- 苹果\n\n香蕉', /<p>香蕉<\/p>/],
    ['- 苹果\n- 香蕉\n3. 梨', '香蕉', '- 苹果\n\n香蕉\n\n3. 梨', /<p>香蕉<\/p>[\s\S]*<ol start="3">[\s\S]*梨/],
    ['- 苹果\n- 香蕉\n1. 梨', '香蕉', '- 苹果\n\n香蕉\n1. 梨', /<p>香蕉<\/p>[\s\S]*<ol>[\s\S]*梨/],
    ['> - 苹果\n> - 香蕉', '香蕉', '> - 苹果\n> \n> 香蕉', /<blockquote>[\s\S]*<p>香蕉<\/p>[\s\S]*<\/blockquote>/],
    ['> - 苹果\n> 1. 香蕉', '香蕉', '> - 苹果\n> \n> 香蕉', /<blockquote>[\s\S]*<p>香蕉<\/p>[\s\S]*<\/blockquote>/],
    ['- parent\n  - child\n  - sibling', 'sibling', '- parent\n  - child\n  \n  sibling', /<ul>[\s\S]*parent[\s\S]*child[\s\S]*<p>sibling<\/p>/],
    ['- parent\n  - child\n- banana', 'banana', '- parent\n  - child\n\nbanana', /<ul>[\s\S]*parent[\s\S]*child[\s\S]*<\/ul>[\s\S]*<p>banana<\/p>/],
    ['- 香蕉😀', '香蕉😀', '香蕉😀', /<p>香蕉😀<\/p>/],
  ]) {
    const v = await view(doc, { anchor: doc.indexOf(text) });
    assert.equal(keyHabitsNonemptyListBackspace(v), true);
    assert.equal(v.state.doc.toString(), expected);
    assert.match(await marked.parse(v.state.doc.toString()), htmlPattern, doc);
    assert.equal(undo(v), true);
    assert.equal(v.state.doc.toString(), doc);
  }
});

test('Backspace at list body start maps the shared transaction selection in another view', async () => {
  const { keyHabitsNonemptyListBackspace } = await import('../src/editor/markdownKeyHabits.ts');
  const doc = '- first\n- second\n- third', second = doc.indexOf('second'), third = doc.indexOf('third');
  const source = await view(doc, { anchor: second });
  const mirror = await view(doc, { anchor: third + 2 });
  assert.equal(keyHabitsNonemptyListBackspace(source), true);
  const transaction = source.lastTransaction;
  mirror.state = mirror.state.update({ changes: transaction.changes, selection: mirror.state.selection.map(transaction.changes) }).state;
  assert.equal(mirror.state.doc.toString(), '- first\n\nsecond\n- third');
  assert.equal(mirror.state.selection.main.head, mirror.state.doc.toString().indexOf('third') + 2);
});

test('Backspace leaves empty items and rejects prose, code, selections, IME, and read-only states', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { keyHabitsNonemptyListBackspace } = await import('../src/editor/markdownKeyHabits.ts');
  const empty = await view('- ');
  assert.equal(keyHabitsNonemptyListBackspace(empty), false);
  for (const [doc, selection] of [
    ['- body', { anchor: 2, head: 3 }],
    ['prose', { anchor: 0 }],
    ['- ```\n  code\n  ```', { anchor: '- ```\n  '.length }],
  ]) {
    const v = await view(doc, selection);
    assert.equal(keyHabitsNonemptyListBackspace(v), false, doc);
  }
  const composing = await view('- body', { anchor: 2 }); composing.composing = true;
  assert.equal(keyHabitsNonemptyListBackspace(composing), false);
  const readonly = await view('- body', { anchor: 2 });
  readonly.state = EditorState.create({ doc: '- body', selection: { anchor: 2 }, extensions: [EditorState.readOnly.of(true)] });
  assert.equal(keyHabitsNonemptyListBackspace(readonly), false);
});

test('Backspace consumes a confirmed list action when trial parsing is pending without changing text or selection', async () => {
  const { ensureSyntaxTree } = await import('@codemirror/language');
  const { keyHabitsNonemptyListBackspace } = await import('../src/editor/markdownKeyHabits.ts');
  const doc = '- first\n- second', v = await view(doc, { anchor: doc.indexOf('second') }), errors = [];
  ensureSyntaxTree(v.state, v.state.doc.length, 100);
  const ensureTree = (state, position, timeout) => state.doc.toString() === doc ? ensureSyntaxTree(state, position, timeout) : null;
  const selection = [v.state.selection.main.anchor, v.state.selection.main.head];
  assert.equal(keyHabitsNonemptyListBackspace(v, message => errors.push(message), ensureTree), true);
  assert.equal(v.state.doc.toString(), doc);
  assert.deepEqual([v.state.selection.main.anchor, v.state.selection.main.head], selection);
  assert.deepEqual(errors, ['文档仍在解析，请稍后重试']);
});
