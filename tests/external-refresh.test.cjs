require('./typescript-loader.cjs');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileStore, digest } = require('../electron/storage.cjs');
let NoteWorkspace, EditorState, Transaction, undo;
before(async () => {
  ({ NoteWorkspace } = await import('../src/workspace/noteWorkspace.ts'));
  ({ EditorState, Transaction } = await import('@codemirror/state'));
  ({ undo } = await import('@codemirror/commands'));
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture(t, content = '# 原稿\n中文 😀\n') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-external-refresh-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, '笔记.md'); await fs.writeFile(file, content);
  const store = new FileStore(); await store.grantRoot(root);
  const messages = [], writes = [], gate = new Set();
  const api = {
    readNote: file => store.readNote(file), checkRecovery: async () => ({ status: 'none' }),
    writeRecovery: async () => {}, deleteRecovery: async () => true,
    saveNote: input => { writes.push(input); return store.saveNote(input); },
  };
  const workspace = () => new NoteWorkspace(() => api, { has: value => gate.has(value) }, value => messages.push(value));
  const ws = workspace(), tab = await ws.open(file, 'primary', true), doc = tab.document;
  ws.ready = true;
  const view = mount(tab);
  return { root, file, store, api, messages, writes, gate, ws, doc, tab, view, workspace };
}
function mount(tab) {
  const view = { state: EditorState.create({ doc: tab.document.state.doc, selection: tab.selection }), composing: false,
    update(transactions) { for (const tr of transactions) this.state = tr.state; } };
  view.detach = tab.document.attach(view, tab); return view;
}
function type(f, text) {
  f.doc.dispatch(f.view, [f.view.state.update({ changes: { from: 0, to: f.view.state.doc.length, insert: text },
    annotations: Transaction.userEvent.of('input') })]);
}

