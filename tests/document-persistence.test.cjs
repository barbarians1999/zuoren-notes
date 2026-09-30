const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DocumentPersistence } = require('../src/documentPersistence.cjs');
const { saveNoteAndCleanup } = require('../electron/note-service.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise,resolve}; };
function harness() {
  const session = new DocumentPersistence();
  let state = { note: { path: 'A.md', content: 'old', hash: 'base' }, text: 'new', revision: 1 };
  let writes = [], conflicts = [];
  const options = {
    snapshot: () => state,
    write: async s => { writes.push(s.text); return {content:s.text,hash:s.text}; },
    commit: (result, submitted) => {state = {...state,note:{...submitted.note,...result}};},
    conflict: result => conflicts.push(result),
    error: error => { throw error; },
  };
  return {session,options,get state(){return state},set state(s){state=s},writes,conflicts};
}
test('concurrent save requests share the gate before recovery completes', async () => {
  const h=harness(), recovery=deferred(); h.options.recovery=()=>recovery.promise;
  const a=h.session.save(h.options), b=h.session.save(h.options);
  assert.equal(a,b); recovery.resolve(); assert.equal(await a,true); assert.deepEqual(h.writes,['new']);
});
test('typing during a slow write saves the newer revision before flush resolves', async () => {
  const h=harness(), disk=deferred(); let count=0;
  h.options.write=async s=>{h.writes.push(s.text); if(!count++)await disk.promise; return {content:s.text,hash:s.text};};
  const save=h.session.save(h.options); await new Promise(setImmediate);
  h.state={...h.state,text:'newer',revision:2}; disk.resolve(); await save;
  assert.deepEqual(h.writes,['new','newer']); assert.equal(h.state.note.content,'newer');
});
for (const scenario of ['switch','edit','save']) test('late poll ignored after '+scenario,async()=>{
  const h=harness(), disk=deferred(); let applied=false;
  const poll=h.session.poll({snapshot:h.options.snapshot,read:()=>disk.promise,apply:()=>applied=true});
  if(scenario==='switch')h.state={...h.state,note:{path:'B.md',content:'b',hash:'b'}};
  if(scenario==='edit')h.state={...h.state,text:'typed',revision:2};
  if(scenario==='save')await h.session.save(h.options);
  disk.resolve({path:'A.md',content:'external',hash:'external'}); await poll; assert.equal(applied,false);
});
test('external text equal to current draft is acknowledged without conflict',async()=>{
 const h=harness();let conflict;
 await h.session.poll({snapshot:h.options.snapshot,read:async()=>({...h.state.note,content:'new',hash:'new'}),apply:(_,value)=>conflict=value});
 assert.equal(conflict,false);
});
test('recovery cleanup failure retains successful save acknowledgement',async()=>{
 const result=await saveNoteAndCleanup({saveNote:async()=>({content:'saved',hash:'latest'}),deleteRecoveryIfHash:async()=>{throw Error('disk busy');}}, {path:'a',recoveryId:'12345678-1234-4234-8234-123456789abc'},()=>{});
 assert.equal(result.hash,'latest');assert.equal(result.recoveryCleanupPending,true);
});
test('real conflict does not delete recovery and blocks a successful flush',async()=>{
 const h=harness();h.options.write=async()=>({conflict:true,path:'A.md',content:'external',hash:'external'});
 assert.equal(await h.session.save(h.options),false);assert.equal(h.conflicts.length,1);
});

for (const reason of ['startup', 'recovery', 'conflict', 'mutation']) test(reason + ' gate blocks both save and poll, including a newly blocked pending read', async () => {
  const h = harness(), disk = deferred(); let blocked = false, applied = false, reads = 0;
  const options = { snapshot: h.options.snapshot, blocked: () => blocked, read: () => { reads++; return disk.promise; }, apply: () => applied = true };
  const pending = h.session.poll(options); blocked = true;
  disk.resolve({ path: 'A.md', content: 'external', hash: 'external' }); await pending;
  await h.session.poll(options); assert.equal(applied, false); assert.equal(reads, 1);
  assert.equal(await h.session.save({ ...h.options, blocked: () => blocked }), false); assert.deepEqual(h.writes, []);
});

