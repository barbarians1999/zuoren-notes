require('./typescript-loader.cjs');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const { FileStore } = require('../electron/storage.cjs');
const { validateSession, sessionFilePaths } = require('../electron/session.cjs');
const { SessionWriter } = require('../src/sessionWriter.cjs');
const { filePathKey } = require('../src/pathIdentity.cjs');
let NoteWorkspace, SessionRecovery, source;
before(async () => {
  ({ NoteWorkspace } = await import('../src/workspace/noteWorkspace.ts'));
  ({ SessionRecovery } = await import('../src/sessionRecovery.ts'));
  source = await fs.readFile(path.join(__dirname, '../src/main.tsx'), 'utf8');
});
const entry = value => ({ path: value, name: path.basename(value), relative: value, type: 'md' });
function snapshot(ws, catalog, extra = {}) {
  // Same ownership-before-projection order as the renderer snapshot.
  const pendingNoteDocuments = catalog.snapshot(ws.documents.values());
  const value = { version: 3, root: null, currentDirectory: null, layout: 'note', sidebar: true, splitAt: 52,
    activePdf: null, activeEpub: null, scrollMemory: [], pendingNoteDocuments, ...ws.sessionFields(), ...extra };
  assert.ok(validateSession(value), 'every persisted snapshot must pass the real IPC validator');
  return JSON.parse(JSON.stringify(value));
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-session-recovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = ['a.md', 'b.md', 'other.md'].map(name => path.join(root, name));
  for (const file of paths) await fs.writeFile(file, `disk ${path.basename(file)}`);
  const store = new FileStore(); await store.grantRoot(root);
  const api = { readNote: value => store.readNote(value), checkRecovery: value => store.checkRecovery(value.sourcePath, value.recoveryId),
    writeRecovery: value => store.writeRecovery(value), deleteRecovery: value => store.deleteRecoveryIfHash(value.sourcePath, value.recoveryId, value.draftHash),
    saveNote: value => store.saveNote(value) };
  const initial = new NoteWorkspace(() => api, { has: () => false }, () => {}), ids = paths.slice(0, 2).map(() => randomUUID());
  for (const [index, file] of paths.slice(0, 2).entries()) {
    await initial.open(file, 'primary', true, ids[index]);
    const note = await store.readNote(file);
    await store.writeRecovery({ sourcePath: file, recoveryId: ids[index], paneHint: 'primary', baseHash: note.hash,
      content: `UNSAVED ${path.basename(file)}`, encoding: { bom: false, eol: '\n' } });
  }
  const oldCatalog = new SessionRecovery(); oldCatalog.seed(null);
  const session = snapshot(initial, oldCatalog);
  const catalog = new SessionRecovery(), messages = [], ws = new NoteWorkspace(() => api, { has: () => false }, text => messages.push(text));
  ws.subscribe(() => catalog.capture(ws.documents.values()));
  return { root, paths, ids, store, api, session, catalog, ws, messages };
}
async function startup(f, launch, settings = { session: f.session }) {
  let ready = false;
  const state = { files: [], message: '' };
  const context = { workspace: f.ws, sessionRecovery: { current: f.catalog }, openSequence: { current: 0 }, documentKey: filePathKey,
    reader: () => ({ ...f.api, getLaunchItems: async () => launch, getSettings: async () => { if (settings instanceof Error) throw settings; return settings; },
      listWorkspace: async () => ({ files: [] }) }), readerSession: { flush: async () => true },
    setSessionReady: value => { ready = value; }, setMessage: value => { state.message = typeof value === 'function' ? value(state.message) : value; },
    setFiles: value => { state.files = typeof value === 'function' ? value(state.files) : value; },
    loadDirectory: async () => {}, setRoot: () => {}, setSidebar: () => {}, setSplitAt: () => {}, setScrollMemory: () => {},
    setLayout: () => {}, setActiveSurface: () => {}, releaseMutationBarrier: () => {} };
  vm.createContext(context);
  const openStart = source.indexOf('  async function openEntry('), openEnd = source.indexOf('\n  openEntryRef.current = openEntry;', openStart);
  vm.runInContext(stripTypeScriptTypes(source.slice(openStart, openEnd)), context);
  const start = source.indexOf('      const fromPath ='), end = source.indexOf('\n    })();', start);
  assert.ok(openStart > 0 && openEnd > openStart && start > 0 && end > start);
  await vm.runInContext(`(async () => {${stripTypeScriptTypes(source.slice(start, end))}})()`, context);
  assert.equal(ready, true); return { state, context };
}

