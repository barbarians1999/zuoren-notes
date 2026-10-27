require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function state(doc, anchor = doc.length, ranges) {
  const { EditorState, EditorSelection } = await import('@codemirror/state');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const extensions = [markdownSyntax()];
  let selection = { anchor };
  if (ranges) {
    extensions.push(EditorState.allowMultipleSelections.of(true));
    selection = EditorSelection.create(ranges.map(range => EditorSelection.cursor(range)), 0);
  }
  return EditorState.create({ doc, selection, extensions });
}

async function paste(doc, source, kind = 'markdown', anchor = doc.length, ranges) {
  const { markdownListPaste } = await import('../src/editor/markdownListPaste.ts');
  return markdownListPaste(await state(doc, anchor, ranges), source);
}

test('plain text only turns each line into a sibling at an empty bullet or task item', async () => {
  for (const [doc, source, expected] of [
    ['- ', '中文😀\nsecond', '- 中文😀\n- second'],
    ['- [ ] ', 'one\n\ntwo', '- [ ] one\n- [ ] \n- [ ] two'],
    ['- [ ] ', 'one\r\n\r\ntwo', '- [ ] one\n- [ ] \n- [ ] two'],
    ['> - [ ] ', 'one\ntwo', '> - [ ] one\n> - [ ] two'],
    ['1. ', 'one\ntwo', '1. one\n2. two'],
  ]) {
    const result = await paste(doc, source, 'plain');
    assert.ok(result, doc);
    assert.equal(result.changes[0].insert, expected, doc);
  }
});

test('new rows from checked tasks start unchecked, and ordered task items continue numbering in one undo', async () => {
  const unchecked = await paste('- [x] ', 'first\nsecond', 'plain');
  assert.ok(unchecked);
  assert.equal(unchecked.changes[0].insert, '- [x] first\n- [ ] second');

  const { EditorState } = await import('@codemirror/state');
  const { history, isolateHistory, undo } = await import('@codemirror/commands');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const doc = '1. before\n2. [x] \n3. [x] after';
  let current = EditorState.create({ doc, selection: { anchor: doc.indexOf('2. [x] ') + '2. [x] '.length }, extensions: [markdownSyntax(), history()] });
  const { markdownListPaste } = await import('../src/editor/markdownListPaste.ts');
  const result = markdownListPaste(current, 'first\nsecond');
  assert.ok(result);
  assert.deepEqual(result.changes.map(change => change.insert), ['2. [x] first\n3. [ ] second', '4.']);
  const view = { get state() { return current; }, dispatch(spec) { current = current.update(spec).state; } };
  view.dispatch({ changes: result.changes, selection: { anchor: result.cursor }, userEvent: 'input.paste', annotations: isolateHistory.of('full') });
  assert.equal(current.doc.toString(), '1. before\n2. [x] first\n3. [ ] second\n4. [x] after');
  assert.equal(undo(view), true);
  assert.equal(current.doc.toString(), doc, 'new task states and ordered suffix numbering undo together');
});

test('Markdown MIME plain paragraphs become list rows, while inline Markdown stays intact', async () => {
  const { clipboardSource } = await import('../src/editor/markdownClipboard.ts');
  const plain = clipboardSource({ markdown: 'one\n\ntwo', text: 'fallback', html: '', vscode: false, rich: false, convertHtml: () => '' });
  assert.ok(await paste('- ', plain.source, plain.kind));
  assert.equal((await paste('- ', plain.source, plain.kind)).changes[0].insert, '- one\n- \n- two');
  const rich = clipboardSource({ markdown: '**bold**\nparagraph', text: 'fallback', html: '', vscode: false, rich: false, convertHtml: () => '' });
  assert.equal(await paste('- ', rich.source, rich.kind), null);
  for (const source of ['**bold**\nplain', '[link](https://example.com)\nplain', '`code`\nplain', '# heading\nplain', '```txt\ncode\n```']) {
    assert.equal(await paste('- ', source, 'plain'), null, source);
  }
});

