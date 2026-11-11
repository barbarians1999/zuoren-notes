require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { MutationBarrier } = require('../src/fileOperations.cjs');
const { FileStore } = require('../electron/storage.cjs');
const load = () => import('../src/workspace/fileMove.ts');
const source = { path: 'C:\\notes\\稿.md', name: '稿.md', relative: '稿.md', kind: 'file', type: 'md', moveVersion: 'listed' };
const target = 'C:\\notes\\child\\稿.md';
const request = { root: 'C:\\notes', source, directory: 'C:\\notes\\child' };
function fixture() {
  const calls = [], barrier = new MutationBarrier();
  const workspace = { documents: new Map(), beginCommit() { calls.push('begin'); return () => calls.push('release'); }, saveAll: async () => { calls.push('save'); return true; } };
  const readers = { flush: async () => { calls.push('flush'); return true; }, currentPdf: () => null, currentEpub: () => null };
  const api = { pendingFileMove: async () => null, finalizeFileMove: async () => { calls.push('finalize'); return true; }, fileMoveCapability: async () => ({ supported: true }), moveFile: async input => { calls.push(input); return { ok: true, operationId: input.operationId, oldPath: source.path, entry: { ...source, path: target }, undoToken: 'undo' }; }, fileMoveStatus: async () => ({ status: 'unknown' }) };
  const context = { workspace, readers, barrier, api, persistSession: async () => { calls.push('session'); return true; }, remap: (a,b) => calls.push(['remap',a,b]) }; return { calls, context, api, workspace, readers, barrier };
}
for (const [input, expected] of [['C:\\a.md', 'C:\\'], ['C:\\notes\\a.md','C:\\notes'], ['/a.md','/'], ['/notes/a.md','/notes'], ['\\\\server\\share\\a.md','\\\\server\\share'], ['\\\\server\\share','\\\\server\\share']]) test(`parent preserves path root: ${input}`, async () => {
  assert.equal((await load()).fileMoveParent(input), expected);
});
test('drop policy rejects folders, same directory, busy, and cross-root boundaries', async () => {
  const { fileDropPermission: permission } = await load();
  assert.equal(permission(source, request.root, request.directory).allowed, true);
  for (const [entry, root, directory, busy] of [[null, request.root, request.directory], [{ ...source, kind: 'folder' },request.root,request.directory], [source,request.root,request.root], [source,request.root,'C:\\notes-other'], [source,request.root,request.directory,true]]) assert.equal(permission(entry,root,directory,busy).allowed,false);
});
test('unsupported capability returns before saving or beginning a commit', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(); f.api.fileMoveCapability = async () => ({ supported: false, reason: 'pending Windows validation' });
  assert.equal((await new FileMoveCoordinator().run(f.context, request)).status, 'failed'); assert.deepEqual(f.calls, []); assert.equal(f.barrier.has(source.path),false);
});
for (const stage of ['save','flush']) test(`${stage} refusal cannot dispatch or remap`, async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(); if (stage === 'save') f.workspace.saveAll = async () => false; else f.readers.flush = async () => false;
  assert.equal((await new FileMoveCoordinator().run(f.context,request)).status,'blocked'); assert.equal(f.calls.filter(x => typeof x === 'object').length,0); assert.equal(f.calls.at(-1),'release');
});
test('root change during flush is checked before pin or IPC', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(); let valid = true; f.context.valid = () => valid; f.readers.flush = async () => { valid=false; return true; };
  assert.equal((await new FileMoveCoordinator().run(f.context,request)).status,'blocked'); assert.equal(f.calls.filter(x => typeof x === 'object').length,0); assert.equal(f.barrier.has(source.path),false);
});
test('success remaps once, clears both pins and leaves only an expiring old-path barrier', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(), coordinator = new FileMoveCoordinator();
  assert.equal((await coordinator.run(f.context,request)).status,'moved'); assert.equal(f.calls.filter(Array.isArray).length,1); assert.equal(f.barrier.pins.size,0); assert.equal(f.barrier.has(target),false); assert.equal(f.barrier.has(source.path,Date.now()+60_000),false);
});
test('undoing a move immediately reopens the restored destination for saves and another move', async () => {
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator();
  let activePath=source.path;
  f.context.remap=(_old,next)=>{activePath=next;};
  f.workspace.saveAll=async()=>!f.barrier.has(activePath);
  f.api.undoFileMove=async input=>({ok:true,operationId:input.operationId,oldPath:target,entry:source});
  assert.equal((await coordinator.run(f.context,request)).status,'moved');
  assert.equal(f.barrier.has(source.path),true,'the vacated path remains protected from stale writers');
  assert.equal((await coordinator.run(f.context,{root:request.root,source:{...source,path:target},directory:request.root,undoToken:'undo'})).status,'moved');
  assert.equal(activePath,source.path);
  assert.equal(f.barrier.has(source.path),false,'a verified move into the path retires its old tombstone');
  assert.equal(f.barrier.has(target),true,'the newly vacated child path stays protected');
  assert.equal((await coordinator.run(f.context,request)).status,'moved','no thirty-second wait is required before saving/moving again');
});
test('a completed move retires only the target file tombstone and preserves directory/sibling protection', async () => {
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator();
  const sibling='C:\\notes\\child\\missing.md';
  f.barrier.block(request.directory);f.barrier.block(target);f.barrier.pin(sibling);
  assert.equal((await coordinator.run(f.context,request)).status,'moved');
  assert.equal(f.barrier.has(request.directory),true,'the destination parent protection is not retired by a file move');
  assert.equal(f.barrier.pins.has(sibling.toLowerCase()),true,'an unrelated pinned file stays protected');
});
test('saved document hash is carried to IPC while closed source keeps the listing revision', async () => {
  const { FileMoveCoordinator } = await load(), { filePathKey } = require('../src/pathIdentity.cjs'), f = fixture(); f.workspace.documents.set(filePathKey(source.path), { note: { hash: 'saved-hash' } });
  await new FileMoveCoordinator().run(f.context,request); const input = f.calls.find(x => x && !Array.isArray(x) && typeof x === 'object'); assert.equal(input.expectedHash,'saved-hash'); assert.equal(input.expectedVersion,'listed');
});
test('unknown receipt pins source AND destination indefinitely; ordinary release cannot clear pins', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(), coordinator = new FileMoveCoordinator(); f.api.moveFile = async () => { throw Error('lost acknowledgement'); };
  assert.equal((await coordinator.run(f.context,request)).status,'uncertain'); for (const name of [source.path,target]) { f.barrier.release(name); assert.equal(f.barrier.has(name,Date.now()+3_600_000),true); }
  assert.equal((await coordinator.run(f.context,request)).status,'blocked'); assert.equal((await coordinator.recheck(f.context)).status,'uncertain');
});
test('an explicit failed status is the only rejection that clears the in-flight pins', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(); f.api.moveFile = async () => { throw Error('IPC failed'); }; f.api.fileMoveStatus = async () => ({ status: 'failed', error:'no native commit' });
  assert.equal((await new FileMoveCoordinator().run(f.context,request)).status,'failed'); assert.equal(f.barrier.pins.size,0);
});
test('lost IPC with finished status accepts the original result', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(), original = f.api.moveFile; let result;
  f.api.moveFile = async input => { result = await original(input); throw Error('IPC delivery lost'); }; f.api.fileMoveStatus = async () => ({ status:'finished',result });
  assert.equal((await new FileMoveCoordinator().run(f.context,request)).status,'moved'); assert.equal(f.barrier.pins.size,0);
});
test('a remap exception retains both pins and can reapply the confirmed result', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(), coordinator = new FileMoveCoordinator(), original = f.api.moveFile; let result;
  f.api.moveFile = async input => result = await original(input); f.context.remap = () => { throw Error('state failure'); }; f.api.fileMoveStatus = async () => ({ status:'finished', result });
  assert.equal((await coordinator.run(f.context,request)).status,'uncertain'); assert.equal(f.barrier.has(target),true);
  f.context.remap = () => {}; assert.equal((await coordinator.recheck(f.context)).status,'moved'); assert.equal(f.barrier.pins.size,0);
});
test('malformed post-submission receipt cannot silently drop the uncertain-operation interlock', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(), coordinator = new FileMoveCoordinator(); f.api.moveFile = async () => null;
  assert.equal((await coordinator.run(f.context,request)).status,'uncertain'); assert.ok(coordinator.issue); assert.equal(f.barrier.has(target),true);
});
test('recheck of a confirmed pre-commit failure releases both paths', async () => {
  const { FileMoveCoordinator } = await load(), f = fixture(), coordinator = new FileMoveCoordinator(); f.api.moveFile = async () => { throw Error('lost'); }; await coordinator.run(f.context,request);
  f.api.fileMoveStatus = async () => ({ status:'failed',error:'verified no commit' }); assert.equal((await coordinator.recheck(f.context)).status,'failed'); assert.equal(f.barrier.pins.size,0);
});
test('actual Workspace + SessionRecovery + App.openEntry cannot reopen past an unknown-move edit/save pin', async t => {
  const { FileMoveCoordinator } = await load(), { NoteWorkspace } = await import('../src/workspace/noteWorkspace.ts'), { SessionRecovery } = await import('../src/sessionRecovery.ts');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'zuoren-move-reopen-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
  const file = path.join(root,'fixture.md'), directory=path.join(root,'child'); await fs.mkdir(directory); await fs.writeFile(file,'# original\n');
  const store=new FileStore(); await store.grantRoot(root); const barrier=new MutationBarrier(), saves=[];
  const api={readNote:f=>store.readNote(f),checkRecovery:async()=>({status:'none'}),writeRecovery:async()=>{},deleteRecovery:async()=>true,saveNote:async input=>{saves.push(input);return store.saveNote(input);},pendingFileMove:async()=>null,finalizeFileMove:async()=>true,fileMoveCapability:async()=>({supported:true}),moveFile:async()=>{throw Error('lost');},fileMoveStatus:async()=>({status:'unknown'})};
  const workspace=new NoteWorkspace(()=>api,barrier,()=>{}); workspace.ready=true; const catalog=new SessionRecovery(); catalog.seed(null); const tab=await catalog.open(workspace,file,'primary',true),doc=tab.document; t.after(()=>doc.dispose());
  const coordinator=new FileMoveCoordinator(); assert.equal((await coordinator.run({workspace,readers:{flush:async()=>true,currentPdf:()=>null,currentEpub:()=>null},barrier,api,persistSession:async()=>true,remap:()=>assert.fail('unknown cannot remap')},{root,source:{path:file,name:'fixture.md',relative:'fixture.md',kind:'file',type:'md',moveVersion:'listed'},directory})).status,'uncertain');
  const main=await fs.readFile(path.join(__dirname,'../src/main.tsx'),'utf8'), start=main.indexOf('  async function openEntry('), end=main.indexOf('\n  openEntryRef.current = openEntry;',start), release=/function releaseMutationBarrier\(path: string\) \{[^\n]+\}/.exec(main);
  assert.ok(start>0&&end>start&&release); const context=vm.createContext({workspace,sessionRecovery:{current:catalog},mutationBarrier:{current:barrier},openSequence:{current:0},readerSession:{flush:async()=>true},setMessage:()=>{},setLayout:()=>{},setActiveSurface:()=>{}});
  vm.runInContext(stripTypeScriptTypes(release[0]+'\n'+main.slice(start,end)),context); await context.openEntry({path:file,name:'fixture.md',relative:file,type:'md'});
  assert.equal(workspace.currentDocument(),doc); assert.equal(doc.editingBlocked(),true); doc.replaceText('# forbidden\n'); assert.equal(await doc.save(),false); assert.equal(saves.length,0); assert.equal(await fs.readFile(file,'utf8'),'# original\n');
});