test('actual startup restores every selected file, not just the first recovery ID', async t => {
  const f = await fixture(t); await startup(f, { files: f.paths.slice(0, 2).map(entry) });
  assert.deepEqual([...f.ws.documents.values()].map(doc => doc.text), ['UNSAVED a.md', 'UNSAVED b.md']);
  assert.deepEqual(snapshot(f.ws, f.catalog).noteDocuments.map(doc => doc.recoveryId), f.ids);
  assert.equal(f.ws.currentDocument().note.path, f.paths[0], 'the first requested file retains focus');
  for (const file of f.paths.slice(0, 2)) assert.equal(await fs.readFile(file, 'utf8'), `disk ${path.basename(file)}`, 'recovery itself never overwrites source');
});

for (const kind of ['other-file', 'other-folder']) test(`opening ${kind} preserves old recovery references through save and restart`, async t => {
  const f = await fixture(t);
  await startup(f, kind === 'other-file' ? { files: [entry(f.paths[2])] } : { root: f.root, files: [] });
  let saved; await new SessionWriter().write(snapshot(f.ws, f.catalog), async value => { saved = JSON.parse(JSON.stringify(value)); });
  assert.equal(saved.pendingNoteDocuments.length, 2); assert.ok(!JSON.stringify(saved).includes('UNSAVED'));
  const catalog = new SessionRecovery(); catalog.seed(saved);
  const ws = new NoteWorkspace(() => f.api, { has: () => false }, () => {});
  for (const file of f.paths.slice(0, 2)) await catalog.open(ws, file, 'primary', true);
  assert.deepEqual([...ws.documents.values()].map(doc => doc.text), ['UNSAVED a.md', 'UNSAVED b.md']);
  assert.deepEqual(snapshot(ws, catalog).noteDocuments.map(doc => doc.recoveryId), f.ids);
});

for (const failure of ['read', 'recovery']) test(`${failure} failure keeps the exact old reference across repeated session writes`, async t => {
  const f = await fixture(t), method = failure === 'read' ? 'readNote' : 'checkRecovery', original = f.api[method];
  f.api[method] = async value => { if ((typeof value === 'string' ? value : value.sourcePath) === f.paths[1]) throw Error('simulated unavailable'); return original(value); };
  await startup(f, { files: f.paths.slice(0, 2).map(entry) });
  let saved = snapshot(f.ws, f.catalog); assert.equal(saved.pendingNoteDocuments.find(doc => doc.path === f.paths[1]).recoveryId, f.ids[1]);
  const catalog = new SessionRecovery(); catalog.seed(saved);
  const ws = new NoteWorkspace(() => f.api, { has: () => false }, () => {});
  await assert.rejects(catalog.open(ws, f.paths[1], 'primary', true));
  saved = snapshot(ws, catalog); assert.ok(JSON.stringify(saved).includes(f.ids[1]));
  f.api[method] = original; await catalog.open(ws, f.paths[1], 'primary', true);
  assert.equal(ws.currentDocument().text, 'UNSAVED b.md');
});

test('failed persistence does not consume pending references and retry writes the same IDs', async t => {
  const f = await fixture(t); f.catalog.seed(f.session); const writer = new SessionWriter();
  await assert.rejects(writer.write(snapshot(f.ws, f.catalog), async () => { throw Error('disk full'); }), /disk full/);
  let saved; await writer.write(snapshot(f.ws, f.catalog), async value => { saved = value; });
  assert.deepEqual(saved.pendingNoteDocuments.map(doc => doc.recoveryId), f.ids);
});

