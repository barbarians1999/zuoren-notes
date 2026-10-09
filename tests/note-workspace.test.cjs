require('./typescript-loader.cjs');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
let EditorState, EditorSelection, Transaction, undo, redo, isolateHistory, NoteWorkspace, documentKey;
before(async () => {
  ({ EditorState, EditorSelection, Transaction } = await import('@codemirror/state'));
  ({ undo, redo, isolateHistory } = await import('@codemirror/commands'));
  ({ NoteWorkspace, documentKey } = await import('../src/workspace/noteWorkspace.ts'));
});
const { validateSession, sessionFilePaths } = require('../electron/session.cjs');
const digest = text => createHash('sha256').update(text).digest('hex');
const a = 'C:\\notes\\a.md', b = 'C:\\notes\\b.md', c = 'C:\\notes\\c.md';
function fixture() {
  const disk = new Map([a,b,c].map(path => [documentKey(path), { path, content: path === a ? '- [ ] task\n' : '# '+path, hash: digest(path === a ? '- [ ] task\n' : '# '+path), bom: false, eol: '\n' }]));
  const writes = [], drafts = new Map(), messages = [];
  const api = {
    readNote: async path => ({ ...disk.get(documentKey(path)) }),
    checkRecovery: async ({ recoveryId }) => drafts.get(recoveryId) || { status: 'none' },
    deleteRecovery: async ({ recoveryId }) => { drafts.delete(recoveryId); return true; },
    writeRecovery: async input => { drafts.set(input.recoveryId, { status: 'recoverable', recovery: { ...input, draftHash: digest(input.content) } }); },
    saveNote: async input => { writes.push(input); const old = disk.get(documentKey(input.path)); if (old.hash !== input.hash) return { ...old, conflict: true }; const next = { ...old, content: input.content, hash: digest(input.content) }; disk.set(documentKey(input.path), next); drafts.delete(input.recoveryId); return { ...next, conflict: false }; },
  };
  const ws = new NoteWorkspace(() => api, { has: () => false }, message => messages.push(message));
  return { ws, api, disk, writes, drafts, messages };
}
function mount(tab) {
  const view = { state: EditorState.create({ doc: tab.document.state.doc, selection: tab.selection }), update(transactions) { for (const tr of transactions) this.state = tr.state; } };
  view.detach = tab.document.attach(view, tab); return view;
}
function edit(tab, view, from, to, insert) { tab.document.dispatch(view, [view.state.update({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')] })]); }
test('temporary replacement, pinning, and same-file deduplication are per group', async () => {
  const { ws } = fixture(); const first = await ws.open(a); await ws.open(b); assert.equal(ws.groups.primary.tabs.length, 1); assert.ok(first.document.disposed);
  const pinned = await ws.open(a, 'primary', true); await ws.open(c); assert.equal(ws.groups.primary.tabs.length, 2); assert.ok(ws.groups.primary.tabs.includes(pinned));
  await ws.open(a.toUpperCase(), 'primary'); assert.equal(ws.current(), pinned); assert.equal(ws.groups.primary.tabs.length, 2);
  await ws.open(a, 'secondary', true); assert.equal(ws.currentDocument('primary'), ws.currentDocument('secondary')); assert.equal(ws.documents.size, 2);
});

test('slow preparation belongs to each note group and a selection in the same group cancels it', async () => {
  const { ws } = fixture(); let release;
  const gate = new Promise(resolve => release = resolve);
  const left = ws.open(a, 'primary', true, undefined, async () => { await gate; return true; });
  const right = ws.open(b, 'secondary', true, undefined, async () => { await gate; return true; });
  release(); await Promise.all([left, right]);
  assert.equal(ws.currentDocument('primary').note.path, a); assert.equal(ws.currentDocument('secondary').note.path, b);
  assert.equal(ws.activeGroup, 'secondary');
  let finish;
  const waiting = new Promise(resolve => finish = resolve);
  const stale = ws.open(c, 'primary', true, undefined, async () => { await waiting; return true; });
  ws.activate('primary', ws.current('primary').id); finish();
  assert.equal(await stale, null); assert.equal(ws.currentDocument('primary').note.path, a);
  assert.equal(ws.currentDocument('secondary').note.path, b);
});

test('a late open in another group keeps its tab but cannot steal the newer active pane', async () => {
  const { ws, api } = fixture(); const read = api.readNote; let release;
  const gate = new Promise(resolve => release = resolve);
  api.readNote = async path => { if (path === a) await gate; return read(path); };
  const left = ws.open(a, 'primary', true);
  await ws.open(b, 'secondary', true); release(); await left;
  assert.equal(ws.currentDocument('primary').note.path, a);
  assert.equal(ws.currentDocument('secondary').note.path, b);
  assert.equal(ws.activeGroup, 'secondary');
});

test('excerpt destinations reject another active pane and become available again only at the captured view', async () => {
  const { ws } = fixture(); const left = await ws.open(a, 'primary', true); await ws.open(b, 'secondary', true);
  ws.activate('primary', left.id); const target = ws.captureExcerptTarget(); assert.ok(target.valid());
  ws.activate('secondary'); assert.equal(target.valid(), false);
  ws.activate('primary', left.id); assert.equal(target.valid(), true);
  await ws.close('primary', left); assert.equal(target.valid(), false);
});

test('explicit pane focus cancels an earlier tab-open focus request', async () => {
  const { ws } = fixture(); const left = await ws.open(a, 'primary', true);
  const right = await ws.open(b, 'secondary', true);
  assert.equal(ws.focusRequest, right.id);
  ws.activate('primary');
  assert.equal(ws.focusRequest, null);
  assert.equal(ws.consumeFocus(right.id), false);
  assert.equal(ws.activeGroup, 'primary');
  ws.activate('primary', left.id);
  assert.equal(ws.consumeFocus(left.id), true, 'deliberate tab activation still focuses the editor');
});

test('view mode changes publish once and focus requests are consumed by their intended view', async () => {
  const { ws } = fixture(); const tab = await ws.open(a, 'primary', true);
  const before = ws.getSnapshot(); ws.setMode('primary', tab.id, 'preview');
  assert.equal(ws.current().mode, 'preview'); assert.equal(ws.getSnapshot(), before + 1);
  ws.setMode('primary', tab.id, 'preview'); assert.equal(ws.getSnapshot(), before + 1);
  assert.equal(ws.consumeFocus('other-view'), false); assert.equal(ws.focusRequest, tab.id);
  assert.equal(ws.consumeFocus(tab.id), true); assert.equal(ws.focusRequest, null);
});
test('shared edits and reading tasks use one history and one write', async () => {
  const { ws, writes } = fixture(); const left = await ws.open(a, 'primary'), right = await ws.open(a, 'secondary');
  const lv = mount(left), rv = mount(right); edit(left, lv, lv.state.doc.length, lv.state.doc.length, 'typed');
  assert.equal(lv.state.doc.toString(), rv.state.doc.toString()); assert.equal(left.preview, false); assert.equal(right.preview, false);
  edit(right, rv, 3, 4, 'x'); assert.equal(left.document.state.doc.toString(), '- [x] task\ntyped');
  assert.equal(left.document.runHistory(undo, lv), true); assert.equal(rv.state.doc.toString(), '- [ ] task\ntyped');
  left.document.runHistory(undo, rv); assert.equal(lv.state.doc.toString(), '- [ ] task\n');
  left.document.runHistory(redo, lv); assert.equal(rv.state.doc.toString(), '- [ ] task\ntyped');
  await Promise.all([left.document.save(), right.document.save()]); assert.equal(writes.length, 1);
});
test('typing during a slow save is retained and drained before close', async () => {
  const { ws, api, writes } = fixture(); const tab = await ws.open(a), view = mount(tab); edit(tab, view, 0, 0, 'one');
  const original = api.saveNote; let release, started; const entered = new Promise(r => started = r);
  api.saveNote = async input => { api.saveNote = original; started(); await new Promise(r => release = r); return original(input); };
  const saving = tab.document.save(); await entered; edit(tab, view, 0, 0, 'two'); release(); assert.equal(await saving, true);
  assert.equal(tab.document.text, 'twoone- [ ] task\n'); assert.equal(writes.length, 2); assert.equal(tab.document.label, '已保存');
});
test('failed close and background saves retain draft, view and retry', async () => {
  const { ws, api, writes } = fixture(); const tab = await ws.open(a), view = mount(tab); edit(tab, view, 0, 0, 'draft');
  const original = api.saveNote; api.saveNote = async () => { throw Error('failure'); };
  assert.equal(await ws.close('primary', tab), false); assert.equal(ws.current(), tab); assert.ok(ws.pendingClose); assert.equal(tab.document.text, 'draft- [ ] task\n');
  api.saveNote = original; await ws.finishPendingClose(); assert.equal(ws.groups.primary.tabs.length, 0); assert.equal(writes.length, 1);
});
test('discard closes only after recovery cleanup succeeds', async () => {
  const { ws, api, drafts, messages } = fixture(); const tab = await ws.open(a), view = mount(tab); edit(tab, view, 0, 0, 'discard me');
  api.saveNote = async () => { throw Error('disk unavailable'); };
  assert.equal(await ws.close('primary', tab), false);
  const id = tab.document.recoveryId; drafts.set(id, { status: 'recoverable', recovery: { content: tab.document.text, draftHash: digest(tab.document.text) } });
  const remove = api.deleteRecovery; api.deleteRecovery = async () => { throw Error('recovery locked'); };
  await ws.finishPendingClose(true);
  assert.equal(ws.pendingClose.tab, tab); assert.equal(ws.current(), tab); assert.match(tab.document.text, /discard me/);
  assert.match(messages.at(-1), /清理失败/);
  api.deleteRecovery = remove; await ws.finishPendingClose(true);
  assert.equal(ws.groups.primary.tabs.length, 0); assert.equal(tab.document.text, tab.document.note.content); assert.equal(drafts.has(id), false);
});
test('independent open generations reject stale selection without disposing a reused document', async () => {
  const { ws, api } = fixture(); const read = api.readNote; let release;
  api.readNote = async path => { if (path === a) await new Promise(r => release = r); return read(path); };
  const slow = ws.open(a); await ws.open(b); const right = await ws.open(c, 'secondary'); release(); assert.equal(await slow, null);
  assert.equal(ws.currentDocument('primary').note.path, b); assert.equal(ws.current('secondary'), right);
  const x = ws.open(a, 'primary'), y = ws.open(a, 'primary'); const [stale, latest] = await Promise.all([x,y]);
  assert.equal(stale, null); assert.ok(latest && !latest.document.disposed);
});
test('hydration completes before either view can attach', async () => {
  const { ws, api } = fixture(); let release, entered; const gate = new Promise(r => entered = r);
  api.checkRecovery = async () => { entered(); await new Promise(r => release = r); return { status: 'recoverable', recovery: { content: 'recovered' } }; };
  const left = ws.open(a, 'primary'); await gate; const right = ws.open(a, 'secondary'); assert.equal(ws.current('primary'), null); assert.equal(ws.current('secondary'), null);
  release(); const [l,r] = await Promise.all([left,right]); assert.equal(l.document, r.document); assert.equal(l.document.text, 'recovered'); assert.equal(l.preview, false);
});
test('failed recovery lookup cannot expose an autosaving document', async () => {
  const { ws, api, writes } = fixture(); api.checkRecovery = async () => { throw Error('unreadable'); };
  await assert.rejects(ws.open(a)); assert.equal(ws.documents.size, 0); assert.equal(ws.groups.primary.tabs.length, 0); ws.ready = true; ws.tick(); assert.equal(writes.length, 0);
});
test('a later existing-tab or blank selection cancels an older asynchronous open', async () => {
  const {ws,api}=fixture(); const active=await ws.open(b,'primary',true);const read=api.readNote;let release;
  api.readNote=async path=>{if(path===a)await new Promise(resolve=>release=resolve);return read(path);};
  const opening=ws.open(a); ws.activate('primary',active.id); release();assert.equal(await opening,null);assert.equal(ws.current(),active);
  const another=ws.open(c);const blank=ws.blank();assert.equal(await another,null);assert.equal(ws.current(),blank);
});
test('move, duplicate merge, group swap and adjacent close retain document state', async () => {
  const { ws } = fixture(); const first = await ws.open(a, 'primary', true), middle = await ws.open(b, 'primary', true), last = await ws.open(c, 'primary', true);
  ws.move('primary', last.id, 'primary', first.id); assert.deepEqual(ws.groups.primary.tabs.map(t=>t.id),[last.id,first.id,middle.id]);
  await ws.close('primary', first); assert.equal(ws.groups.primary.tabs.length,2);
  const copy = await ws.open(b,'secondary'); ws.move('primary',middle.id,'secondary'); assert.equal(ws.groups.secondary.tabs.length,1); assert.equal(copy.preview,false);
  const doc = copy.document; ws.swap(); assert.equal(ws.currentDocument('primary'),doc); ws.merge(); assert.equal(ws.groups.secondary.tabs.length,0); assert.equal(doc.disposed,false);
  ws.activate('primary',copy.id); await ws.close('primary',copy); assert.equal(ws.current().id,last.id);
});
test('session V3 round-trips positions and modes without body or history', async () => {
  const { ws, api } = fixture(); const tab = await ws.open(a,'primary',true); await ws.open(a,'secondary',true);
  tab.selection=EditorSelection.single(2,6); tab.scroll.edit=440; ws.current('secondary').mode='preview';
  const session={version:3,root:null,currentDirectory:null,layout:'note',sidebar:true,splitAt:52,activePdf:null,activeEpub:null,scrollMemory:[],...ws.sessionFields()};
  assert.equal(validateSession(session),session); assert.equal(JSON.stringify(session).includes('task'),false);
  const restored=new NoteWorkspace(()=>api,{has:()=>false},()=>{}); await restored.restore(session);
  assert.equal(restored.current('primary').selection.main.anchor,2); assert.equal(restored.current('primary').scroll.edit,440); assert.equal(restored.current('secondary').mode,'preview'); assert.equal(restored.documents.size,1);
  for(const mutate of [x=>x.noteGroups.primary.tabs.push({...x.noteGroups.primary.tabs[0]}),x=>x.noteGroups.primary.activeId=randomUUID(),x=>x.noteGroups.primary.tabs[0].selection.anchor=-1,x=>x.noteDocuments[0].content='bad',x=>x.noteGroups.primary.tabs[0].path=b]) {const bad=structuredClone(session);mutate(bad);assert.equal(validateSession(bad),null);}
});
test('session validator accepts both retained recovery IDs and path-qualified V3 references', async () => {
  const { ws } = fixture(); const tab = await ws.open(a, 'primary', true); tab.document.retainRecovery(b, randomUUID());
  const session = { version: 3, root: null, currentDirectory: null, layout: 'note', sidebar: true, splitAt: 52,
    activePdf: null, activeEpub: null, scrollMemory: [], ...ws.sessionFields() };
  assert.ok(validateSession(session)); assert.deepEqual(session.noteDocuments[0].retainedRecoveries[0], { sourcePath: b, recoveryId: tab.document.recoveryReferences[0].recoveryId });
  const legacy = structuredClone(session); legacy.noteDocuments[0].retainedRecoveryIds = legacy.noteDocuments[0].retainedRecoveries.map(item => item.recoveryId); delete legacy.noteDocuments[0].retainedRecoveries;
  assert.ok(validateSession(legacy));
  const malformed = structuredClone(session); malformed.noteDocuments[0].retainedRecoveries[0].sourcePath = 'relative.md'; assert.equal(validateSession(malformed), null);
});
test('legacy V3 retained recovery IDs restore with the original note path', async () => {
  const { ws, api } = fixture(); const id = randomUUID(); const tab = await ws.open(a, 'primary', true); tab.document.retainRecovery(a, id);
  const session = { version: 3, root: null, currentDirectory: null, layout: 'note', sidebar: true, splitAt: 52,
    activePdf: null, activeEpub: null, scrollMemory: [], ...ws.sessionFields() };
  session.noteDocuments[0].retainedRecoveryIds = session.noteDocuments[0].retainedRecoveries.map(item => item.recoveryId);
  delete session.noteDocuments[0].retainedRecoveries;
  const restored = new NoteWorkspace(() => api, { has: () => false }, () => {}); await restored.restore(session);
  assert.deepEqual(restored.currentDocument().recoveryReferences, [{ sourcePath: a, recoveryId: id }]);
});
test('V2 dual drafts for the same path are both retained and explicitly accessible', async () => {
  const { ws, drafts }=fixture(); const first=randomUUID(),second=randomUUID(); drafts.set(first,{status:'recoverable',recovery:{content:'left draft'}});drafts.set(second,{status:'recoverable',recovery:{content:'right draft'}});
  await ws.restore({version:2,noteTabs:[a],primaryNote:{path:a,mode:'edit',recoveryId:first},secondaryNote:{path:a,mode:'preview',recoveryId:second},scrollMemory:[]});
  assert.equal(ws.documents.size,1); const doc=ws.currentDocument(); assert.equal(doc.text,'left draft'); assert.deepEqual(doc.retainedRecoveryIds,[second]); assert.equal(drafts.get(second).recovery.content,'right draft');
});
test('background document conflicts remain protected on final close', async () => {
  const { ws, disk }=fixture(); const tab=await ws.open(a,'primary',true),view=mount(tab);edit(tab,view,0,0,'local'); await ws.open(b,'primary',true);
  const old=disk.get(documentKey(a));disk.set(documentKey(a),{...old,content:'external',hash:digest('external')});
  assert.equal(await ws.saveAll(),false);assert.equal(ws.current(),tab);assert.equal(tab.document.text,'local- [ ] task\n'); assert.equal(disk.get(documentKey(a)).content,'external');
});
test('blank cap and save-as during typing do not silently drop newer text', async () => {
  const {ws,api}=fixture();for(let i=0;i<100;i++)ws.blank();assert.equal(ws.blank(),null);
  const fresh=fixture(),tab=await fresh.ws.open(a),view=mount(tab);edit(tab,view,0,0,'first');let release,entered;const gate=new Promise(r=>entered=r);
  fresh.api.saveAs=async input=>{entered();await new Promise(r=>release=r);return {path:'C:\\notes\\new.md',content:input.content,hash:digest(input.content),eol:'\n',bom:false};};
  const saving=fresh.ws.saveAs(tab.document);await gate;edit(tab,view,0,0,'later');release();await saving;assert.equal(tab.document.text,'laterfirst- [ ] task\n');assert.equal(tab.document.label,'编辑中');
});
test('failed recovery cleanup after Save As leaves old document identity registered', async () => {
  const { ws, api, messages } = fixture(); const tab = await ws.open(a, 'primary', true), doc = tab.document;
  edit(tab, mount(tab), 0, 0, 'mine'); const oldId = doc.recoveryId;
  const remove = api.deleteRecovery; api.saveAs = async input => ({ path: c, content: input.content, hash: digest(input.content), bom: false, eol: '\n' });
  api.checkRecovery = async () => ({ status: 'recoverable', recovery: { content: doc.text, draftHash: digest(doc.text) } });
  api.deleteRecovery = async () => { throw Error('locked'); };
  assert.equal(await ws.saveAs(doc), false); assert.equal(doc.note.path, a); assert.equal(doc.recoveryId, oldId);
  assert.equal(ws.documents.get(documentKey(a)), doc); assert.equal(ws.documents.has(documentKey(c)), false);
  assert.match(messages.at(-1), /副本已保存.*迁移未完成/);
  api.deleteRecovery = remove;
});
test('recovery conflict choices commit only after cleanup and Save As outcome is safe', async () => {
  const kept = fixture(); const keepTab = await kept.ws.open(a, 'primary', true), keepDoc = keepTab.document;
  const keepText = 'recovered mine'; const keepId = keepDoc.recoveryId;
  kept.drafts.set(keepId, { status: 'conflict', recovery: { content: keepText, draftHash: digest(keepText) } });
  keepDoc.recoveryConflict = { note: keepDoc.note, recovery: { content: keepText, draftHash: digest(keepText) }, recoveryId: keepId };
  assert.equal(await keepDoc.keepMine(), true); assert.equal(keepDoc.note.path, a); assert.equal(keepDoc.text, keepText); assert.equal(keepDoc.recoveryConflict, null);

  const disk = fixture(); const diskTab = await disk.ws.open(a, 'primary', true), diskDoc = diskTab.document;
  const draft = 'conflicting draft'; const diskId = diskDoc.recoveryId;
  disk.drafts.set(diskId, { status: 'conflict', recovery: { content: draft, draftHash: digest(draft) } });
  diskDoc.recoveryConflict = { note: diskDoc.note, recovery: { content: draft, draftHash: digest(draft) }, recoveryId: diskId };
  await diskDoc.useDisk(); assert.equal(diskDoc.text, diskDoc.note.content); assert.equal(diskDoc.recoveryConflict, null); assert.equal(disk.drafts.has(diskId), false);

  const cancelled = fixture(); const cancelledTab = await cancelled.ws.open(a, 'primary', true), cancelledDoc = cancelledTab.document;
  cancelled.api.saveAs = async () => null; assert.equal(await cancelled.ws.saveAs(cancelledDoc), false); assert.equal(cancelledDoc.note.path, a);
  const occupied = fixture(); const occupiedTab = await occupied.ws.open(a, 'primary', true), occupiedDoc = occupiedTab.document; await occupied.ws.open(b, 'primary', true);
  occupied.api.saveAs = async input => ({ path: b, content: input.content, hash: digest(input.content), bom: false, eol: '\n' });
  assert.equal(await occupied.ws.saveAs(occupiedDoc), false); assert.equal(occupiedDoc.note.path, a); assert.equal(occupied.ws.documents.get(documentKey(a)), occupiedDoc);
  assert.match(occupied.messages.at(-1), /另一标签打开/);
});

test('saveAll revisits a document edited while a later document is writing', async () => {
  const { ws, api, disk, writes } = fixture();
  const left = await ws.open(a, 'primary', true), right = await ws.open(b, 'secondary', true);
  const lv = mount(left), rv = mount(right);
  edit(left, lv, 0, 0, 'first-'); edit(right, rv, 0, 0, 'other-');
  let release, entered; const started = new Promise(resolve => entered = resolve), write = api.saveNote;
  api.saveNote = async input => { if (input.path === b) { entered(); await new Promise(resolve => release = resolve); } return write(input); };
  const saving = ws.saveAll(); await started; edit(left, lv, 0, 0, 'latest-'); release();
  assert.equal(await saving, true); assert.equal(disk.get(documentKey(a)).content, left.document.text);
  assert.equal(left.document.label, '已保存'); assert.equal(writes.filter(input => input.path === a).length, 2);
});

test('final commit freezes transactions, history, excerpts and opens, but still drains saves', async () => {
  const { ws, disk } = fixture(); const tab = await ws.open(a, 'primary', true), view = mount(tab);
  edit(tab, view, 0, 0, 'accepted-'); const text = tab.document.text, target = ws.captureExcerptTarget();
  const release = ws.beginCommit(); assert.ok(release); assert.equal(ws.beginCommit(), null);
  assert.equal(await ws.saveAll(), true); assert.equal(disk.get(documentKey(a)).content, text);
  edit(tab, view, 0, 0, 'rejected-'); assert.equal(tab.document.text, text); assert.equal(view.state.doc.toString(), text);
  assert.equal(tab.document.runHistory(undo, view), false); assert.equal(target.valid(), false);
  assert.equal(await ws.open(b), null); assert.equal(await ws.close('primary', tab), false); assert.equal(ws.blank(), null);
  release(); release(); assert.equal(ws.committing, false); assert.equal(target.valid(), true);
  edit(tab, view, 0, 0, 'after-'); assert.match(tab.document.text, /^after-accepted-/);
});

test('failed final save retains the draft and releasing the gate restores editing', async () => {
  const { ws, api, drafts } = fixture(); const tab = await ws.open(a, 'primary', true), view = mount(tab);
  edit(tab, view, 0, 0, 'protected-'); api.saveNote = async () => { throw Error('locked'); };
  const release = ws.beginCommit(); assert.equal(await ws.saveAll(), false);
  assert.equal(ws.current(), tab); assert.ok(drafts.has(tab.document.recoveryId)); assert.equal(tab.document.label, '保存失败');
  release(); edit(tab, view, 0, 0, 'editable-'); assert.match(tab.document.text, /^editable-protected-/);
});

for (const version of [1, 2, 3]) test('startup restore merges a user-opened note without duplicates or stealing focus: V' + version, async () => {
  const initial = fixture(); await initial.ws.open(a, 'primary', true); await initial.ws.open(b, 'primary', true);
  let session = { version: 3, root: null, currentDirectory: null, layout: 'note', sidebar: true, splitAt: 52,
    activePdf: null, activeEpub: null, scrollMemory: [], ...initial.ws.sessionFields() };
  if (version !== 3) { session = { ...session, version }; delete session.noteGroups; delete session.noteDocuments; delete session.activeNoteGroup; if (version === 1) delete session.scrollMemory; }
  const { ws, api } = fixture(); let release, entered; const started = new Promise(resolve => entered = resolve), read = api.readNote;
  api.readNote = async path => { if (path === b) { entered(); await new Promise(resolve => release = resolve); } return read(path); };
  const restoring = ws.restore(session); await started; const selected = await ws.open(a, 'primary', false);
  ws.setMode('primary', selected.id, 'preview'); selected.scroll.preview = 72;
  const right = await ws.open(c, 'secondary', true); release(); await restoring;
  assert.equal(ws.groups.primary.tabs.filter(tab => tab.document === selected.document).length, 1);
  assert.equal(ws.current('primary'), selected); assert.equal(selected.mode, 'preview'); assert.equal(selected.scroll.preview, 72);
  assert.equal(ws.current(), right); assert.equal(ws.activeGroup, 'secondary');
  assert.ok(validateSession({ version: 3, root: null, currentDirectory: null, layout: 'note', sidebar: true, splitAt: 52,
    activePdf: null, activeEpub: null, scrollMemory: [], ...ws.sessionFields() }));
});

test('restored file grants include qualified old sources and accept legacy references only through validation', async () => {
  const { ws } = fixture(); const tab = await ws.open(a, 'primary', true); tab.document.retainRecovery(b, randomUUID());
  const session = { version: 3, root: null, currentDirectory: null, layout: 'note', sidebar: true, splitAt: 52,
    activePdf: null, activeEpub: null, scrollMemory: [], ...ws.sessionFields() };
  assert.deepEqual(sessionFilePaths(session), [a, b]);
  const legacy = structuredClone(session); legacy.noteDocuments[0].retainedRecoveryIds = [legacy.noteDocuments[0].retainedRecoveries[0].recoveryId]; delete legacy.noteDocuments[0].retainedRecoveries;
  assert.deepEqual(sessionFilePaths(legacy), [a]);
  const invalid = structuredClone(session); invalid.noteDocuments[0].retainedRecoveries[0].sourcePath = 'relative.md';
  assert.deepEqual(sessionFilePaths(invalid), []);
});
