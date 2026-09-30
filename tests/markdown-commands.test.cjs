require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
async function view(doc) {
  const { EditorState } = await import('@codemirror/state');
  return { state: EditorState.create({ doc, selection: { anchor: 0, head: doc.length } }), dispatch(spec) { this.state = this.state.update(spec).state; }, focus() {} };
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