test('alternate draft survives opening, last-tab close and restart without rehydrating over live text', async t => {
  const f = await fixture(t), alternate = randomUUID(), note = await f.store.readNote(f.paths[0]);
  await f.store.writeRecovery({ sourcePath: f.paths[0], recoveryId: alternate, paneHint: 'secondary', baseHash: note.hash,
    content: 'ALTERNATE', encoding: { bom: false, eol: '\n' } });
  f.session.noteDocuments[0].retainedRecoveries.push({ sourcePath: f.paths[0], recoveryId: alternate });
  f.catalog.seed(f.session); const tab = await f.catalog.open(f.ws, f.paths[0], 'primary', true);
  assert.equal(tab.document.text, 'UNSAVED a.md'); assert.ok(tab.document.retainedRecoveryIds.includes(alternate));
  assert.equal(await f.ws.close('primary', tab), true);
  const saved = snapshot(f.ws, f.catalog); assert.ok(JSON.stringify(saved.pendingNoteDocuments).includes(alternate));
  const catalog = new SessionRecovery(); catalog.seed(saved);
  const ws = new NoteWorkspace(() => f.api, { has: () => false }, () => {}); await catalog.open(ws, f.paths[0], 'primary', true);
  assert.equal(ws.currentDocument().text, 'UNSAVED a.md', 'the saved primary text remains primary');
  assert.ok(ws.currentDocument().retainedRecoveryIds.includes(alternate));
  assert.equal((await f.store.checkRecovery(f.paths[0], alternate)).recovery.content, 'ALTERNATE');
});

test('legacy dual drafts and case-normalized duplicate records retain both primary IDs', () => {
  const a = randomUUID(), b = randomUUID(), c = randomUUID(), file = 'C:\\notes\\a.md';
  const catalog = new SessionRecovery(); catalog.seed({ version: 2, primaryNote: { path: file, recoveryId: a }, secondaryNote: { path: file.toUpperCase(), recoveryId: b } });
  assert.equal(catalog.recoveryId(file.toUpperCase()), a);
  assert.deepEqual(new Set(catalog.snapshot([])[0].retainedRecoveries.map(ref => ref.recoveryId)), new Set([b]));
  catalog.seed({ version: 3, noteDocuments: [{ path: file, recoveryId: c, retainedRecoveryIds: [] }], pendingNoteDocuments: catalog.snapshot([]) });
  assert.equal(catalog.recoveryId(file), c);
  assert.deepEqual(new Set(catalog.snapshot([])[0].retainedRecoveries.map(ref => ref.recoveryId)), new Set([a, b]));
});

test('catalog remap and grant enumeration include unavailable owners and alternate source paths', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external', 'original.md'), alternate = randomUUID();
  f.session.noteDocuments[0].retainedRecoveries.push({ sourcePath: external, recoveryId: alternate });
  f.catalog.seed(f.session); const moved = `${f.root}-renamed`; f.catalog.remap(f.root, moved);
  const saved = snapshot(f.ws, f.catalog), paths = sessionFilePaths(saved);
  assert.ok(paths.includes(path.join(moved, 'a.md'))); assert.ok(paths.includes(path.join(moved, 'external', 'original.md')));
  assert.ok(!paths.includes(f.paths[0])); assert.equal(f.catalog.recoveryId(path.join(moved, 'b.md')), f.ids[1]);
});

test('pending schema is exact, rejects text and malformed references, and is not capped by open tab count', async t => {
  const f = await fixture(t); f.catalog.seed(f.session); const saved = snapshot(f.ws, f.catalog);
  assert.equal(validateSession({ ...saved, pendingNoteDocuments: [{ ...saved.pendingNoteDocuments[0], content: 'private' }] }), null);
  assert.equal(validateSession({ ...saved, pendingNoteDocuments: [{ ...saved.pendingNoteDocuments[0], path: 'relative.md' }] }), null);
  assert.equal(validateSession({ ...saved, pendingNoteDocuments: [...saved.pendingNoteDocuments, saved.pendingNoteDocuments[0]] }), null);
  const many = Array.from({ length: 110 }, (_, index) => ({ path: path.join(f.root, `${index}.md`), recoveryId: randomUUID(), retainedRecoveries: [] }));
  assert.ok(validateSession({ ...saved, pendingNoteDocuments: many }));
});

test('an unavailable middle file does not prevent later selected drafts from opening', async t => {
  const f = await fixture(t), read = f.api.readNote;
  f.api.readNote = async value => { if (value === f.paths[1]) throw Error('unavailable middle file'); return read(value); };
  await startup(f, { files: f.paths.map(entry) });
  assert.ok([...f.ws.documents.values()].some(doc => doc.note.path === f.paths[2]));
  assert.ok(snapshot(f.ws, f.catalog).pendingNoteDocuments.some(doc => doc.recoveryId === f.ids[1]));
});

