const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mockView } = require('./combined-motion.cjs');
const { FileStore } = require('../../electron/storage.cjs');

async function combinedWorkspace(t, options = {}) {
  const { EditorState, EditorSelection } = await import('@codemirror/state');
  const { EditorView } = await import('@codemirror/view');
  const { markdownSyntax } = await import('../../src/editor/markdownLanguage.ts');
  const { NoteWorkspace } = await import('../../src/workspace/noteWorkspace.ts');
  const outline = await import('../../src/editor/outlineScrollMotion.ts');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-combined-'));
  const file = path.join(root, 'fixture.md'), secondFile = path.join(root, 'second.md');
  const body = Array.from({ length: 90 }, (_, index) => `## 标题 ${index}\n普通中文 paragraph 😀`).join('\n');
  await fs.writeFile(file, body); await fs.writeFile(secondFile, '# 第二篇\n');
  const store = new FileStore(); await store.grantRoot(root);
  const messages = [], saves = [], reads = [];
  const api = { readNote: async path => { reads.push(path); return store.readNote(path); },
    checkRecovery: async () => ({ status: 'none' }), writeRecovery: async () => {}, deleteRecovery: async () => true,
    saveNote: async input => { saves.push(input); return store.saveNote(input); } };
  const ws = new NoteWorkspace(() => api, { has: () => false }, message => messages.push(message));
  const tab = await ws.open(file, 'primary', true), note = tab.document; ws.ready = true;
  const mock = await mockView(options), { view, cursor, scroll, content } = mock;
  let now = 1000, nextFrame = 0, pendingTarget = null, nativeHandled = null;
  const frames = new Map(), oldFrames = [], phases = [];
  const events = new Map(), doc = mock.doc, win = doc.defaultView;
  doc.addEventListener = (name, cb) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(cb); };
  doc.removeEventListener = (name, cb) => events.get(name)?.delete(cb);
  const signal = (name, event = {}) => { for (const cb of events.get(name) || []) cb(event); };
  win.performance.now = () => now;
  win.requestAnimationFrame = cb => { const id = ++nextFrame; frames.set(id, cb); oldFrames.push(cb); return id; };
  win.cancelAnimationFrame = id => frames.delete(id);
  scroll.clientHeight = scroll.offsetHeight = 500; scroll.rect.height = 500;
  Object.defineProperty(scroll, 'scrollHeight', { get: () => view.state.doc.lines * 36 + 158 });
  const rawCoords = head => {
    const line = view.state.doc.lineAt(head);
    const top = 100 + 38 + (line.number - 1) * 36 + 7.5 - scroll.scrollTop;
    return { left: 100 + (head - line.from) * 10, right: 101 + (head - line.from) * 10, top, bottom: top + 20 };
  };
  view.updateState = 0;
  view.coordsAtPos = head => {
    assert.notEqual(view.updateState, 2, 'public geometry reads cannot run in CM Updating');
    phases.push(view.updateState); return rawCoords(head);
  };
  Object.defineProperty(view, 'documentTop', { get: () => 100 + 38 - scroll.scrollTop });
  view.lineBlockAt = head => ({ top: (view.state.doc.lineAt(head).number - 1) * 36 });
  view.focus = () => { view.hasFocus = true; };
  content.getBoundingClientRect = () => ({ left: 100, top: 100 - scroll.scrollTop, width: 800, height: scroll.scrollHeight });
  cursor.getBoundingClientRect = () => ({ ...cursor.rect, top: cursor.rect.top - scroll.scrollTop, bottom: cursor.rect.top - scroll.scrollTop + cursor.rect.height, right: cursor.rect.left + cursor.rect.width });
  doc.createRange = () => { let from, to; return {
    setStart(_node, value) { from = value; }, setEnd(_node, value) { to = value; },
    toString: () => view.state.sliceDoc(from, to), getClientRects: () => { const rect = rawCoords(from); return [{ ...rect, width: (to - from) * 10, height: 20 }]; },
  }; };
  const cursorKey = {};
  const queueCursor = () => view.requestMeasure({ key: cursorKey, read: () => view.coordsAtPos(view.state.selection.main.head),
    write: rect => { cursor.rect = { left: rect.left, top: rect.top + scroll.scrollTop, width: 1, height: 20 }; } });
  mock.replaceState(EditorState.create({ doc: note.state.doc, selection: EditorSelection.cursor(note.state.doc.line(2).from + 2),
    extensions: [markdownSyntax(), outline.sourceOutlineScrollMotion] }));
  tab.selection = view.state.selection;
  const detach = note.attach(view, tab);
  view.update = transactions => { for (const transaction of transactions) {
    const before = view.state; view.state = transaction.state;
    if (pendingTarget && transaction.docChanged) pendingTarget = { ...pendingTarget, range: pendingTarget.range.map(transaction.changes) };
    for (const effect of transaction.effects) if (effect.value?.range && typeof effect.value.y === 'string') pendingTarget = effect.value;
    queueCursor();
    const update = { view, startState: before, state: view.state, transactions: [transaction], changes: transaction.changes,
      docChanged: transaction.docChanged, selectionSet: !!transaction.selection, focusChanged: false, geometryChanged: transaction.docChanged };
    for (const callback of view.state.facet(EditorView.updateListener)) callback(update);
    mock.motion.updateMarkdownMotion(update);
  } };
  view.dispatch = spec => note.dispatch(view, [view.state.update(spec)]);
  function flush() {
    let count = 0;
    while (mock.measures.length) {
      assert.ok(count++ < 30, 'CM measurement queue settles');
      const requests = mock.measures.splice(0); view.updateState = 1;
      const values = requests.map(request => request.read(view)); view.updateState = 2;
      requests.forEach((request, index) => request.write?.(values[index], view));
    }
    if (pendingTarget) {
      const target = pendingTarget; pendingTarget = null; view.updateState = 2;
      nativeHandled = view.state.facet(EditorView.scrollHandler)[0](view, target.range, target);
      if (!nativeHandled) scroll.scrollTop += rawCoords(target.range.head).top - scroll.rect.top - target.yMargin;
    }
    view.updateState = 0;
  }
  function frame(ms = 16, notify = true) {
    now += ms; mock.setClock(now); const pending = [...frames.values()]; frames.clear();
    for (const cb of pending) cb(now);
    if (notify) scroll.fire('scroll');
  }
  function complete() { for (let count = 0; frames.size && count < 40; count++) frame(); assert.equal(frames.size, 0); }
  const input = (type = 'insertText') => { now += 200; mock.setClock(now); mock.fire('beforeinput', { inputType: type }); };
  const insert = value => { input(); const at = view.state.selection.main.head; view.dispatch({ changes: { from: at, insert: value }, selection: EditorSelection.cursor(at + value.length), userEvent: 'input.type' }); flush(); };
  const erase = () => { input('deleteContentBackward'); const at = view.state.selection.main.head; view.dispatch({ changes: { from: at - 1, to: at }, selection: EditorSelection.cursor(at - 1, -1), userEvent: 'delete.backward' }); flush(); };
  const jump = (line, focus = true) => outline.scrollSourceOutline(view, view.state.doc.line(line).from, focus);
  const activeCaret = () => mock.animations.filter(item => item.element === cursor && item.playState === 'running');
  const echoes = () => mock.root.children.filter(item => item.className === 'cm-edit-echo-layer' && item.isConnected);
  queueCursor(); flush(); reads.length = 0;
  t.after(async () => {
    outline.sourceOutlineScrollMotion.at(-1).create(view).destroy(); detach(); note.dispose(); mock.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...mock, rootPath: root, file, secondFile, store, api, ws, tab, note, messages, saves, reads, frames, oldFrames, phases,
    flush, frame, complete, input, insert, erase, jump, signal, activeCaret, echoes, get nativeHandled() { return nativeHandled; } };
}
module.exports = { combinedWorkspace };
