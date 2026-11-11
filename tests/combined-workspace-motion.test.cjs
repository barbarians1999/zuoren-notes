require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { combinedWorkspace } = require('./helpers/combined-workspace.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
const active = f => f.animations.filter(item => item.playState === 'running');

test('combined: typing caret hands off to outline before native measure and the first scroll event', async t => {
  const f = await combinedWorkspace(t); f.insert('x'); assert.equal(f.activeCaret().length, 1);
  const text = f.note.text, revision = f.note.revision;
  f.jump(100); assert.equal(f.activeCaret().length, 0, 'select.outline synchronously owns motion');
  f.flush(); assert.equal(f.nativeHandled, true); f.frame(16, false); assert.equal(f.activeCaret().length, 0);
  f.complete(); assert.equal(f.note.text, text); assert.equal(f.note.revision, revision); assert.equal(f.view.state.doc.toString(), text);
  assert.equal(f.scroll.scrollTop, (100 - 1) * 36 + 38 + 7.5 - 12);
});
test('combined: deletion echo is removed before repeated keyboard outline navigation without adding history', async t => {
  const f = await combinedWorkspace(t), { undoDepth } = await import('@codemirror/commands');
  f.erase(); assert.equal(f.echoes().length, 1); assert.equal(undoDepth(f.note.state), 1);
  const text = f.note.text; f.view.hasFocus = false; f.jump(100, false); assert.equal(f.echoes().length, 0); f.flush(); f.frame();
  const stale = f.oldFrames.at(-1); f.jump(4, false); f.flush(); const visible = f.scroll.scrollTop; stale(100000); assert.equal(f.scroll.scrollTop, visible);
  f.complete(); assert.equal(f.note.text, text); assert.equal(undoDepth(f.note.state), 1); assert.equal(active(f).length, 0); assert.equal(f.view.hasFocus, false);
});
test('combined: clean external refresh cancels an outline target queued before CM measures', async t => {
  const f = await combinedWorkspace(t), old = f.note.note;
  f.jump(100); await fs.writeFile(f.file, '# 外部更新\n新正文 😀');
  assert.equal(await f.note.refresh(), 'reloaded'); f.flush();
  assert.equal(f.frames.size, 0); assert.notEqual(f.note.note.hash, old.hash); assert.equal(f.note.text, '# 外部更新\n新正文 😀');
  assert.equal(f.view.state.doc.toString(), f.note.text); assert.equal(active(f).length, 0); assert.equal(f.saves.length, 0);
});
test('combined: refresh during active outline invalidates late RAFs and old caret/echo state', async t => {
  const f = await combinedWorkspace(t); f.jump(100); f.flush(); f.frame(); const stale = f.oldFrames.at(-1);
  await fs.writeFile(f.file, '# 替换后\n只有这一篇'); assert.equal(await f.note.refresh(), 'reloaded'); f.flush();
  const scroll = f.scroll.scrollTop; stale(100000); assert.equal(f.frames.size, 0); assert.equal(f.scroll.scrollTop, scroll);
  assert.equal(f.note.text, '# 替换后\n只有这一篇'); assert.equal(f.echoes().length, 0); assert.equal(active(f).length, 0);
});
test('combined: dirty deletion then outline and F5 conflict retain draft, selection, disk base and history', async t => {
  const f = await combinedWorkspace(t), { undoDepth } = await import('@codemirror/commands');
  f.erase(); f.jump(4); f.flush(); const state = f.note.state, selection = f.view.state.selection, baseline = f.note.note;
  await fs.writeFile(f.file, '# 外部不同版本'); assert.equal(await f.note.refresh(), 'conflict');
  assert.equal(f.note.state, state); assert.equal(f.view.state.selection, selection); assert.equal(f.note.note, baseline); assert.equal(undoDepth(f.note.state), 1);
  assert.equal(f.note.conflict.content, '# 外部不同版本'); assert.equal(f.saves.length, 0); assert.equal(await fs.readFile(f.file, 'utf8'), '# 外部不同版本');
});
test('combined: unchanged F5 preserves immediate unsaved typing and one-step undo/redo', async t => {
  const f = await combinedWorkspace(t), { undo, redo, undoDepth } = await import('@codemirror/commands');
  const original = f.note.text; f.insert('中'); const typed = f.note.text;
  assert.equal(await f.note.refresh(), 'unchanged'); assert.equal(f.note.text, typed); assert.equal(undoDepth(f.note.state), 1); assert.equal(f.saves.length, 0);
  assert.equal(f.note.runHistory(undo, f.view), true); f.flush(); assert.equal(f.note.text, original);
  assert.equal(f.note.runHistory(redo, f.view), true); f.flush(); assert.equal(f.note.text, typed); assert.equal(f.view.state.doc.toString(), typed);
});
for (const property of ['composing', 'compositionStarted']) test(`combined: ${property} blocks both F5 and outline without reading or dispatching`, async t => {
  const f = await combinedWorkspace(t), state = f.view.state; f.view[property] = true;
  assert.equal(await f.note.refresh(), 'skipped'); assert.equal(f.jump(4), false); assert.equal(f.view.state, state); assert.equal(f.reads.length, 0); assert.equal(f.frames.size, 0);
});
test('combined: early IME starts while read and outline are pending; both late operations are rejected', async t => {
  const f = await combinedWorkspace(t), gate = deferred(); const disk = await f.store.readNote(f.file), before = f.note.state;
  f.api.readNote = () => gate.promise; f.jump(100); const refresh = f.note.refresh();
  f.view.compositionStarted = true; f.signal('compositionstart'); gate.resolve({ ...disk, content: 'must not replace', hash: 'new' });
  assert.equal(await refresh, 'stale'); f.flush(); assert.equal(f.note.state, before); assert.equal(f.frames.size, 0); assert.notEqual(f.note.text, 'must not replace');
});
test('combined: composition in another view blocks the shared document refresh', async t => {
  const f = await combinedWorkspace(t), otherTab = await f.ws.open(f.file, 'secondary', true);
  const other = { state: f.view.state, compositionStarted: true, composing: false, update(transactions) { for (const tr of transactions) this.state = tr.state; } };
  const detach = f.note.attach(other, otherTab); t.after(detach);
  await fs.writeFile(f.file, '# 外部共享更新'); assert.equal(await f.note.refresh(), 'skipped'); assert.equal(f.reads.length, 0);
  other.compositionStarted = false; assert.equal(await f.note.refresh(), 'reloaded'); f.flush(); assert.equal(other.state.doc.toString(), f.note.text);
});
test('combined: reduced motion clears editing effects and directly finishes outline navigation', async t => {
  const f = await combinedWorkspace(t); f.erase(); assert.equal(f.echoes().length, 1);
  f.app.dataset.motion = 'reduced'; f.notify(); assert.equal(f.echoes().length, 0); assert.equal(active(f).length, 0);
  f.jump(100); f.flush(); assert.equal(f.nativeHandled, false); assert.equal(f.frames.size, 0);
  f.app.dataset.motion = 'full'; f.notify(); f.jump(4); f.flush(); f.frame(); assert.ok(f.frames.size > 0);
  f.media.matches = true; f.notify(); f.frame(); assert.equal(f.frames.size, 0); assert.equal(active(f).length, 0);
});
test('combined: refreshed UTF-8 BOM/CRLF survives a subsequent immediate edit and save', async t => {
  const f = await combinedWorkspace(t); f.jump(100); f.flush();
  await fs.writeFile(f.file, '\ufeff# 新版本\r\n中文 😀\r\n'); assert.equal(await f.note.refresh(), 'reloaded'); f.flush();
  assert.equal(f.note.note.bom, true); assert.equal(f.note.note.eol, '\r\n'); f.insert('新'); assert.equal(await f.note.save(), true);
  const bytes = await fs.readFile(f.file); assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(bytes.toString(), '\ufeff' + f.note.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'));
});
test('combined: F5 during a real pending save skips the read while outline remains a selection-only operation', async t => {
  const f = await combinedWorkspace(t), gate = deferred(), entered = deferred(); const write = f.api.saveNote;
  f.insert('x'); f.api.saveNote = async input => { entered.resolve(); await gate.promise; return write(input); };
  const saving = f.note.save(); await entered.promise; f.jump(100); f.flush();
  assert.equal(await f.note.refresh(), 'skipped'); assert.equal(f.reads.length, 0);
  gate.resolve(); assert.equal(await saving, true); assert.equal(await fs.readFile(f.file, 'utf8'), f.note.text); f.complete();
});