test('superseded open and tab-cap failure never consume the catalog entry', async t => {
  const f = await fixture(t); f.catalog.seed(f.session); const read = f.api.readNote;
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  f.api.readNote = async value => { if (value === f.paths[0]) { entered(); await new Promise(resolve => { release = resolve; }); } return read(value); };
  const opening = f.catalog.open(f.ws, f.paths[0], 'primary', true); await started;
  await f.catalog.open(f.ws, f.paths[2], 'primary', true); release(); assert.equal(await opening, null);
  assert.ok(snapshot(f.ws, f.catalog).pendingNoteDocuments.some(doc => doc.recoveryId === f.ids[0]));
  const ws = new NoteWorkspace(() => f.api, { has: () => false }, () => {});
  for (let index = 0; index < 100; index++) ws.blank();
  await ws.open(f.paths[2], 'primary', true); // Replace the current blank, leaving 100 tabs and no current blank to reuse.
  assert.equal(await f.catalog.open(ws, f.paths[1], 'primary', true), null);
  assert.ok(snapshot(ws, f.catalog).pendingNoteDocuments.some(doc => doc.recoveryId === f.ids[1]));
});

test('opening a catalog path already edited under a new ID retains the old draft without replacing edits', async t => {
  const f = await fixture(t), currentId = randomUUID(), tab = await f.ws.open(f.paths[0], 'primary', true, currentId);
  tab.document.replaceText('LIVE EDITS'); f.catalog.seed(f.session);
  await f.catalog.open(f.ws, f.paths[0], 'primary', true);
  assert.equal(tab.document.text, 'LIVE EDITS'); assert.equal(tab.document.recoveryId, currentId);
  assert.ok(tab.document.retainedRecoveryIds.includes(f.ids[0]));
  assert.ok(JSON.stringify(snapshot(f.ws, f.catalog)).includes(f.ids[0]));
});

test('a settings read failure cannot overwrite the previous session with an empty new one', async t => {
  const f = await fixture(t), { context } = await startup(f, { files: [] }, Error('settings read failed'));
  assert.equal(f.catalog.initialized, false);
  await assert.rejects(f.catalog.open(f.ws, f.paths[0], 'primary', true), /保护恢复稿/);
  assert.equal(f.ws.documents.size, 0, 'no new unrelated recovery identity is created before reading the old catalog');
  let writes = 0; context.sessionWriter = { current: new SessionWriter() };
  context.sessionSnapshot = () => { writes++; throw Error('must not snapshot before initialization'); };
  const start = source.indexOf('    if (!sessionRecovery.current.initialized)'), end = source.indexOf('\n  }, [sessionSnapshot]);', start);
  const result = await vm.runInContext(stripTypeScriptTypes(`(async (force = false) => {${source.slice(start, end)}})()`), context);
  assert.equal(result, false); assert.equal(writes, 0);
});

test('synchronous rename notifications cannot reattach the old path for an already-remapped retained draft', async t => {
  const f = await fixture(t), oldSource = path.join(f.root, 'old.md'), newSource = path.join(f.root, 'new.md'), id = randomUUID();
  f.session.noteDocuments[0].retainedRecoveries.push({ sourcePath: oldSource, recoveryId: id });
  f.catalog.seed(f.session); const tab = await f.catalog.open(f.ws, f.paths[0], 'primary', true);
  f.catalog.remap(oldSource, newSource, () => f.ws.remap(oldSource, newSource));
  assert.deepEqual(tab.document.recoveryReferences.filter(item => item.recoveryId === id), [{ sourcePath: newSource, recoveryId: id }]);
  assert.ok(validateSession(snapshot(f.ws, f.catalog)));
  const moved = `${f.root}-moved`; f.catalog.remap(f.root, moved, () => f.ws.remap(f.root, moved));
  const saved = snapshot(f.ws, f.catalog);
  assert.ok(!JSON.stringify(saved).includes(f.root + '/'));
  assert.ok(sessionFilePaths(saved).includes(path.join(moved, 'new.md')));
});

