require('./typescript-loader.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {FileStore}=require('../electron/storage.cjs');
const {validateSession}=require('../electron/session.cjs');
const {MutationBarrier}=require('../src/fileOperations.cjs');
const {SessionWriter}=require('../src/sessionWriter.cjs');
const {filePathKey}=require('../src/pathIdentity.cjs');
const {EditorSelection}=require('@codemirror/state');
function snapshot(ws,catalog,root){
 const pendingNoteDocuments=catalog.snapshot(ws.documents.values());
 const value={version:3,root,currentDirectory:root,layout:'note',sidebar:true,splitAt:52,activePdf:null,activeEpub:null,scrollMemory:[],pendingNoteDocuments,...ws.sessionFields()};
 assert.ok(validateSession(value),'fresh sessions use the actual session validator');return JSON.parse(JSON.stringify(value));
}
async function fixture(t){
 const {NoteWorkspace}=await import('../src/workspace/noteWorkspace.ts'),{SessionRecovery}=await import('../src/sessionRecovery.ts'),{FileMoveCoordinator}=await import('../src/workspace/fileMove.ts');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zuoren-move-session-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'fixture.md'),directory=path.join(root,'child'),target=path.join(directory,'fixture.md'),sessionFile=path.join(root,'session.json');await fs.mkdir(directory);await fs.writeFile(file,'# original\n');
 const store=new FileStore();await store.grantRoot(root);const barrier=new MutationBarrier(),calls=[],sessions=[],writer=new SessionWriter();let pending=null,result=null,finalize=false;
 const api={readNote:f=>store.readNote(f),checkRecovery:input=>store.checkRecovery(input.sourcePath,input.recoveryId),writeRecovery:input=>store.writeRecovery(input),deleteRecovery:input=>store.deleteRecoveryIfHash(input.sourcePath,input.recoveryId,input.draftHash),
  saveNote:async input=>{calls.push('saveNote');return store.saveNote(input);},pendingFileMove:async()=>pending,fileMoveCapability:async()=>({supported:true}),
  moveFile:async input=>{calls.push('move');assert.ok(sessions.length,'move requires a fresh session');assert.equal(await fs.readFile(file,'utf8'),'# edited before move\n');assert.equal(sessions.at(-1).noteDocuments[0].recoveryId,doc.recoveryId);assert.equal(sessions.at(-1).noteGroups.primary.tabs[0].path,file);
   await fs.rename(file,target);result={ok:true,operationId:input.operationId,oldPath:file,entry:{path:target,name:'fixture.md',relative:'child/fixture.md',type:'md',kind:'file',moveVersion:'moved'},undoToken:'fixture-undo'};pending={operationId:input.operationId,oldPath:file,targetPath:target,message:'持久完成尚待确认'};return result;},
  fileMoveStatus:async()=>result?{status:'finished',result}:{status:'unknown'},finalizeFileMove:async()=>{calls.push('finalize');if(finalize)pending=null;return finalize;}};
 const catalog=new SessionRecovery();catalog.seed(null);const workspace=new NoteWorkspace(()=>api,barrier,()=>{});workspace.ready=true;workspace.subscribe(()=>catalog.capture(workspace.documents.values()));
 const primary=await catalog.open(workspace,file,'primary',true),secondary=await catalog.open(workspace,file,'secondary',true),doc=primary.document;t.after(()=>doc.dispose());assert.equal(secondary.document,doc);
 doc.replaceText('# edited before move\n');primary.selection=EditorSelection.single(2);const state=doc.state;
 const readers={flush:async()=>{calls.push('readers.flush');return true;},currentPdf:()=>null,currentEpub:()=>null};
 const context={workspace,readers,barrier,api,persistSession:async()=>{calls.push('persistSession');assert.equal(await fs.readFile(file,'utf8'),'# edited before move\n');const fresh=snapshot(workspace,catalog,root);await writer.write(fresh,async value=>{await fs.writeFile(sessionFile,JSON.stringify(value));sessions.push(value);},true);return true;},remap:(a,b)=>{calls.push('remap');catalog.remap(a,b,()=>workspace.remap(a,b));}};
 return{root,file,directory,target,sessionFile,store,barrier,api,workspace,catalog,doc,primary,secondary,state,readers,context,calls,sessions,coordinator:new FileMoveCoordinator(),NoteWorkspace,SessionRecovery,FileMoveCoordinator,setFinalize:value=>finalize=value,getPending:()=>pending,getResult:()=>result};
}
test('actual shared NoteDocument saves its latest text before a fresh session and stays protected when finalize fails',async t=>{
 const f=await fixture(t);const outcome=await f.coordinator.run(f.context,{root:f.root,source:{path:f.file,name:'fixture.md',relative:'fixture.md',type:'md',moveVersion:'listed'},directory:f.directory});
 assert.equal(outcome.status,'uncertain');assert.deepEqual(f.calls,['saveNote','readers.flush','persistSession','move','remap','finalize']);assert.equal(f.doc.text,'# edited before move\n');assert.equal(f.doc.state,f.state,'relocation preserves the real editor state/history object');assert.equal(f.primary.document,f.doc);assert.equal(f.secondary.document,f.doc);assert.equal(f.doc.note.path,f.target);assert.equal(f.workspace.documents.get(filePathKey(f.target)),f.doc);
 assert.equal(f.doc.editingBlocked(),true);assert.equal(await f.doc.save(),false);assert.equal(f.calls.filter(x=>x==='saveNote').length,1);await assert.rejects(fs.access(f.file));assert.equal(await fs.readFile(f.target,'utf8'),'# edited before move\n');
 f.setFinalize(true);assert.equal((await f.coordinator.recheck(f.context)).status,'moved');assert.equal(f.doc.editingBlocked(),false);assert.equal(f.doc.state,f.state);assert.equal(f.primary.selection.main.head,2);assert.equal(f.barrier.pins.size,0);assert.equal(f.catalog.recoveryId(f.target),f.doc.recoveryId);
});
test('actual Workspace failure to persist the fresh session cannot rename the already-saved editing document',async t=>{
 const f=await fixture(t);f.context.persistSession=async()=>{f.calls.push('persistSession.failed');return false;};
 const outcome=await f.coordinator.run(f.context,{root:f.root,source:{path:f.file,name:'fixture.md',relative:'fixture.md',type:'md',moveVersion:'listed'},directory:f.directory});assert.equal(outcome.status,'blocked');assert.equal(f.calls.includes('move'),false);assert.equal(f.doc.note.path,f.file);assert.equal(f.doc.text,'# edited before move\n');assert.equal(f.doc.editingBlocked(),false);assert.equal(await fs.readFile(f.file,'utf8'),'# edited before move\n');await assert.rejects(fs.access(f.target));assert.equal(f.barrier.pins.size,0);assert.equal(f.workspace.committing,false);
});
test('restart restores durable pending pins and real SessionRecovery remaps the saved recovery identity only after known result',async t=>{
 const f=await fixture(t);await f.coordinator.run(f.context,{root:f.root,source:{path:f.file,name:'fixture.md',relative:'fixture.md',type:'md',moveVersion:'listed'},directory:f.directory});const saved=JSON.parse(await fs.readFile(f.sessionFile,'utf8')),id=f.doc.recoveryId;assert.equal(saved.noteDocuments[0].path,f.file);
 // This simulates a restarted renderer against the API's durable pending/result
 // contract. Native journal/worker/launch recovery is tested by the backend owner.
 f.doc.dispose();const barrier=new MutationBarrier(),catalog=new f.SessionRecovery();catalog.seed(saved);const ws=new f.NoteWorkspace(()=>f.api,barrier,()=>{});ws.ready=true;ws.subscribe(()=>catalog.capture(ws.documents.values()));const coordinator=new f.FileMoveCoordinator();
 const context={workspace:ws,readers:f.readers,barrier,api:f.api,persistSession:async()=>assert.fail('recheck does not create a fresh move'),remap:(a,b)=>catalog.remap(a,b,()=>ws.remap(a,b))};
 assert.equal((await coordinator.restorePending(context)).status,'uncertain');assert.equal(barrier.has(f.file,Date.now()+3600_000),true);assert.equal(barrier.has(f.target,Date.now()+3600_000),true);assert.equal(catalog.recoveryId(f.file),id);assert.equal((await coordinator.run(context,{root:f.root,source:{path:f.file,name:'fixture.md',type:'md',relative:'fixture.md'},directory:f.directory})).status,'blocked');
 f.setFinalize(true);assert.equal((await coordinator.recheck(context)).status,'moved');assert.equal(catalog.recoveryId(f.target),id);assert.equal(catalog.recoveryId(f.file),undefined);assert.equal(barrier.pins.size,0);
 const tab=await catalog.open(ws,f.target,'primary',true);t.after(()=>tab.document.dispose());assert.equal(tab.document.recoveryId,id);assert.equal(tab.document.text,'# edited before move\n');assert.equal(tab.document.note.path,f.target);assert.equal(tab.document.editingBlocked(),false);assert.equal(snapshot(ws,catalog,f.root).noteDocuments[0].path,f.target);assert.equal(f.getPending(),null);
});

