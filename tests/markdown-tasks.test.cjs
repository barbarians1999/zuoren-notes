require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/editor/markdownTasks.ts');

test('task positions preserve nested markers, quotes, CRLF and uppercase X', async () => {
  const { findMarkdownTasks, taskToggleChange } = await load();
  const source = '- [ ] first\r\n  - [X] nested\r\n\r\n> 1. [ ] quoted\r\n';
  const tasks = findMarkdownTasks(source);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map(item => item.checked), [false, true, false]);
  for (const task of tasks) {
    const change = taskToggleChange(source, source, task.position, !task.checked);
    const next = source.slice(0, change.from) + change.insert + source.slice(change.to);
    assert.equal(next.length, source.length);
    assert.equal(next.replace(/\[[ xX]\]/g, '[ ]'), source.replace(/\[[ xX]\]/g, '[ ]'));
    assert.equal(next.match(/\r\n/g).length, 4);
  }
});
test('code, escaped markers, HTML inputs and stale snapshots cannot toggle', async () => {
  const { findMarkdownTasks, taskToggleChange } = await load();
  const source = '~~~\n- [ ] code\n~~~\n\n`- [ ] inline`\n\n- \\[ ] escaped\n\n<input type="checkbox">\n';
  assert.deepEqual(findMarkdownTasks(source), []);
  assert.equal(taskToggleChange('- [ ] task', '- [ ] old', 3, true), null);
  assert.equal(taskToggleChange('- [ ] task', '- [ ] task', 99, true), null);
  assert.equal(taskToggleChange('- [x] task', '- [x] task', 3, true), null);
});
test('preview injection adds provenance only to confirmed tasks without changing stored source', async () => {
  const { findMarkdownTasks, taskPreviewSource } = await load();
  const source = '- [ ] first\n- [x] second';
  const rendered = taskPreviewSource(source, findMarkdownTasks(source), 'audit');
  assert.equal(rendered.replace(/<span[^>]+><\/span>/g, ''), source);
  assert.equal((rendered.match(/data-zuoren-task=/g) || []).length, 2);
});