test('clipboard MIME selection keeps Markdown priority, rich HTML conversion, and the VS Code plain-text exception', async () => {
  const { clipboardSource } = await import('../src/editor/markdownClipboard.ts');
  const convertHtml = () => 'converted-list';
  assert.deepEqual(clipboardSource({ markdown: '- preferred', text: 'plain', html: '<b>rich</b>', vscode: false, rich: true, convertHtml }),
    { source: '- preferred', kind: 'markdown' });
  assert.deepEqual(clipboardSource({ markdown: '', text: '', html: '<ul><li>rich</li></ul>', vscode: false, rich: true, convertHtml }),
    { source: 'converted-list', kind: 'markdown' });
  assert.deepEqual(clipboardSource({ markdown: '', text: 'plain', html: '<pre>ignored</pre>', vscode: true, rich: true, convertHtml }),
    { source: 'plain', kind: 'plain' });
});

test('plain text that is itself a valid list keeps its markers and nests by relative level', async () => {
  const doc = '- 购物\n  - ';
  const result = await paste(doc, '- 苹果\n  - 红苹果\n- 香蕉', 'plain');
  assert.ok(result);
  assert.equal(result.changes[0].insert, '  - 苹果\n    - 红苹果\n  - 香蕉');
});

test('adjacent mixed list roots stay structured, and nested fenced code keeps its parsed literal body', async () => {
  const mixed = await paste('- parent\n  - ', '- apple\n1. banana');
  assert.ok(mixed);
  assert.equal(mixed.changes[0].insert, '  - apple\n  1. banana');
  const quoted = await paste('- parent\n  - ', '- quote\n  > cited\n- next');
  assert.ok(quoted);
  assert.equal(quoted.changes[0].insert, '  - quote\n    > cited\n  - next');
  const deep = await paste('- parent\n  - ', '- top\n  - middle\n    - lower\n      - six-space item');
  assert.ok(deep);
  assert.equal(deep.changes[0].insert, '  - top\n    - middle\n      - lower\n        - six-space item');
  const { EditorState } = await import('@codemirror/state');
  const { ensureSyntaxTree } = await import('@codemirror/language');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const deepDoc = '- parent\n' + deep.changes[0].insert;
  const deepState = EditorState.create({ doc: deepDoc, extensions: [markdownSyntax()] });
  const deepTree = ensureSyntaxTree(deepState, deepDoc.length, 120), markers = [];
  deepTree.iterate({ enter(ref) { if (ref.name === 'ListMark') markers.push(deepState.sliceDoc(ref.from, ref.to)); } });
  assert.equal(markers.length, 5, 'the parent and four pasted nested list rows remain list syntax');
  const continuation = await paste('- parent\n  - ', '- first\n    continuation\n- next');
  assert.ok(continuation);
  assert.equal(continuation.changes[0].insert, '  - first\n      continuation\n  - next');
  const source = '- snippet\n  ```txt\n  alpha\tbeta\n  ```\n- next';
  const nested = await paste('- parent\n  - ', source);
  assert.ok(nested);
  assert.match(nested.changes[0].insert, /```txt\n    alpha\tbeta\n    ```/);
  const indented = await paste('- parent\n  - ', '- snippet\n\n      alpha\tbeta\n- next');
  assert.ok(indented);
  const doc = '- parent\n' + nested.changes[0].insert;
  const indentedDoc = '- parent\n' + indented.changes[0].insert;
  const state = EditorState.create({ doc: doc + '\n' + indentedDoc, extensions: [markdownSyntax()] });
  const tree = ensureSyntaxTree(state, state.doc.length, 120), bodies = [];
  tree.iterate({ enter(ref) { if (ref.name === 'CodeText') bodies.push(state.sliceDoc(ref.from, ref.to)); } });
  assert.ok(bodies.some(body => body.includes('alpha\tbeta')));
});