test('an open deleted target NoteDocument remains owned and unmodified instead of being replaced by source remap',async t=>{
 const f=await fixture(t);await fs.writeFile(f.target,'# previous target\n');const previous=await f.catalog.open(f.workspace,f.target,'secondary',true),targetDoc=previous.document;t.after(()=>targetDoc.dispose());targetDoc.replaceText('# retain unsaved target\n');await fs.unlink(f.target);
 const outcome=await f.coordinator.run(f.context,{root:f.root,source:{path:f.file,name:'fixture.md',relative:'fixture.md',type:'md',moveVersion:'listed'},directory:f.directory});assert.equal(outcome.status,'blocked');assert.match(outcome.message,/目标位置已有打开/);assert.equal(f.calls.includes('move'),false);assert.equal(f.calls.includes('saveNote'),false);assert.equal(f.workspace.documents.get(filePathKey(f.target)),targetDoc);assert.equal(targetDoc.text,'# retain unsaved target\n');assert.equal(f.workspace.documents.get(filePathKey(f.file)),f.doc);assert.equal(f.doc.note.path,f.file);assert.equal(f.doc.text,'# edited before move\n');assert.equal(await fs.readFile(f.file,'utf8'),'# original\n');await assert.rejects(fs.access(f.target));
});

test('an open clean target deleted on disk cannot be silently replaced by a successfully moved source document',async t=>{
 const f=await fixture(t);await fs.writeFile(f.target,'# clean target still in memory\n');const previous=await f.catalog.open(f.workspace,f.target,'secondary',true),targetDoc=previous.document;t.after(()=>targetDoc.dispose());await fs.unlink(f.target);
 // Simulate a successful backend receipt without the fresh-session assertion so
 // the original coordinator is also a meaningful negative control for map loss.
 f.api.moveFile=async input=>{f.calls.push('move');await fs.rename(f.file,f.target);return{ok:true,operationId:input.operationId,oldPath:f.file,entry:{path:f.target,name:'fixture.md',relative:'child/fixture.md',type:'md',kind:'file'},undoToken:'fixture'};};
 const outcome=await f.coordinator.run(f.context,{root:f.root,source:{path:f.file,name:'fixture.md',relative:'fixture.md',type:'md',moveVersion:'listed'},directory:f.directory});assert.equal(outcome.status,'blocked');assert.equal(f.calls.includes('move'),false);assert.equal(f.workspace.documents.get(filePathKey(f.target)),targetDoc);assert.equal(targetDoc.text,'# clean target still in memory\n');assert.equal(previous.document,targetDoc);assert.equal(f.workspace.documents.get(filePathKey(f.file)),f.doc);assert.equal(f.doc.text,'# edited before move\n');assert.equal(await fs.readFile(f.file,'utf8'),'# original\n');await assert.rejects(fs.access(f.target));
});

