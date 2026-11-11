const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeFileMover } = require('../electron/native-file-mover.cjs');
const cases = ['relative-no-reparse-does-not-create-outside', 'held-sentinel-prevents-directory-reparse', 'relative-rename-and-no-replace', 'source-handle-excludes-concurrent-write'];
const supported = { status: 'supported', protocol: 2, cases };
async function fixture(t, behavior, release_ready = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-native-transport-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workerPath = path.join(dir, 'worker.exe'), manifestPath = path.join(dir, 'manifest.json'); await fs.writeFile(workerPath, 'mock executable, never executed');
  const manifest = { protocol: 2, binary_sha256: crypto.createHash('sha256').update(await fs.readFile(workerPath)).digest('hex'), release_ready };
  await fs.writeFile(manifestPath, JSON.stringify(manifest)); const calls = [], children = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kills = 0; child.kill = () => { child.kills++; return true; }; child.ready = () => child.stdout.write('{"event":"ready","protocol":2}\n');
    child.finish = (value, code = 0) => { child.stdout.write(JSON.stringify(value) + '\n'); child.emit('close', code); };
    children.push(child); queueMicrotask(() => behavior(child, args)); return child;
  };
  const native = new NativeFileMover({ platform: 'win32', arch: 'x64', spawn, workerPath, manifestPath, timeout: 40, cleanupTimeout: 15 });
  return { native, calls, children, dir, workerPath, manifestPath, manifest };
}
test('non-Windows and x86 capability checks never spawn', async () => {
  for (const options of [{ platform: 'linux', arch: 'x64' }, { platform: 'win32', arch: 'ia32' }]) {
    const native = new NativeFileMover({ ...options, spawn() { assert.fail('must not spawn'); } }); assert.equal((await native.capability()).supported, false);
  }
});
test('unqualified candidate is gated before probe or file access subprocess', async t => {
  const f = await fixture(t, () => assert.fail('must not spawn'), false); assert.equal((await f.native.capability()).supported, false); await assert.rejects(f.native.move({}), /验收|前置/); assert.equal(f.calls.length, 0);
});
test('binary digest mismatch is refused before spawn', async t => {
  const f = await fixture(t, () => assert.fail('must not spawn')); await fs.writeFile(f.workerPath, 'changed'); assert.equal((await f.native.capability()).supported, false); assert.equal(f.calls.length, 0);
});
test('probe identity and all mandatory cases are required', async t => {
  const f = await fixture(t, child => { child.ready(); child.finish({ ...supported, cases: ['one','two','three','four'] }); }); assert.equal((await f.native.capability()).supported, false);
});
test('probe is cached; each actual move rechecks executable hash and uses shell:false', async t => {
  const f = await fixture(t, (child, args) => { child.ready(); child.finish(args.length ? supported : { status: 'moved', identity: '1:2', hash: 'a'.repeat(64) }); });
  assert.equal((await f.native.capability()).supported, true); assert.equal((await f.native.capability()).supported, true); assert.equal(f.calls.length, 1);
  assert.equal((await f.native.move({ Source: 'owned fixture' })).status, 'moved'); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].options.shell, false);
  await fs.writeFile(f.workerPath, 'tampered'); await assert.rejects(f.native.move({}), /身份不匹配/); assert.equal(f.calls.length, 2);
});
test('revoking qualification after successful probe prevents the next move', async t => {
  const f = await fixture(t, child => { child.ready(); child.finish(supported); }); assert.equal((await f.native.capability()).supported, true);
  await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, release_ready: false })); await assert.rejects(f.native.move({}), /验收/); assert.equal(f.calls.length, 1);
});
for (const kind of ['failed', 'uncertain', 'corrupt', 'nonzero']) test(`${kind} receipt cannot be misreported as a successful move`, async t => {
  const f = await fixture(t, (child, args) => { child.ready(); if (args.length) return child.finish(supported);
    if (kind === 'corrupt') { child.stdout.write('not-json\n'); child.emit('close', 0); }
    else child.finish({ status: kind === 'nonzero' ? 'moved' : kind, error: 'injected' }, kind === 'nonzero' ? 9 : kind === 'failed' ? 4 : kind === 'uncertain' ? 5 : 0);
  });
  await assert.rejects(f.native.move({}), error => kind === 'failed' ? !error.code : error.code === 'MOVE_UNCERTAIN'); assert.equal(f.native.active, false);
});
test('timeout kills only the owned child and retains global lock until late close', async t => {
  const f = await fixture(t, child => child.ready());
  await assert.rejects(f.native.run([], {}), { code: 'MOVE_UNCERTAIN' }); assert.equal(f.children[0].kills, 1); assert.equal(f.native.active, true);
  assert.equal((await f.native.capability()).supported, false); await assert.rejects(f.native.run([], {}), /尚未退出/); assert.equal(f.calls.length, 1);
  f.children[0].emit('close', 1); assert.equal(f.native.active, false);
});
test('ready process with oversized output is bounded and forced closed conservatively', async t => {
  const f = await fixture(t, child => { child.ready(); child.stdout.write(Buffer.alloc(400 * 1024, 65)); });
  await assert.rejects(f.native.run([], {}), { code: 'MOVE_UNCERTAIN' }); assert.equal(f.children[0].kills, 1); f.children[0].emit('close', 1);
});
test('synchronous spawn denial has no process and no retained lock', async t => {
  const f = await fixture(t, () => {}); f.native.spawn = () => { throw new Error('access denied'); };
  await assert.rejects(f.native.run([], {}), /access denied/); assert.equal(f.native.active, false);
});
test('pre-ready startup error waits for owned close before allowing another process', async t => {
  const f = await fixture(t, child => child.emit('error', new Error('spawn failure')));
  await assert.rejects(f.native.run([], {}), /spawn failure/); assert.equal(f.native.active, true); f.children[0].emit('close', -1); assert.equal(f.native.active, false);
});