test('a GFM table inside a pasted list remains in the list item with unchanged cell text', async () => {
  const source = '- item\n\n  | A | B |\n  | --- | --- |\n  | x | y |';
  const result = await paste('- parent\n  - ', source);
  assert.ok(result);
  const { EditorState } = await import('@codemirror/state');
  const { ensureSyntaxTree } = await import('@codemirror/language');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const doc = '- parent\n' + result.changes[0].insert;
  const state = EditorState.create({ doc, extensions: [markdownSyntax()] });
  const tree = ensureSyntaxTree(state, doc.length, 120), tables = [], cells = [];
  tree.iterate({ enter(ref) {
    if (ref.name === 'Table') {
      let listItem = false;
      for (let parent = ref.node.parent; parent; parent = parent.parent) if (parent.name === 'ListItem') listItem = true;
      tables.push(listItem);
    }
    if (ref.name === 'TableCell') cells.push(state.sliceDoc(ref.from, ref.to));
  } });
  assert.deepEqual(tables, [true]);
  assert.deepEqual(cells, ['A', 'B', 'x', 'y']);
});

test('Markdown lists align to the empty target and retain their marker types', async () => {
  for (const [doc, source, expected] of [
    ['- parent\n  - ', '+ first\n  1. nested', '  + first\n    1. nested'],
    ['> - parent\n>   - ', '- first\n  - nested', '>   - first\n>     - nested'],
    ['- parent\n\t- ', '- first\n\t- nested', '\t- first\n\t\t- nested'],
    ['- [ ] ', '- [x] done\n- [ ] todo', '- [x] done\n- [ ] todo'],
  ]) {
    const result = await paste(doc, source);
    assert.ok(result, doc);
    assert.equal(result.changes[0].insert, expected, doc);
  }
});

test('mixed target indentation preserves tabs when columns align and spaces only ambiguous tab stops', async () => {
  const aligned = await paste('- parent\n\t- ', '- first\n\t- nested');
  assert.equal(aligned.changes[0].insert, '\t- first\n\t\t- nested');
  const mixedTarget = await paste('- parent\n \t- ', '- first\n\t- nested');
  assert.equal(mixedTarget.changes[0].insert, ' \t- first\n \t\t- nested');
  const ambiguous = await paste('- parent\n  - ', '- first\n\t- nested');
  assert.equal(ambiguous.changes[0].insert, '  - first\n      - nested');
  const withBodyTab = await paste('- ', '- first\tcontent\n- second');
  assert.equal(withBodyTab.changes[0].insert, '- first\tcontent\n- second');
});

test('ordered paste keeps the destination start and renumbers affected following siblings', async () => {
  const doc = '2. before\n3. \n4. after';
  const result = await paste(doc, '1. first\n2. second', 'markdown', doc.indexOf('3. ') + 3);
  assert.ok(result);
  assert.deepEqual(result.changes.map(change => change.insert), ['3. first\n4. second', '5.']);
  assert.equal(result.changes[1].from, doc.indexOf('4. after'));
  const { EditorState } = await import('@codemirror/state');
  const updated = EditorState.create({ doc }).update({ changes: result.changes }).state.doc.toString();
  assert.equal(updated, '2. before\n3. first\n4. second\n5. after');
});

test('ordered paste renumbers siblings after multiline items', async () => {
  const { EditorState } = await import('@codemirror/state');
  for (const tail of ['3. existing\n   continuation\n4. tail', '3. existing\n   - child\n4. tail']) {
    const doc = '1. before\n2. \n' + tail;
    const result = await paste(doc, 'one\ntwo', 'plain', doc.indexOf('2. ') + 3);
    assert.ok(result);
    const updated = EditorState.create({ doc }).update({ changes: result.changes }).state.doc.toString();
    assert.match(updated, /4\. existing/); assert.match(updated, /5\. tail/);
  }
});