test('existing scheduled polling updates a clean Markdown document without reopening', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, '# 外部改稿\n😀');
  f.doc.lastPoll = Date.now() - 3001; f.ws.tick(); await f.doc.poll();
  assert.equal(f.doc.text, '# 外部改稿\n😀'); assert.equal(f.view.state.doc.toString(), f.doc.text);
  assert.equal(f.ws.current().document, f.doc); assert.equal(f.writes.length, 0);
});
test('F5 refresh of an unchanged disk never saves or discards a dirty draft', async t => {
  const f = await fixture(t); type(f, '尚未保存 😀'); const before = f.doc.note;
  assert.equal(await f.doc.refresh(), 'unchanged'); assert.equal(f.doc.text, '尚未保存 😀');
  assert.equal(f.doc.note, before); assert.equal(f.doc.label, '编辑中'); assert.equal(f.writes.length, 0);
  assert.notEqual(await fs.readFile(f.file, 'utf8'), f.doc.text);
});
test('a divergent external edit opens the existing conflict flow and retains both versions', async t => {
  const f = await fixture(t); type(f, '我的未保存稿'); const before = f.doc.note;
  await fs.writeFile(f.file, '外部改稿');
  assert.equal(await f.doc.refresh(), 'conflict'); assert.equal(f.doc.text, '我的未保存稿');
  assert.equal(f.doc.note, before); assert.equal(f.doc.conflict.content, '外部改稿'); assert.equal(f.doc.label, '外部冲突');
  assert.equal(await f.doc.save(), false); assert.equal(await fs.readFile(f.file, 'utf8'), '外部改稿');
});
test('external text equal to the draft acknowledges the disk without an artificial edit or lost undo', async t => {
  const f = await fixture(t); type(f, '共同内容 😀'); const state = f.doc.state, revision = f.doc.revision;
  await fs.writeFile(f.file, '共同内容 😀');
  assert.equal(await f.doc.refresh(), 'reloaded'); assert.equal(f.doc.state, state); assert.equal(f.doc.revision, revision);
  assert.equal(f.doc.label, '已保存'); assert.equal(f.doc.runHistory(undo, f.view), true);
  assert.notEqual(f.doc.text, '共同内容 😀'); assert.equal(await fs.readFile(f.file, 'utf8'), '共同内容 😀');
});
test('polling and repeated manual checks share one read; no overlapping whole-document replacement', async t => {
  const f = await fixture(t), disk = deferred(); let reads = 0;
  f.api.readNote = async () => { reads++; return disk.promise; };
  const first = f.doc.poll(), second = f.doc.poll(), manual = f.doc.refresh(); assert.equal(first, second);
  disk.resolve({ ...f.doc.note, content: 'new', hash: digest('new') });
  assert.equal(await manual, 'reloaded'); await first; assert.equal(reads, 1); assert.equal(f.doc.polling, false);
});
test('refresh during an existing save skips instead of racing or starting another save', async t => {
  const f = await fixture(t), write = deferred(), entered = deferred(); type(f, 'local'); let reads = 0;
  f.api.saveNote = async () => { entered.resolve(); return write.promise; }; f.api.readNote = async () => { reads++; throw Error('must not read'); };
  const save = f.doc.save(); await entered.promise;
  assert.equal(await f.doc.refresh(), 'skipped'); assert.equal(reads, 0);
  write.resolve({ content: 'local', hash: digest('local') }); assert.equal(await save, true);
});
for (const outcome of ['value', 'error']) test(`late ${outcome} after a user edit cannot replace the draft or attach a stale read error`, async t => {
  const f = await fixture(t), disk = deferred(); f.api.readNote = () => disk.promise;
  const refreshing = f.doc.refresh(); type(f, '读取期间输入的文字');
  if (outcome === 'value') disk.resolve({ ...f.doc.note, content: 'external', hash: digest('external') }); else disk.reject(Error('old read failed'));
  assert.equal(await refreshing, 'stale'); assert.equal(f.doc.text, '读取期间输入的文字');
  assert.equal(f.doc.externalReadError, null); assert.equal(f.doc.conflict, null);
});
for (const outcome of ['value', 'error']) test(`late ${outcome} after relocation remains detached from the new identity`, async t => {
  const f = await fixture(t), disk = deferred(); f.api.readNote = () => disk.promise;
  const refreshing = f.doc.refresh(), old = f.doc.note;
  f.doc.relocate({ ...old, path: path.join(f.root, '新路径.md') });
  if (outcome === 'value') disk.resolve({ ...old, content: 'old path content', hash: 'old' }); else disk.reject(Error('ENOENT old path'));
  assert.equal(await refreshing, 'stale'); assert.equal(f.doc.text, old.content); assert.equal(f.doc.externalReadError, null);
});
for (const reason of ['composition', 'composition-start', 'mutation', 'recovery', 'conflict', 'commit', 'image', 'disposed']) test(`${reason} blocks refresh and preserves the active document`, async t => {
  const f = await fixture(t); let reads = 0; const original = f.doc.text;
  f.api.readNote = async () => { reads++; throw Error('blocked read'); };
  if (reason === 'composition') f.view.composing = true;
  if (reason === 'composition-start') f.view.compositionStarted = true;
  if (reason === 'mutation') f.gate.add(f.file);
  if (reason === 'recovery') f.doc.recoveryConflict = { note: f.doc.note };
  if (reason === 'conflict') f.doc.setConflict({ ...f.doc.note, conflict: true });
  if (reason === 'commit') f.ws.committing = true;
  if (reason === 'image') Object.defineProperty(f.doc, 'hasImageWork', { value: true });
  if (reason === 'disposed') f.doc.dispose();
  assert.equal(await f.doc.refresh(), 'skipped'); assert.equal(reads, 0); assert.equal(f.doc.text, original);
});
test('composition that starts during a disk read invalidates its application', async t => {
  const f = await fixture(t), disk = deferred(); f.api.readNote = () => disk.promise;
  const refreshing = f.doc.poll(); f.view.composing = true;
  disk.resolve({ ...f.doc.note, content: 'external', hash: 'external' });
  assert.equal(await refreshing, 'stale'); assert.notEqual(f.doc.text, 'external');
});
test('early composition with no document revision yet also invalidates an in-flight read', async t => {
  const f = await fixture(t), disk = deferred(); f.api.readNote = () => disk.promise;
  const refreshing = f.doc.poll(); f.view.compositionStarted = true;
  disk.resolve({ ...f.doc.note, content: 'external', hash: 'external' });
  assert.equal(await refreshing, 'stale'); assert.notEqual(f.doc.text, 'external');
});
test('deleted or renamed files retain the draft, report the error once, and are never recreated by refresh/save', async t => {
  const f = await fixture(t); type(f, '保留我的稿'); const base = f.doc.note;
  const renamed = path.join(f.root, '改名.md'); await fs.rename(f.file, renamed);
  assert.equal(await f.doc.poll(), 'error'); assert.equal(await f.doc.poll(), 'error');
  assert.equal(f.messages.length, 1); assert.match(f.doc.externalReadError, /当前内容已保留/);
  assert.equal(f.doc.note, base); assert.equal(f.doc.text, '保留我的稿'); assert.equal(await f.doc.save(), false);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' }); assert.equal(await fs.readFile(renamed, 'utf8'), base.content);
  await fs.rename(renamed, f.file); assert.equal(await f.doc.refresh(), 'unchanged');
  assert.equal(f.doc.externalReadError, null); assert.equal(f.doc.text, '保留我的稿');
});
for (const bytes of [Buffer.from([0xff, 0xfe, 0x41, 0x00]), Buffer.from([0xff, 0x41])]) test(`unsupported encoding ${bytes.toString('hex')} never replaces visible text or the disk baseline`, async t => {
  const f = await fixture(t), base = f.doc.note; await fs.writeFile(f.file, bytes);
  assert.equal(await f.doc.refresh(), 'error'); assert.equal(f.doc.note, base); assert.equal(f.doc.text, base.content);
  assert.match(f.doc.externalReadError, /编码/); assert.deepEqual(await fs.readFile(f.file), bytes); assert.equal(f.writes.length, 0);
});
test('atomic replacement refresh preserves new BOM/CRLF metadata and subsequent saving keeps that encoding', async t => {
  const f = await fixture(t), replacement = path.join(f.root, 'replacement.tmp');
  await fs.writeFile(replacement, '\ufeff# 原子更新\r\n中😀文\r\n'); await fs.rename(replacement, f.file);
  assert.equal(await f.doc.refresh(), 'reloaded'); assert.equal(f.doc.note.bom, true); assert.equal(f.doc.note.eol, '\r\n');
  assert.equal(f.doc.text, '# 原子更新\n中😀文\n'); assert.equal(f.view.state.doc.toString(), f.doc.text);
  assert.equal(f.doc.runHistory(undo, f.view), false, 'old clean document is not an edit in the new history');
  type(f, '# 原子更新\n中😀文 新编辑\n'); assert.equal(await f.doc.save(), true);
  assert.deepEqual(await fs.readFile(f.file), Buffer.from('\ufeff# 原子更新\r\n中😀文 新编辑\r\n'));
});
test('a legitimate stable empty file reloads instead of being treated as deletion', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, ''); assert.equal(await f.doc.refresh(), 'reloaded'); assert.equal(f.doc.text, '');
});
test('both views of one Markdown file observe the same refreshed state and retain their view modes', async t => {
  const f = await fixture(t), right = await f.ws.open(f.file, 'secondary', true), rv = mount(right);
  f.ws.setMode('secondary', right.id, 'preview'); await fs.writeFile(f.file, '# 两栏共享\n😀');
  assert.equal(await right.document.refresh(), 'reloaded'); assert.equal(right.document, f.doc);
  assert.equal(rv.state.doc.toString(), f.view.state.doc.toString()); assert.equal(right.mode, 'preview'); assert.equal(f.tab.mode, 'edit');
});
test('independent workspace windows resolve external disk edits separately and never overwrite the dirty window', async t => {
  const f = await fixture(t), other = f.workspace(), otherTab = await other.open(f.file, 'primary', true), otherDoc = otherTab.document;
  type(f, '窗口一未保存'); await fs.writeFile(f.file, '外部程序版本');
  assert.equal(await otherDoc.refresh(), 'reloaded'); assert.equal(await f.doc.refresh(), 'conflict');
  assert.equal(otherDoc.text, '外部程序版本'); assert.equal(f.doc.text, '窗口一未保存'); assert.equal(await fs.readFile(f.file, 'utf8'), '外部程序版本');
});
test('a changed read path is not silently adopted as a different document', async t => {
  const f = await fixture(t), before = f.doc.note;
  f.api.readNote = async () => ({ ...before, path: path.join(f.root, 'another.md'), content: 'wrong file', hash: 'wrong' });
  assert.equal(await f.doc.refresh(), 'error'); assert.equal(f.doc.note, before); assert.equal(f.doc.text, before.content);
});
