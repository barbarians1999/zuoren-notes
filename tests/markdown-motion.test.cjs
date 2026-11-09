require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function changes(doc, spec) {
  const { EditorState } = await import('@codemirror/state');
  const before = EditorState.create({ doc });
  const changeSet = before.changes(spec), after = before.update({ changes: changeSet }).state;
  return { before: before.doc, after: after.doc, changeSet };
}

test('indent motion accepts only one leading whitespace edit with unchanged line content', async () => {
  const { isSingleLeadingIndentChange } = await import('../src/editor/markdownMotion.ts');
  const oldLine = '- parent\n  - child';
  const start = oldLine.indexOf('  - child');
  const added = await changes(oldLine, { from: start, insert: '\t' });
  assert.equal(isSingleLeadingIndentChange(added.before, added.after, added.changeSet, 'input.indent'), true);

  const removed = await changes('\t  - child', { from: 0, to: 1 });
  assert.equal(isSingleLeadingIndentChange(removed.before, removed.after, removed.changeSet, 'delete.dedent'), true);
  const partialSpaceDedent = await changes('      child', { from: 0, to: 4 });
  assert.equal(isSingleLeadingIndentChange(partialSpaceDedent.before, partialSpaceDedent.after, partialSpaceDedent.changeSet, 'delete.dedent'), true,
    'a Shift-Tab that replaces a full indentation unit with its remaining suffix is eligible');
  const reshapedIndent = await changes('\t  child', { from: 0, to: 3, insert: ' \t' });
  assert.equal(isSingleLeadingIndentChange(reshapedIndent.before, reshapedIndent.after, reshapedIndent.changeSet, 'delete.dedent'), true,
    'a full leading-whitespace rewrite is eligible when source body identity stays exact');
  const partialIndentRewrite = await changes('\t  child', { from: 0, to: 1, insert: '   ' });
  assert.equal(isSingleLeadingIndentChange(partialIndentRewrite.before, partialIndentRewrite.after, partialIndentRewrite.changeSet, 'delete.dedent'), false,
    'an edit that overlaps only part of the indentation without removing a prefix falls back');

  const bodyEdit = await changes(oldLine, [{ from: start, insert: '\t' }, { from: oldLine.length, insert: '!' }]);
  assert.equal(isSingleLeadingIndentChange(bodyEdit.before, bodyEdit.after, bodyEdit.changeSet, 'input.indent'), false,
    'renumbering or any second document change falls back to direct layout');
  const changedBody = await changes('- parent\n  - child', [{ from: start, insert: '\t' }, { from: oldLine.indexOf('child'), insert: 'X' }]);
  assert.equal(isSingleLeadingIndentChange(changedBody.before, changedBody.after, changedBody.changeSet, 'input.indent'), false);
  const nonIndent = await changes('text', { from: 0, insert: 'x' });
  assert.equal(isSingleLeadingIndentChange(nonIndent.before, nonIndent.after, nonIndent.changeSet, 'input.indent'), false);
});

test('motion ranges map only when their source identity is unchanged', async () => {
  const { mapMarkdownMotionRangeThroughChanges } = await import('../src/editor/markdownMotion.ts');
  const doc = '- parent\n  - child';
  const lineStart = doc.indexOf('  - child');
  const bodyStart = lineStart + '  - '.length;
  const edit = await changes(doc, { from: lineStart, insert: '\t' });
  const mapped = mapMarkdownMotionRangeThroughChanges(bodyStart, doc.length, edit.changeSet, edit.before, edit.after);
  assert.deepEqual(mapped, { from: bodyStart + 1, to: doc.length + 1, key: `${bodyStart + 1}:${doc.length + 1}` });
  assert.equal(edit.before.sliceString(bodyStart, doc.length), edit.after.sliceString(mapped.from, mapped.to));

  assert.equal(mapMarkdownMotionRangeThroughChanges(lineStart, bodyStart, edit.changeSet, edit.before, edit.after), null,
    'a run containing the inserted indentation is not treated as the same run');
  const bodyEdited = await changes(doc, [{ from: lineStart, insert: '\t' }, { from: bodyStart + 2, insert: 'X' }]);
  assert.equal(mapMarkdownMotionRangeThroughChanges(bodyStart, doc.length, bodyEdited.changeSet, bodyEdited.before, bodyEdited.after), null,
    'an edited source range is never animated as the same text');

  const trailing = await changes('plain', { from: 5, insert: '!' });
  const beforeEnd = mapMarkdownMotionRangeThroughChanges(0, 5, trailing.changeSet, trailing.before, trailing.after);
  assert.deepEqual(beforeEnd, { from: 0, to: 5, key: '0:5' }, 'a change exactly at the half-open run end stays outside it');
});