test('multiple final receipts cannot become a confirmed success', async t => {
  const f = await fixture(t, (child,args) => { child.ready(); if(args.length)return child.finish(supported); child.stdout.write('{"status":"moved"}\\n'.replace('\\n','\n')); child.finish({status:'failed'},4); });
  await assert.rejects(f.native.move({}),{code:'MOVE_UNCERTAIN'});
});
test('shipping native asset hashes and scoped qualification evidence match the enabled worker', async () => {
  const directory = path.join(__dirname, '../electron/native'), manifest = JSON.parse(await fs.readFile(path.join(directory, 'FileMoveWorker.manifest.json'), 'utf8'));
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(manifest.release_ready, true); assert.equal(manifest.source_sha256, sha(await fs.readFile(path.join(directory,'FileMoveWorker.cs'))));
  assert.equal(manifest.binary_sha256, sha(await fs.readFile(path.join(directory,'FileMoveWorker.exe'))));
  assert.deepEqual(manifest.qualified_scope.filesystems, ['NTFS', 'exFAT']);
  assert.deepEqual(manifest.qualified_scope.driveTypes, ['fixed-local']);
  assert.deepEqual(manifest.qualified_scope.refused, ['volume-root', 'removable', 'network', 'reparse']);
  for (const kind of ['native-ntfs', 'native-exfat', 'stage-and-concurrency', 'environment-negative', 'electron-exfat']) {
    const evidence = manifest.qualification_evidence.find(item => item.kind === kind);
    assert.ok(evidence?.path); assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  }
});

for (const stream of ['stdout','stderr']) test(`owned ${stream} stream failure still stops and retains unknown exit protection`, async t => {
  const f = await fixture(t, child => { child.ready(); child[stream].emit('error', Error('injected pipe error')); });
  await assert.rejects(f.native.run([],{}), {code:'MOVE_UNCERTAIN'}); assert.equal(f.native.active,true); assert.equal(f.children[0].kills,1); f.children[0].emit('close',1);
});
test('oversized first stdout chunk before parent observes ready cannot mean a definite non-move', async t => {
  const f = await fixture(t, child => child.stdout.write(Buffer.alloc(400*1024,65)));
  await assert.rejects(f.native.run([],{}), {code:'MOVE_UNCERTAIN'}); assert.equal(f.native.active,true); f.children[0].emit('close',1);
});

const receiptRequest = () => ({ OperationId: crypto.randomUUID(), ReceiptNonce: 'b'.repeat(64), RequestBinding: 'c'.repeat(64), ReceiptPath: '/owned/receipt.json', ReceiptIdentity: '1:2', ReceiptDirectoryIdentity: '1:3' });
const envelopeFor = input => ({ schema: 2, operationId: input.OperationId, nonce: input.ReceiptNonce, binding: input.RequestBinding, result: { status: 'moved', identity: '1:4', hash: 'd'.repeat(64) } });
test('receipt recheck is read-only and remains available while product writes are unqualified', async t => {
  const input=receiptRequest(), envelope=envelopeFor(input), f=await fixture(t, (child,args)=>{assert.deepEqual(args,['--read-receipt']);child.ready();child.finish({status:'receipt',receipt:envelope});},false);
  assert.deepEqual(await f.native.readReceipt(input),envelope.result);assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.shell,false);assert.equal((await f.native.capability()).supported,false);assert.equal(f.calls.length,1,'neither probe nor move was launched');
});
for(const field of ['schema','operationId','nonce','binding','result'])test(`receipt recheck rejects mismatched ${field} without a move retry`,async t=>{
  const input=receiptRequest(),envelope=envelopeFor(input);envelope[field]=field==='schema'?1:field==='result'?{status:'claim'}:'different';
  const f=await fixture(t,child=>{child.ready();child.finish({status:'receipt',receipt:envelope});},false);
  await assert.rejects(f.native.readReceipt(input),/回执未确认/);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].args,['--read-receipt']);
});
test('busy, empty or uncommitted receipt is unresolved exit 6, never a proven failed move',async t=>{
  const f=await fixture(t,child=>{child.ready();child.finish({status:'unresolved'},6);},false);
  await assert.rejects(f.native.readReceipt(receiptRequest()),/回执未确认/);assert.equal(f.native.active,false);assert.equal(f.calls.length,1);
});
test('receipt recheck verifies binary and refuses active owned worker before spawning',async t=>{
  const f=await fixture(t,()=>assert.fail('no process expected'),false);f.native.active=true;await assert.rejects(f.native.readReceipt(receiptRequest()),/独占/);f.native.active=false;await fs.writeFile(f.workerPath,'tampered');await assert.rejects(f.native.readReceipt(receiptRequest()),/身份不匹配/);assert.equal(f.calls.length,0);
});