test('a known pending receipt cannot overwrite a distinct open target document during recheck remap',async t=>{
 const f=await fixture(t);assert.equal(await f.doc.save(),true);await fs.writeFile(f.target,'# distinct old target\n');const previous=await f.catalog.open(f.workspace,f.target,'secondary',true),targetDoc=previous.document;t.after(()=>targetDoc.dispose());await fs.unlink(f.target);await fs.rename(f.file,f.target);
 const result={ok:true,operationId:'known-pending',oldPath:f.file,entry:{path:f.target,name:'fixture.md',relative:'child/fixture.md',type:'md',kind:'file'},undoToken:''};f.api.pendingFileMove=async()=>({operationId:result.operationId,oldPath:f.file,targetPath:f.target,message:'known pending'});f.api.fileMoveStatus=async()=>({status:'finished',result});f.api.finalizeFileMove=async()=>assert.fail('cannot finalize an unperformed UI remap');
 assert.equal((await f.coordinator.restorePending(f.context)).status,'uncertain');const outcome=await f.coordinator.recheck(f.context);assert.equal(outcome.status,'uncertain');assert.match(outcome.issue.message,/目标位置仍有另一份打开的笔记/);assert.equal(f.workspace.documents.get(filePathKey(f.file)),f.doc);assert.equal(f.workspace.documents.get(filePathKey(f.target)),targetDoc);assert.equal(f.doc.text,'# edited before move\n');assert.equal(targetDoc.text,'# distinct old target\n');assert.equal(previous.document,targetDoc);assert.equal(f.barrier.pins.size,2);assert.equal(await f.doc.save(),false);assert.equal(await targetDoc.save(),false);assert.equal(await fs.readFile(f.target,'utf8'),'# edited before move\n');
});