const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
const restoredIssue = { operationId:'restart-operation', oldPath:source.path, targetPath:target, message:'启动时恢复的未完成移动' };
test('startup pending restoration pins both paths before accepting new operations', async()=>{
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator();f.api.pendingFileMove=async()=>({...restoredIssue});
  const restored=await coordinator.restorePending(f.context);assert.equal(restored.status,'uncertain');assert.equal(coordinator.issue.operationId,restoredIssue.operationId);assert.equal(coordinator.pendingReady,true);
  for(const file of[source.path,target])assert.equal(f.barrier.has(file,Date.now()+3600_000),true);
  assert.equal((await coordinator.run(f.context,request)).status,'blocked');assert.deepEqual(f.calls,[]);
  f.api.pendingFileMove=async()=>assert.fail('root changes cannot silently discard a restored issue');await coordinator.restorePending({...f.context,valid:()=>false});assert.equal(coordinator.issue.operationId,restoredIssue.operationId);
});
test('a pending lookup failure is explicit and fail-closed until a deliberate successful retry', async()=>{
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator();let checks=0;f.api.pendingFileMove=async()=>{checks++;throw Error('journal unavailable');};
  assert.equal((await coordinator.restorePending(f.context)).status,'blocked');assert.match(coordinator.pendingError,/journal unavailable/);assert.equal(coordinator.pendingReady,false);assert.equal((await coordinator.run(f.context,request)).status,'blocked');assert.equal(checks,1);assert.deepEqual(f.calls,[]);
  f.api.pendingFileMove=async()=>null;assert.equal(await coordinator.restorePending(f.context),null);assert.equal(coordinator.pendingError,null);assert.equal((await coordinator.run(f.context,request)).status,'moved');
});
test('malformed pending metadata cannot be treated as absence of a durable operation', async()=>{
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator();f.api.pendingFileMove=async()=>({operationId:'bad',oldPath:source.path,targetPath:42});
  assert.equal((await coordinator.restorePending(f.context)).status,'blocked');assert.equal(coordinator.pendingReady,false);assert.equal((await coordinator.run(f.context,request)).status,'blocked');assert.deepEqual(f.calls,[]);
});
test('overlapping startup checks share one pending lookup and block submission until it settles',async()=>{
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator(),pending=deferred();let checks=0;f.api.pendingFileMove=()=>{checks++;return pending.promise;};
  const first=coordinator.restorePending(f.context),second=coordinator.restorePending(f.context),run=coordinator.run(f.context,request);assert.equal(checks,1);assert.deepEqual(f.calls,[]);pending.resolve({...restoredIssue});await Promise.all([first,second]);assert.equal((await run).status,'uncertain');assert.deepEqual(f.calls,[]);
});
for(const failure of ['false','throw'])test(`fresh session ${failure} prevents move IPC after note/reader saves`,async()=>{
  const {FileMoveCoordinator}=await load(),f=fixture();f.context.persistSession=async()=>{f.calls.push('session');if(failure==='throw')throw Error('session disk full');return false;};
  const result=await new FileMoveCoordinator().run(f.context,request);assert.equal(result.status,failure==='throw'?'failed':'blocked');assert.deepEqual(f.calls,['begin','save','flush','session','release']);assert.equal(f.barrier.pins.size,0);
});
test('root changes are checked both before and after fresh session persistence',async()=>{
  const {FileMoveCoordinator}=await load();
  for(const stage of['flush','session']){const f=fixture();let valid=true;f.context.valid=()=>valid;if(stage==='flush')f.readers.flush=async()=>{f.calls.push('flush');valid=false;return true;};else f.context.persistSession=async()=>{f.calls.push('session');valid=false;return true;};
    assert.equal((await new FileMoveCoordinator().run(f.context,request)).status,'blocked');assert.equal(f.calls.some(value=>value&&typeof value==='object'),false);assert.equal(f.barrier.pins.size,0);if(stage==='flush')assert.equal(f.calls.includes('session'),false);
  }
});
test('known move keeps both pins and the commit lock through remap and awaited finalize',async()=>{
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator(),wait=deferred(),entered=deferred();let operationId;
  f.api.finalizeFileMove=async id=>{operationId=id;assert.ok(f.calls.some(Array.isArray),'renderer remap happens first');assert.equal(f.barrier.has(source.path),true);assert.equal(f.barrier.has(target),true);assert.notEqual(f.calls.at(-1),'release');entered.resolve();return wait.promise;};
  const run=coordinator.run(f.context,request);await entered.promise;assert.equal(coordinator.busy,true);assert.equal((await coordinator.run(f.context,request)).status,'blocked');assert.equal(f.barrier.pins.size,2);wait.resolve(true);assert.equal((await run).status,'moved');assert.equal(f.barrier.pins.size,0);assert.equal(f.calls.at(-1),'release');assert.equal(operationId,f.calls.find(x=>x&&typeof x==='object'&&!Array.isArray(x)).operationId);
});
for(const failure of ['false','throw'])test(`finalize ${failure} retains both pins and recheck can remap/finalize idempotently`,async()=>{
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator(),original=f.api.moveFile;let result,finalizes=0;
  f.api.moveFile=async input=>result=await original(input);f.api.finalizeFileMove=async()=>{finalizes++;if(failure==='throw')throw Error('settings not durable');return false;};
  assert.equal((await coordinator.run(f.context,request)).status,'uncertain');assert.ok(coordinator.issue);assert.match(coordinator.issue.message,/持久完成确认/);assert.equal(coordinator.issue.targetPath,target);assert.equal(f.barrier.pins.size,2);assert.equal(f.calls.at(-1),'release');
  f.api.fileMoveStatus=async()=>({status:'finished',result});f.api.finalizeFileMove=async()=>{finalizes++;return true;};assert.equal((await coordinator.recheck(f.context)).status,'moved');assert.equal(f.calls.filter(Array.isArray).length,2);assert.equal(finalizes,2);assert.equal(f.barrier.pins.size,0);assert.equal(coordinator.issue,null);
});
test('recheck finalization is serialized so two retries cannot race remap or unlock',async()=>{
  const {FileMoveCoordinator}=await load(),f=fixture(),coordinator=new FileMoveCoordinator(),original=f.api.moveFile;let result;
  f.api.moveFile=async input=>result=await original(input);f.api.finalizeFileMove=async()=>false;await coordinator.run(f.context,request);f.api.fileMoveStatus=async()=>({status:'finished',result});const wait=deferred(),entered=deferred();f.api.finalizeFileMove=async()=>{entered.resolve();return wait.promise;};
  const first=coordinator.recheck(f.context);await entered.promise;assert.equal((await coordinator.recheck(f.context)).status,'blocked');assert.equal(f.barrier.pins.size,2);wait.resolve(true);assert.equal((await first).status,'moved');assert.equal(f.barrier.pins.size,0);
});
test('preload exposes pending and finalize through only their matching IPC channels',async()=>{
  const calls=[];let exposed;vm.runInNewContext(await fs.readFile(path.join(__dirname,'../electron/preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld:(_name,value)=>exposed=value},ipcRenderer:{on(){},invoke:async(...args)=>{calls.push(args);return null;}}};}});
  await exposed.pendingFileMove();await exposed.finalizeFileMove('fixture-operation');assert.deepEqual(calls,[['pending-file-move',undefined],['finalize-file-move','fixture-operation']]);
});

for(const kind of['document','pdf','epub'])test(`an already-open target ${kind} refuses the move before saving or remapping`,async()=>{
 const {FileMoveCoordinator}=await load(),{filePathKey}=require('../src/pathIdentity.cjs'),f=fixture(),original={note:{path:target},text:'retain target content'};
 if(kind==='document')f.workspace.documents.set(filePathKey(target),original);else f.readers[kind==='pdf'?'currentPdf':'currentEpub']=()=>({path:target,meta:{id:'target-reader'}});
 assert.equal((await new FileMoveCoordinator().run(f.context,request)).status,'blocked');assert.deepEqual(f.calls,[]);assert.equal(f.barrier.pins.size,0);if(kind==='document')assert.equal(f.workspace.documents.get(filePathKey(target)),original);
});
for(const kind of['document','pdf','epub'])test(`a target ${kind} opened during fresh-session persistence is caught before IPC`,async()=>{
 const {FileMoveCoordinator}=await load(),{filePathKey}=require('../src/pathIdentity.cjs'),f=fixture();f.context.persistSession=async()=>{f.calls.push('session');if(kind==='document')f.workspace.documents.set(filePathKey(target),{text:'target'});else f.readers[kind==='pdf'?'currentPdf':'currentEpub']=()=>({path:target,meta:{id:'target-reader'}});return true;};
 assert.equal((await new FileMoveCoordinator().run(f.context,request)).status,'blocked');assert.deepEqual(f.calls,['begin','save','flush','session','release']);assert.equal(f.barrier.pins.size,0);
});

test('only literal true can confirm fresh-session persistence or durable finalization',async()=>{
 const {FileMoveCoordinator}=await load();for(const stage of['session','finalize']){const f=fixture(),coordinator=new FileMoveCoordinator();if(stage==='session')f.context.persistSession=async()=>({ok:true});else f.api.finalizeFileMove=async()=>({ok:true});
 const outcome=await coordinator.run(f.context,request);assert.equal(outcome.status,stage==='session'?'blocked':'uncertain');assert.equal(f.barrier.pins.size,stage==='session'?0:2);if(stage==='session')assert.equal(f.calls.some(value=>value&&typeof value==='object'),false);
 }
});
