require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { EventEmitter } = require('node:events');
const { installFileRefreshShortcut } = require('../electron/file-refresh-shortcut.cjs');
const { combinedWorkspace } = require('./helpers/combined-workspace.cjs');

// Execute the current JSX callbacks without mounting a browser. The extraction
// assertions intentionally fail when production wiring changes, so the model
// cannot silently retain an old copy of the routing policy.
function expression(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const begin = at + marker.length; let depth = 1;
  for (let end = begin; end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) return source.slice(begin, end);
  }
  assert.fail('unterminated production callback: ' + marker);
}
async function wiring(workspace, options = {}) {
  const { requestNoteRefresh } = await import('../src/workspace/noteRefresh.ts');
  const main = fs.readFileSync(path.join(__dirname, '../src/main.tsx'), 'utf8');
  const pdf = fs.readFileSync(path.join(__dirname, '../src/readers/PdfPane.tsx'), 'utf8');
  const activeSurfaceRef = { current: 'note' }, scheduledState = [], messages = [];
  const setter = /const setActiveSurface = useCallback\(([\s\S]*?), \[\]\);/.exec(main); assert.ok(setter, 'synchronous activation setter');
  const compiled = stripTypeScriptTypes('const setSurface = ' + setter[1], { mode: 'transform' });
  const setSurface = new Function('activeSurfaceRef', 'setActiveSurfaceState', compiled + ';return setSurface;')(activeSurfaceRef, value => scheduledState.push(value));
  const activatePdf = new Function('setActiveSurface', 'return (' + expression(main, '<PdfPane onActivate={') + ');')(setSurface);
  let focused = 0;
  class ElementStub { closest() { return null; } }
  const pointerPdf = new Function('onActivate', 'pane', 'Element', 'return (' + expression(pdf, 'onPointerDownCapture={') + ');')(
    activatePdf, { current: { focus() { focused++; } } }, ElementStub);
  assert.match(pdf, /onFocusCapture=\{onActivate\}/, 'keyboard focus activates the same PDF surface');
  assert.match(main, /activeSurface: activeSurfaceRef\.current/, 'native subscription reads synchronous current activation');
  let last = null;
  const marker = 'useEffect(() => reader().onRefreshNote(() => {';
  const body = expression(main, marker);
  const onRefresh = new Function('requestNoteRefresh', 'workspace', 'sessionReady', 'closing', 'readerClosing', 'settingsOpen', 'document', 'layout', 'activeSurfaceRef', 'setMessage',
    'return () => {' + body + '};')((...args) => last = requestNoteRefresh(...args), workspace, options.ready ?? true,
    !!options.closing, !!options.readerClosing, !!options.settingsOpen, { querySelector: selector => { assert.equal(selector, '[role="dialog"]'); return options.dialogOpen ? {} : null; } }, options.layout || 'split', activeSurfaceRef, value => messages.push(value));
  const ipc = new EventEmitter(), contents = new EventEmitter(); let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => api = value } }; },
  });
  contents.send = channel => ipc.emit(channel, { fakeElectronEvent: true });
  const offNative = installFileRefreshShortcut(contents), offBridge = api.onRefreshNote(onRefresh);
  return { messages, scheduledState, activeSurfaceRef,
    note: () => setSurface('note'), pdfFocus: activatePdf,
    pdfPointer: () => pointerPdf({ target: new ElementStub() }), get focused() { return focused; },
    async key(input = {}) { last = null; let prevented = false;
      contents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'F5', ...input });
      return { prevented, outcome: last && await last }; },
    close() { offBridge(); offNative(); },
  };
}
function workspaceStub() {
  let refreshes = 0;
  const ws = { committing: false, currentDocument: () => ({ refresh: async () => { refreshes++; return 'unchanged'; } }) };
  return { ws, get refreshes() { return refreshes; } };
}

for (const kind of ['pdfFocus', 'pdfPointer']) test(`native F5: note to ${kind} activation routes to reader even before a React state commit`, async () => {
  const stub = workspaceStub(), f = await wiring(stub.ws); f.note(); f[kind]();
  assert.equal(f.activeSurfaceRef.current, 'reader'); assert.equal(f.scheduledState.at(-1), 'reader');
  assert.deepEqual(await f.key(), { prevented: true, outcome: 'reader' }); assert.equal(stub.refreshes, 0);
  assert.match(f.messages[0], /PDF、EPUB/); if (kind === 'pdfPointer') assert.equal(f.focused, 1); f.close();
});
test('native F5: returning to a note immediately refreshes that note through the actual bridge/router', async () => {
  const stub = workspaceStub(), f = await wiring(stub.ws); f.pdfFocus(); f.note();
  assert.deepEqual(await f.key(), { prevented: true, outcome: 'unchanged' }); assert.equal(stub.refreshes, 1); f.close();
});
for (const reason of ['not-ready', 'closing', 'readerClosing', 'settingsOpen', 'dialogOpen', 'committing']) test(`native F5: ${reason} gate precedes any document access`, async () => {
  const ws = { committing: reason === 'committing', currentDocument: () => assert.fail('gate must not inspect an active document') };
  const f = await wiring(ws, reason === 'not-ready' ? { ready: false } : { [reason]: true });
  assert.deepEqual(await f.key(), { prevented: true, outcome: 'blocked' }); assert.deepEqual(f.messages, []); f.close();
});
for (const flag of ['isComposing', 'isAutoRepeat', 'control']) test(`native F5: ${flag} never reaches the renderer router`, async () => {
  const stub = workspaceStub(), f = await wiring(stub.ws); assert.deepEqual(await f.key({ [flag]: true }), { prevented: true, outcome: null });
  assert.equal(stub.refreshes, 0); f.close();
});
test('native F5: reader-only layout and an empty note tab retain their explicit scope', async () => {
  const stub = workspaceStub(), reader = await wiring(stub.ws, { layout: 'read' }); assert.equal((await reader.key()).outcome, 'reader'); assert.equal(stub.refreshes, 0); reader.close();
  const empty = await wiring({ committing: false, currentDocument: () => null }); assert.equal((await empty.key()).outcome, 'empty'); assert.match(empty.messages[0], /Markdown/); empty.close();
});
test('native F5: the currently active split group is refreshed and the other file is untouched', async t => {
  const f = await combinedWorkspace(t), right = await f.ws.open(f.secondFile, 'secondary', true), route = await wiring(f.ws); t.after(route.close);
  f.reads.length = 0; // Count this key press, after the fixture's initial open.
  await fsp.writeFile(f.secondFile, '# 外部右栏新版本'); const left = f.note.text;
  assert.equal((await route.key()).outcome, 'reloaded'); assert.equal(right.document.text, '# 外部右栏新版本'); assert.equal(f.note.text, left);
  assert.deepEqual(f.reads, [f.secondFile]); assert.equal(f.saves.length, 0);
});