test('actual choose-files and secondary-pane routes both use the preserved recovery catalog', async t => {
  const f = await fixture(t), { context } = await startup(f, { root: f.root, files: [] });
  context.reader = () => ({ ...f.api, chooseFiles: async () => f.paths.slice(0, 2).map(entry) });
  const start = source.indexOf('  async function openFiles('), end = source.indexOf('\n  async function openBrowserEntry(', start);
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context); await context.openFiles('primary');
  assert.deepEqual([...f.ws.documents.values()].map(doc => doc.text), ['UNSAVED a.md', 'UNSAVED b.md']);
  const second = await fixture(t), runtime = await startup(second, { root: second.root, files: [] });
  Object.assign(runtime.context, { activePdf: null, activeEpub: null, layout: 'note' });
  const secondaryStart = source.indexOf('  async function openNoteInSecondary('), secondaryEnd = source.indexOf('\n  function excerptTarget(', secondaryStart);
  vm.runInContext(stripTypeScriptTypes(source.slice(secondaryStart, secondaryEnd)), runtime.context);
  await runtime.context.openNoteInSecondary(entry(second.paths[1]));
  assert.equal(second.ws.currentDocument('secondary').text, 'UNSAVED b.md');
  assert.equal(second.ws.currentDocument('secondary').recoveryId, second.ids[1]);
});

test('normal session restore retains a temporarily unreadable note for the following restart', async t => {
  const f = await fixture(t), read = f.api.readNote;
  f.api.readNote = async value => { if (value === f.paths[1]) throw Error('temporarily missing'); return read(value); };
  await startup(f, { files: [] });
  const saved = snapshot(f.ws, f.catalog);
  assert.equal(saved.noteDocuments[0].recoveryId, f.ids[0]);
  assert.equal(saved.pendingNoteDocuments[0].recoveryId, f.ids[1]);
  const catalog = new SessionRecovery(); catalog.seed(saved); f.api.readNote = read;
  const ws = new NoteWorkspace(() => f.api, { has: () => false }, () => {});
  await catalog.open(ws, f.paths[1], 'primary', true); assert.equal(ws.currentDocument().text, 'UNSAVED b.md');
});

async function settingsIpc(readSettings, settingsWarning = '') {
  const main = await fs.readFile(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const marker = "  handle('get-settings', async () => {", start = main.indexOf(marker), end = main.indexOf('\n  });', start);
  assert.ok(start > 0 && end > start);
  return vm.runInNewContext(`(async () => {${main.slice(start + marker.length, end)}})()`, {
    readSettings, settingsWarning, emptySettings: () => ({ recentFiles: [], roots: [], session: null }),
  });
}

test('actual get-settings IPC read failure cannot erase old draft references after disk access recovers', async t => {
  const f = await fixture(t), envelope = await settingsIpc(async () => { throw Error('temporary settings EACCES'); });
  assert.equal(envelope.session, null); assert.match(envelope.warning, /无法读取或保留设置文件/);
  const { context } = await startup(f, { files: [entry(f.paths[2])] }, envelope);
  const { SettingsStore } = require('../electron/settings.cjs'); let saved = { session: f.session }, writes = 0;
  const store = new SettingsStore({ read: async () => saved, write: async value => { writes++; saved = value; return value; } });
  context.sessionWriter = { current: new SessionWriter() };
  context.sessionSnapshot = () => snapshot(f.ws, f.catalog);
  context.reader = () => ({ saveSession: session => store.update(current => ({ ...current, session })) });
  const start = source.indexOf('    if (!sessionRecovery.current.initialized)'), end = source.indexOf('\n  }, [sessionSnapshot]);', start);
  const result = await vm.runInContext(stripTypeScriptTypes(`(async (force = false) => {${source.slice(start, end)}})()`), context);
  assert.equal(result, false, 'the rejected initialization also blocks the real renderer session-save path');
  assert.equal(writes, 0); assert.equal(f.catalog.initialized, false); assert.equal(f.ws.documents.size, 0);
  for (const id of f.ids) assert.ok(JSON.stringify(saved.session).includes(id));
  for (const [index, file] of f.paths.slice(0, 2).entries()) assert.equal((await f.store.checkRecovery(file, f.ids[index])).status, 'recoverable');
});

test('a successful settings IPC read with a backed-up-corruption warning still permits normal initialization', async t => {
  const f = await fixture(t), envelope = await settingsIpc(async () => ({ recentFiles: [], roots: [], session: null }),
    '设置文件损坏，原件已保留在 settings.json.corrupt-test；已使用空设置启动。');
  assert.ok(envelope.warning); assert.notEqual(envelope.settingsReadFailed, true);
  await startup(f, { files: [entry(f.paths[2])] }, envelope);
  assert.equal(f.catalog.initialized, true); assert.equal(f.ws.currentDocument().note.path, f.paths[2]);
  assert.ok(validateSession(snapshot(f.ws, f.catalog)));
});