test('ordered list paste with a trailing newline still renumbers the same following list', async () => {
  const { EditorState } = await import('@codemirror/state');
  const doc = '1. before\n2. \n3. after';
  const result = await paste(doc, '1. one\n2. two\n', 'markdown', doc.indexOf('2. ') + 3);
  const updated = EditorState.create({ doc }).update({ changes: result.changes }).state.doc.toString();
  assert.equal(updated, '1. before\n2. one\n3. two\n\n4. after');
});

test('mixed list roots preserve marker order and only renumber a continuous trailing ordered root', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { history, isolateHistory, undo } = await import('@codemirror/commands');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const doc = '1. before\n2. \n3. after';
  let current = EditorState.create({ doc, selection: { anchor: doc.indexOf('2. ') + 3 }, extensions: [markdownSyntax(), history()] });
  const { markdownListPaste } = await import('../src/editor/markdownListPaste.ts');
  const result = markdownListPaste(current, '- apple\n1. banana');
  assert.ok(result);
  assert.deepEqual(result.changes.map(change => change.insert), ['- apple\n1. banana', '2.']);
  const view = { get state() { return current; }, dispatch(spec) { current = current.update(spec).state; } };
  view.dispatch({ changes: result.changes, selection: { anchor: result.cursor }, userEvent: 'input.paste', annotations: isolateHistory.of('full') });
  assert.equal(current.doc.toString(), '1. before\n- apple\n1. banana\n2. after');
  assert.equal(undo(view), true);
  assert.equal(current.doc.toString(), doc, 'paste and suffix numbering undo together');

  const bulletEnding = '1. before\n2. \n3. after';
  const bulletCurrent = EditorState.create({ doc: bulletEnding, selection: { anchor: bulletEnding.indexOf('2. ') + 3 }, extensions: [markdownSyntax()] });
  const bulletResult = markdownListPaste(bulletCurrent, '1. apple\n- banana');
  assert.ok(bulletResult);
  assert.equal(bulletResult.changes.length, 1, 'a trailing bullet root breaks ordered renumbering');
  assert.equal(bulletResult.changes[0].insert, '2. apple\n- banana');
  assert.equal(bulletCurrent.update({ changes: bulletResult.changes }).state.doc.toString(), '1. before\n2. apple\n- banana\n3. after');

  for (const source of ['- apple\n1) banana', '- apple\n1. banana\n\n']) {
    const current = EditorState.create({ doc: bulletEnding, selection: { anchor: bulletEnding.indexOf('2. ') + 3 }, extensions: [markdownSyntax()] });
    const unchanged = markdownListPaste(current, source);
    assert.ok(unchanged);
    assert.equal(unchanged.changes.length, 1, 'different marker delimiter or multiple source-ending newlines break continuation');
  }
});

test('code blocks, mixed block content, non-empty targets, and multi-ranges stay on the original path', async () => {
  assert.equal(await paste('- ', '```\n- literal\n```'), null);
  const indented = await paste('- ', '- item\n\n    code');
  assert.ok(indented);
  assert.match(indented.changes[0].insert, /\n\n    code/);
  assert.equal(await paste('- body', 'one\ntwo', 'plain'), null);
  const doc = '- \n- ';
  assert.equal(await paste(doc, 'one\ntwo', 'plain', 2, [0, 2]), null);
});

test('an isolated list paste is a single undo operation', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { history, isolateHistory, undo } = await import('@codemirror/commands');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const doc = '- 购物\n  - ';
  let current = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdownSyntax(), history()] });
  const { markdownListPaste } = await import('../src/editor/markdownListPaste.ts');
  const result = markdownListPaste(current, '- 苹果\n  - 红苹果\n- 香蕉', 'markdown');
  assert.ok(result);
  const view = { get state() { return current; }, dispatch(spec) { current = current.update(spec).state; } };
  view.dispatch({ changes: result.changes, selection: { anchor: result.cursor }, userEvent: 'input.paste', annotations: isolateHistory.of('full') });
  assert.equal(current.doc.toString(), '- 购物\n  - 苹果\n    - 红苹果\n  - 香蕉');
  assert.equal(undo(view), true);
  assert.equal(current.doc.toString(), doc);
});
