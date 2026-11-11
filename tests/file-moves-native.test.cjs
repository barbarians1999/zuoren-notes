// Production broker tests use a contract mock, not Windows API emulation.
// All file fixtures are newly created TEMP directories; no Electron is started.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { FileStore, digest } = require('../electron/storage.cjs');
const { MoveJournal } = require('../electron/move-journal.cjs');
const { ownedNativeMoveMock } = require('./helpers/owned-native-move-mock.cjs');
const { FileMoves } = require('../electron/file-moves.cjs');
const { NativeFileMover } = require('../electron/native-file-mover.cjs');
const { createSymlinkFixture } = require('./symlinkFixtures.cjs');
async function fixture(t, extension = 'md') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-native-broker-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '目标'), source = path.join(root, '笔记.' + extension); await fs.mkdir(directory); await fs.writeFile(source, '\ufeff# 原稿\r\n中文 😀');
  const store = new FileStore(); await store.grantRoot(root); const requests = [];
  const native = ownedNativeMoveMock(root, requests);
  const moves = new FileMoves(store, { native, journal: new MoveJournal(path.join(root,'.move-journal')) }); const entry = (await store.listDirectory(root, root)).entries.find(e => e.path === source);
  const input = { operationId: randomUUID(), root, path: source, directory, expectedVersion: entry.moveVersion };
  return { root, directory, source, target: path.join(directory, path.basename(source)), store, moves, native, requests, input };
}
test('production capability is closed on Linux and does not mutate source or create metadata', async t => {
  const f = await fixture(t), moves = new FileMoves(f.store, { native: new NativeFileMover({ platform: 'linux' }) }), before = await fs.readFile(f.source);
  assert.equal((await moves.capability()).supported, false); await assert.rejects(moves.move(f.input), /Windows|前置|移动/);
  assert.deepEqual(await fs.readFile(f.source), before); assert.deepEqual(await fs.readdir(f.directory), []); assert.equal((await moves.status(f.input.operationId)).status, 'failed');
});
test('production source has no stage/link/unlink fallback and the historic race implementation is test-only', async () => {
  const text = await fs.readFile(path.join(__dirname, '../electron/file-moves.cjs'), 'utf8');
  assert.doesNotMatch(text, /this\.io\.(?:link|rename|unlink|mkdir|mkdtemp|writeFile)\(/); assert.doesNotMatch(text, /prototypeForTests/);
  assert.match(text, /this\.native\.move/);
});
test('native request is bound to granted root identity, locked-source identity and SHA, never only file names', async t => {
  const f = await fixture(t), result = await f.moves.move(f.input); assert.equal(result.ok, true); assert.equal(f.requests.length, 1);
  const request = f.requests[0], stat = await fs.stat(f.target, { bigint: true });
  assert.equal(request.RootIdentity, f.store.rootIdentities.get(f.root)); assert.equal(request.ExpectedIdentity, [stat.dev, stat.ino].join(':'));
  assert.equal(request.ExpectedHash, digest(await fs.readFile(f.target))); assert.equal(request.Target, f.target); assert.deepEqual(request.Records, []);
});
test('a rename may change its file ID while the receipt, target snapshot and Undo stay bound to the final identity', async t => {
  const f=await fixture(t),before=await f.moves.snapshot(f.source),[volume,index]=before.identity.split(':'),afterIdentity=volume+':'+(BigInt(index)+123456n);
  const snapshot=f.moves.snapshot.bind(f.moves);
  f.moves.snapshot=async file=>{const actual=await snapshot(file);return file===f.target?{...actual,identity:afterIdentity}:actual;};
  f.native.move=async input=>{f.requests.push(input);await fs.rename(input.Source,input.Target);return{status:'moved',identity:afterIdentity,hash:input.ExpectedHash};};
  const result=await f.moves.move(f.input);assert.equal(result.ok,true);
  assert.equal(f.requests[0].ExpectedIdentity,before.identity,'the source is still bound before dispatch');
  assert.equal(f.moves.undos.get(result.undoToken).identity,afterIdentity,'Undo uses the committed target identity');
  const intent=(await f.moves.journal.status(f.input.operationId)).intent;
  await assert.rejects(f.moves.verifyOutcome(intent,{status:'moved',identity:volume+':'+(BigInt(index)+654321n),hash:before.hash}),/保持保护|身份/,'a receipt for another target object is still rejected');
  assert.equal(await f.moves.finalize(f.input.operationId),true);
  const reloaded=new MoveJournal(path.join(f.root,'.move-journal'));
  assert.equal((await reloaded.load()).hasPending,false,'journal reload accepts a final ID change on the same volume');
  const terminal=await reloaded.status(f.input.operationId);assert.equal(terminal.status,'moved');assert.equal(terminal.result.identity,afterIdentity);
});
for(const mismatch of ['volume','hash'])test(`journal refuses a moved receipt with the wrong ${mismatch} after allowing file-ID changes`,async t=>{
  const f=await fixture(t);await f.moves.move(f.input);const intent=(await f.moves.journal.status(f.input.operationId)).intent;
  const envelope=JSON.parse(await fs.readFile(intent.receiptPath,'utf8'));
  if(mismatch==='volume'){const [volume,index]=envelope.result.identity.split(':');envelope.result.identity=(BigInt(volume)+1n)+':'+index;}
  else envelope.result.hash='0'.repeat(64);
  await fs.writeFile(intent.receiptPath,JSON.stringify(envelope));
  await assert.rejects(f.moves.journal.complete(f.input.operationId,{kind:'moved'}),/身份或摘要不匹配/);
  const fresh=new MoveJournal(path.join(f.root,'.move-journal'));assert.equal((await fresh.load()).hasPending,true);
  await assert.rejects(fresh.assertAccess(f.source),/保护|未决/);await assert.rejects(fresh.assertAccess(f.target),/保护|未决/);
});
test('same operation id coalesces and cannot replay a different payload', async t => {
  const f = await fixture(t), a = f.moves.move(f.input), b = f.moves.move(f.input); assert.equal(a, b); assert.equal((await f.moves.status(f.input.operationId)).status, 'pending');
  const result = await a; assert.deepEqual(await f.moves.status(f.input.operationId), { status: 'finished', result }); assert.equal(await f.moves.move(f.input), result);
  await assert.rejects(f.moves.move({ ...f.input, directory: f.root }), /标识/); assert.equal(f.requests.length, 1);
});
for (const kind of ['file', 'directory', 'symlink']) test(`native broker rejects occupied ${kind} before dispatch`, async t => {
  const f = await fixture(t); if (kind === 'file') await fs.writeFile(f.target, 'foreign'); else if (kind === 'directory') await fs.mkdir(f.target); else if (!(await createSymlinkFixture(t, f.source, f.target, 'file'))) return;
  await assert.rejects(f.moves.move(f.input), /同名/); assert.equal(f.requests.length, 0); assert.ok(await fs.stat(f.source));
});
test('directory source and no-op cannot dispatch', async t => {
  const f = await fixture(t); await assert.rejects(f.moves.move({ ...f.input, directory: f.root }), /已经/);
  await assert.rejects(f.moves.move({ ...f.input, operationId: randomUUID(), path: f.directory }), /不能移动目录/);
});
test('junction target cannot dispatch', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias');
  if (!(await createSymlinkFixture(t, f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir'))) return;
  await assert.rejects(f.moves.move({ ...f.input, operationId: randomUUID(), directory: alias }), /链接/); assert.equal(f.requests.length, 0);
});
test('other granted root cannot dispatch', async t => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-broker-outside-')); t.after(() => fs.rm(outside, { recursive: true, force: true })); await f.store.grantRoot(outside);
  await assert.rejects(f.moves.move({ ...f.input, operationId: randomUUID(), directory: outside }), /根目录/); assert.equal(f.requests.length, 0);
});
test('source listing revision must match, while a verified app-saved hash allows a new revision', async t => {
  const f = await fixture(t); await fs.writeFile(f.source, '新保存正文'); await assert.rejects(f.moves.move(f.input), /发生变化/);
  const result = await f.moves.move({ ...f.input, operationId: randomUUID(), expectedHash: digest(Buffer.from('新保存正文')) }); assert.equal(result.ok, true);
});
test('a mismatched native identity is uncertain, pins the backend and never permits the next move', async t => {
  const f = await fixture(t); f.native.move = async () => ({ status: 'moved', identity: 'foreign', hash: 'f'.repeat(64) });
  await assert.rejects(f.moves.move(f.input), { code: 'MOVE_UNCERTAIN' }); assert.equal((await f.moves.status(f.input.operationId)).status, 'unknown');
  await assert.rejects(f.moves.move({ ...f.input, operationId: randomUUID() }), /尚未确认/);
});
test('worker timeout remains unknown even after process exit; filesystem name polling cannot clear it', async t => {
  const f = await fixture(t); f.native.move = async () => { throw Object.assign(Error('lost receipt'), { code: 'MOVE_UNCERTAIN' }); };
  await assert.rejects(f.moves.move(f.input), { code: 'MOVE_UNCERTAIN' });
  assert.equal((await f.moves.status(f.input.operationId)).status, 'unknown'); await assert.rejects(f.moves.recover(f.input.operationId), /闭锁/);
});
test('confirmed pre-commit refusal records failure without claiming success', async t => {
  const f = await fixture(t); f.native.move = async () => { throw Error('no-replace refused'); };
  await assert.rejects(f.moves.move(f.input), /未移动/); assert.deepEqual(await f.moves.status(f.input.operationId), { status: 'failed', error: '已确认正文未移动。' }); assert.ok(await fs.stat(f.source));
});
test('Markdown metadata preserves old recovery/history; only recovery sourcePath is transformed for native locked copy', async t => {
  const f = await fixture(t), note = await f.store.readNote(f.source), id = randomUUID();
  await f.store.writeRecovery({ sourcePath: f.source, recoveryId: id, paneHint: 'primary', baseHash: note.hash, content: '保留未保存稿', encoding: { bom: true, eol: '\r\n' } });
  await f.store.saveNote({ ...note, content: '保存正文' }); const entry = (await f.store.listDirectory(f.root, f.root)).entries.find(e => e.path === f.source);
  await f.moves.move({ ...f.input, expectedVersion: entry.moveVersion }); const records = f.requests[0].Records; assert.ok(records.length >= 2);
  for (const r of records) { const raw = await fs.readFile(r.Source); assert.equal(r.RawHash, digest(raw));
    const next = Buffer.from(r.NextBase64, 'base64');
    if (r.Relative.startsWith('recovery\\')) { const before = JSON.parse(raw), after = JSON.parse(next); assert.equal(before.sourcePath, f.source); assert.equal(after.sourcePath, f.target); delete before.sourcePath; delete after.sourcePath; assert.deepEqual(after, before); }
    else assert.deepEqual(next, raw);
  }
  assert.equal(await fs.readFile(f.target,'utf8'), '\ufeff保存正文');
  assert.ok(records.every(record => record.Source.startsWith(f.root)), 'source metadata originals remain in the owned fixture');
});
for (const extension of ['pdf', 'epub']) test(`${extension} native request retains exact annotation bytes`, async t => {
  const f = await fixture(t, extension); const data = extension === 'pdf' ? await f.store.pdf(f.source) : await f.store.epub(f.source);
  if (extension === 'pdf') await f.store.savePdf(f.source, { ...data.meta, page: 2 }); else await f.store.saveEpub(f.source, { ...data.meta, progress: .4 });
  await f.moves.move(f.input); assert.equal(f.requests[0].Records.length, 1); const r = f.requests[0].Records[0]; assert.deepEqual(Buffer.from(r.NextBase64, 'base64'), await fs.readFile(r.Source));
});
test('bad recovery stops before dispatch; existing record and source remain', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, '.reader', 'recovery'), { recursive: true }); await fs.writeFile(path.join(f.root, '.reader', 'recovery', randomUUID() + '.json'), '{bad');
  await assert.rejects(f.moves.move(f.input), /损坏/); assert.equal(f.requests.length, 0); assert.ok(await fs.stat(f.source));
});
test('closed-file Undo is bound to committed identity and SHA, not a later target version', async t => {
  const f = await fixture(t); f.native.move = async request => { f.requests.push(request); await fs.rename(request.Source, request.Target); return { status: 'moved', identity: request.ExpectedIdentity, hash: request.ExpectedHash }; };
  const moved = await f.moves.move(f.input), body = await fs.readFile(f.target); await f.moves.finalize(f.input.operationId); await fs.writeFile(f.target, 'externally changed');
  await assert.rejects(f.moves.undo({ operationId: randomUUID(), token: moved.undoToken }), /发生变化/); assert.equal(f.requests.length, 1);
  await fs.writeFile(f.target, body); const replacement = path.join(f.directory, 'replacement'); await fs.writeFile(replacement, body); await fs.rename(replacement, f.target);
  await assert.rejects(f.moves.undo({ operationId: randomUUID(), token: moved.undoToken }), /替换/); assert.equal(f.requests.length, 1);
});
test('expired Undo is an explicit recorded failure', async t => {
  const f = await fixture(t), id = randomUUID(); await assert.rejects(f.moves.undo({ operationId: id, token: 'missing' }), /失效/); assert.equal((await f.moves.status(id)).status, 'failed');
});
