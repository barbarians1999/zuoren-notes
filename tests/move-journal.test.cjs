'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MoveJournal } = require('../electron/move-journal.cjs');
const { createSymlinkFixture } = require('./symlinkFixtures.cjs');

const uuid = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-move-journal-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root'), source = path.join(root, 'note.md'), targetDirectory = path.join(root, 'target');
  await fs.mkdir(path.join(root, '.reader', 'recovery'), { recursive: true });
  await fs.mkdir(targetDirectory, { recursive: true });
  await fs.writeFile(source, '# note\n');
  const recovery = path.join(root, '.reader', 'recovery', uuid() + '.json');
  await fs.writeFile(recovery, '{"content":"private fixture"}');
  const target = path.join(targetDirectory, 'note.md');
  const journalDirectory = path.join(temp, 'state', 'move-journal');
  const plan = {
    operationId: uuid(), root, source, target,
    rootIdentity: '1:2', expectedIdentity: '3:4', expectedHash: sha('# note\n'),
    records: [{ source: recovery, relative: `recovery/${path.basename(recovery)}`, rawHash: sha('{"content":"private fixture"}'), nextHash: sha('{"content":"private fixture"}') }],
  };
  return { temp, root, source, target, recovery, journalDirectory, plan };
}
function envelope(receipt, result) {
  return { schema: 2, operationId: receipt.operationId, nonce: receipt.nonce, binding: receipt.binding, result };
}
async function writeReceipt(receipt, result) {
  await fs.writeFile(receipt.receiptPath, JSON.stringify(envelope(receipt, result)), 'utf8');
}
function proxyIo(overrides) {
  return new Proxy(fs, { get(target, property) {
    if (property in overrides) return overrides[property];
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function partialWriteIo(filename) {
  return proxyIo({
    async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode);
      if (path.basename(file) !== filename || flags !== 'wx') return handle;
      return {
        writeFile: async data => {
          const bytes = Buffer.from(data);
          await handle.write(bytes.subarray(0, Math.min(9, bytes.length)), 0, Math.min(9, bytes.length), 0);
          throw Error(`injected ${filename} partial write`);
        },
        stat: options => handle.stat(options), sync: () => handle.sync(), close: () => handle.close(),
      };
    },
  });
}

test('load scans only an existing directory and missing configured journal is an empty state', async t => {
  const f = await fixture(t), journal = new MoveJournal(f.journalDirectory);
  const result = await journal.load();
  assert.deepEqual(result, { problem: null, hasPending: false, pending: [] });
  await assert.rejects(fs.lstat(f.journalDirectory), { code: 'ENOENT' });
  assert.equal(journal.blocked, false);
  const unconfigured = new MoveJournal(null);
  assert.match((await unconfigured.load()).problem, /未配置/);
  assert.equal(unconfigured.blocked, true);
});

test('prepare durably reserves a body-free intent and empty receipt before returning worker fields', async t => {
  const f = await fixture(t), journal = new MoveJournal(f.journalDirectory);
  await journal.load();
  const receipt = await journal.prepare(f.plan);
  assert.equal(receipt.operationId, f.plan.operationId);
  assert.match(receipt.nonce, /^[a-f0-9]{64}$/);
  assert.match(receipt.binding, /^[a-f0-9]{64}$/);
  assert.equal(receipt.receiptIdentity.split(':').length, 2);
  assert.equal(receipt.receiptDirectoryIdentity.split(':').length, 2);
  assert.equal(await fs.readFile(receipt.receiptPath, 'utf8'), '');
  const intent = JSON.parse(await fs.readFile(path.join(path.dirname(receipt.receiptPath), 'intent.json'), 'utf8'));
  assert.deepEqual(Object.keys(intent).sort(), ['binding', 'namespacePolicy', 'nonce', 'operationId', 'plan', 'preparedAt', 'receiptDirectoryIdentity', 'receiptIdentity', 'receiptPath', 'schema'].sort());
  assert.deepEqual(Object.keys(intent.plan.records[0]).sort(), ['nextHash', 'rawHash', 'relative', 'source'].sort());
  assert.doesNotMatch(JSON.stringify(intent), /private fixture|NextBase64|content/i);
  assert.equal((await journal.status(f.plan.operationId)).status, 'pending');
  assert.equal(journal.hasPending, true);
});

test('restart restores a pending operation and protects source, target, records, and mutation ancestors', async t => {
  const f = await fixture(t), initial = new MoveJournal(f.journalDirectory);
  const receipt = await initial.prepare(f.plan);
  const restarted = new MoveJournal(f.journalDirectory);
  const loaded = await restarted.load();
  assert.equal(loaded.problem, null); assert.equal(loaded.hasPending, true); assert.equal(loaded.pending.length, 1);
  assert.equal((await restarted.status(f.plan.operationId)).status, 'pending');
  await assert.rejects(restarted.assertAccess(f.source), /受未决文件移动保护/);
  await assert.rejects(restarted.assertAccess(f.target), /受未决文件移动保护/);
  await assert.rejects(restarted.assertAccess(f.recovery), /受未决文件移动保护/);
  await assert.rejects(restarted.assertAccess(f.root, { mutation: true }), /受未决文件移动保护/);
  await assert.rejects(restarted.assertAccess(path.dirname(f.target), { mutation: true }), /受未决文件移动保护/);
  assert.equal(await restarted.assertAccess(path.join(f.temp, 'unrelated.txt')), true);
  assert.equal(await restarted.assertAccess(f.source, { inspect: true }), true);
  await assert.rejects(restarted.assertAccess(f.source, { inspect: true, mutation: true }), /只允许/);
  await assert.rejects(restarted.prepare({ ...f.plan, operationId: uuid() }), /仍未确认/);
  assert.ok(await fs.stat(receipt.receiptPath));
});

test('restart protects a junction alias to a pending mutation root', async t => {
  const f = await fixture(t), initial = new MoveJournal(f.journalDirectory);
  await initial.prepare(f.plan);
  const restarted = new MoveJournal(f.journalDirectory);
  assert.equal((await restarted.load()).problem, null);
  const alias = path.join(f.temp, 'root-alias');
  if (!(await createSymlinkFixture(t, f.root, alias, process.platform === 'win32' ? 'junction' : 'dir'))) return;
  await assert.rejects(restarted.assertAccess(path.join(alias, path.basename(f.source))), /受未决文件移动保护/);
  await assert.rejects(restarted.assertAccess(alias, { mutation: true }), /受未决文件移动保护/);
});

test('only one pending intent is allowed and operation ids cannot be reused', async t => {
  const f = await fixture(t), journal = new MoveJournal(f.journalDirectory);
  await journal.prepare(f.plan);
  await assert.rejects(journal.prepare({ ...f.plan, operationId: uuid() }), /仍未确认/);
  await assert.rejects(journal.prepare(f.plan), /已在移动日志中使用/);
});

test('moved completion requires a matching schema 2 receipt and writes a durable terminal summary', async t => {
  const f = await fixture(t), journal = new MoveJournal(f.journalDirectory);
  const receipt = await journal.prepare(f.plan), result = { status: 'moved', identity: f.plan.expectedIdentity, hash: f.plan.expectedHash };
  await writeReceipt(receipt, result);
  const finished = await journal.complete(f.plan.operationId, { kind: 'moved', result });
  assert.deepEqual(finished, { status: 'moved', operationId: f.plan.operationId, intent: (await journal.status(f.plan.operationId)).intent, result });
  assert.equal(journal.hasPending, false); assert.equal(journal.problem, null);
  const terminal = new MoveJournal(f.journalDirectory);
  assert.equal((await terminal.load()).problem, null);
  const terminalStatus = await terminal.status(f.plan.operationId);
  assert.equal(terminalStatus.status, 'moved'); assert.deepEqual(terminalStatus.result, result); assert.equal(terminalStatus.intent.operationId, f.plan.operationId);
});

test('failed completion is terminal only with a matching failed receipt and never stores user text', async t => {
  const f = await fixture(t), journal = new MoveJournal(f.journalDirectory);
  const receipt = await journal.prepare(f.plan), result = { status: 'failed', error: 'pre-commit refusal' };
  await writeReceipt(receipt, result);
  await journal.complete(f.plan.operationId, { kind: 'failed', result });
  const finishedPath = path.join(path.dirname(receipt.receiptPath), 'FINISHED.json');
  const finishedText = await fs.readFile(finishedPath, 'utf8');
  assert.doesNotMatch(finishedText, /pre-commit refusal|private fixture|error/);
  assert.deepEqual(JSON.parse(finishedText).result, { status: 'failed' });
  assert.equal((await new MoveJournal(f.journalDirectory).load()).hasPending, false);
});

test('empty, uncertain, malformed, and mismatched pending receipts stay unresolved across restart', async t => {
  for (const [name, setReceipt, kind] of [
    ['empty', async () => {}, 'moved'],
    ['uncertain', async receipt => writeReceipt(receipt, { status: 'uncertain', error: 'unknown' }), 'moved'],
    ['malformed', async receipt => fs.writeFile(receipt.receiptPath, '{bad'), 'moved'],
    ['wrong-binding', async receipt => fs.writeFile(receipt.receiptPath, JSON.stringify({ ...envelope(receipt, { status: 'failed' }), binding: '0'.repeat(64) })), 'failed'],
  ]) {
    const f = await fixture(t); f.journalDirectory = path.join(f.temp, `j-${name}`);
    const journal = new MoveJournal(f.journalDirectory), receipt = await journal.prepare(f.plan);
    await setReceipt(receipt);
    await assert.rejects(journal.complete(f.plan.operationId, { kind }), /仍保持闭锁/);
    assert.equal(journal.blocked, true); assert.equal((await journal.status(f.plan.operationId)).status, 'problem');
    const restarted = new MoveJournal(f.journalDirectory);
    const state = await restarted.load();
    assert.equal(state.hasPending, true);
    assert.equal(state.problem, null);
    assert.equal(restarted.blocked, true);
  }
});

test('a new process can recheck claim, malformed, and temporarily busy receipts later', async t => {
  for (const mode of ['claim', 'malformed', 'busy']) {
    const f = await fixture(t);
    f.journalDirectory = path.join(f.temp, `recheck-${mode}`);
    const initial = new MoveJournal(f.journalDirectory), receipt = await initial.prepare(f.plan);
    if (mode === 'claim') await fs.writeFile(receipt.receiptPath, JSON.stringify({
      schema: 2, operationId: receipt.operationId, nonce: receipt.nonce, binding: receipt.binding, result: { status: 'claim' },
    }));
    if (mode === 'malformed') await fs.writeFile(receipt.receiptPath, '{partial receipt');

    let busy = mode === 'busy';
    const io = proxyIo({ async lstat(file, options) {
      if (busy && path.resolve(file) === path.resolve(receipt.receiptPath)) {
        throw Object.assign(new Error('simulated Windows share-mode denial'), { code: 'EACCES' });
      }
      return fs.lstat(file, options);
    } });
    const restarted = new MoveJournal(f.journalDirectory, { io, platform: 'win32' });
    const loaded = await restarted.load();
    assert.equal(loaded.problem, null, `${mode} receipt must not poison a valid intent`);
    assert.equal(loaded.hasPending, true);
    assert.equal((await restarted.status(f.plan.operationId)).status, 'pending');

    busy = false;
    const result = { status: 'failed' };
    await writeReceipt(receipt, result);
    await restarted.complete(f.plan.operationId, { kind: 'failed', result });
    assert.equal((await restarted.status(f.plan.operationId)).status, 'failed');
  }
});

test('intent pre-write failure leaves a half operation and prevents worker preparation after restart', async t => {
  const f = await fixture(t), journal = new MoveJournal(f.journalDirectory, { io: partialWriteIo('intent.json') });
  await assert.rejects(journal.prepare(f.plan), /worker 不得启动/);
  assert.equal(journal.blocked, true);
  const opDir = path.join(f.journalDirectory, f.plan.operationId);
  assert.ok((await fs.stat(path.join(opDir, 'receipt.json'))).isFile());
  assert.ok((await fs.stat(path.join(opDir, 'intent.json'))).size > 0);
  const restarted = new MoveJournal(f.journalDirectory);
  assert.match((await restarted.load()).problem, /日志 JSON 损坏/);
  await assert.rejects(restarted.prepare({ ...f.plan, operationId: uuid() }), /无法安全读取|闭锁/);
});

test('missing intent in a partially created operation is a global problem, not a guessed no-op', async t => {
  const f = await fixture(t); await fs.mkdir(f.journalDirectory, { recursive: true });
  const opDir = path.join(f.journalDirectory, f.plan.operationId); await fs.mkdir(opDir);
  await fs.writeFile(path.join(opDir, 'receipt.json'), '');
  const journal = new MoveJournal(f.journalDirectory);
  assert.match((await journal.load()).problem, /不完整/);
  assert.equal(journal.blocked, true);
});

test('complete failure leaves pending lock and a partial FINISHED record is globally blocked after restart', async t => {
  const f = await fixture(t), initial = new MoveJournal(f.journalDirectory), receipt = await initial.prepare(f.plan);
  await writeReceipt(receipt, { status: 'failed', error: 'definite refusal' });
  const broken = new MoveJournal(f.journalDirectory, { io: partialWriteIo('FINISHED.json') });
  assert.equal((await broken.load()).problem, null);
  await assert.rejects(broken.complete(f.plan.operationId, { kind: 'failed' }), /仍保持闭锁/);
  assert.equal(broken.hasPending, true);
  const restarted = new MoveJournal(f.journalDirectory);
  assert.match((await restarted.load()).problem, /FINISHED JSON 损坏|日志 JSON 损坏/);
});

test('junction journals fail closed', async t => {
  const f = await fixture(t), real = path.join(f.temp, 'real-journal'); await fs.mkdir(real);
  const alias = path.join(f.temp, 'journal-alias');
  if (!(await createSymlinkFixture(t, real, alias, process.platform === 'win32' ? 'junction' : 'dir'))) return;
  assert.match((await new MoveJournal(alias).load()).problem, /符号链接|非规范|不是普通目录/);
});

test('non-directory journals, oversized or corrupt JSON globally fail closed', async t => {
  const f = await fixture(t), real = path.join(f.temp, 'real-journal'); await fs.mkdir(real);
  const file = path.join(f.temp, 'not-a-directory'); await fs.writeFile(file, 'x');
  assert.match((await new MoveJournal(file).load()).problem, /不是普通目录/);

  const journal = new MoveJournal(real), receipt = await journal.prepare(f.plan);
  await fs.writeFile(path.join(path.dirname(receipt.receiptPath), 'intent.json'), '{broken');
  assert.match((await new MoveJournal(real).load()).problem, /JSON 损坏/);
  await fs.writeFile(path.join(path.dirname(receipt.receiptPath), 'intent.json'), Buffer.alloc(1024 * 1024 + 1, 32));
  assert.match((await new MoveJournal(real).load()).problem, /超过/);
});

test('concurrent load and access share one scan; no path can pass while readdir is pending', async t => {
  const f = await fixture(t), setup = new MoveJournal(f.journalDirectory);
  await setup.prepare(f.plan);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const io = proxyIo({ async readdir(directory, options) {
    if (directory === f.journalDirectory) { entered(); await gate; }
    return fs.readdir(directory, options);
  } });
  const journal = new MoveJournal(f.journalDirectory, { io });
  const loading = journal.load(); await started;
  let accessSettled = false;
  const access = journal.assertAccess(f.source).then(value => { accessSettled = true; return value; }, error => { accessSettled = true; throw error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accessSettled, false, 'concurrent access must await the same pending journal scan');
  release(); await loading;
  await assert.rejects(access, /受未决文件移动保护/);
  assert.equal(accessSettled, true);
});

test('paths are protected while prepare is still fsyncing and before it returns a worker receipt', async t => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const io = proxyIo({ async open(file, flags, mode) {
    if (path.basename(file) === 'receipt.json' && flags === 'wx') { entered(); await gate; }
    return fs.open(file, flags, mode);
  } });
  const journal = new MoveJournal(f.journalDirectory, { io });
  const preparing = journal.prepare(f.plan); await started;
  assert.equal(journal.hasPending, true);
  await assert.rejects(journal.assertAccess(f.source), /受未决文件移动保护/);
  release(); await preparing;
  assert.equal(journal.hasPending, true);
});

test('Windows policy syncs journal files without opening directories for unsupported flushes', async t => {
  const f = await fixture(t);
  let directoryOpenCount = 0, fileSyncCount = 0;
  const io = proxyIo({ async open(file, flags, mode) {
    let stat;
    try { stat = await fs.lstat(file); } catch {}
    if (stat?.isDirectory()) {
      directoryOpenCount++;
      throw Object.assign(new Error('simulated Windows directory flush unsupported'), { code: 'EPERM' });
    }
    const handle = await fs.open(file, flags, mode);
    return {
      writeFile: (...args) => handle.writeFile(...args),
      readFile: (...args) => handle.readFile(...args),
      stat: (...args) => handle.stat(...args),
      sync: async (...args) => { fileSyncCount++; return handle.sync(...args); },
      close: (...args) => handle.close(...args),
    };
  } });
  const journal = new MoveJournal(f.journalDirectory, { io, platform: 'win32' });
  const receipt = await journal.prepare(f.plan);
  const intent = JSON.parse(await fs.readFile(path.join(path.dirname(receipt.receiptPath), 'intent.json'), 'utf8'));
  assert.equal(intent.namespacePolicy, 'process-crash-only-no-directory-flush');
  await writeReceipt(receipt, { status: 'failed' });
  await journal.complete(f.plan.operationId, { kind: 'failed', result: { status: 'failed' } });
  assert.equal(directoryOpenCount, 0, 'Windows mode must avoid opening directories for FlushFileBuffers');
  assert.ok(fileSyncCount >= 3, 'receipt, intent, and FINISHED files still require synchronization');
  assert.equal((await journal.status(f.plan.operationId)).status, 'failed');
});

test('global journal corruption blocks all ordinary access, while explicit inspect remains read-only', async t => {
  const f = await fixture(t); await fs.mkdir(f.journalDirectory, { recursive: true });
  await fs.mkdir(path.join(f.journalDirectory, f.plan.operationId));
  await fs.writeFile(path.join(f.journalDirectory, f.plan.operationId, 'receipt.json'), '');
  const journal = new MoveJournal(f.journalDirectory); await journal.load();
  await assert.rejects(journal.assertAccess(path.join(f.temp, 'unrelated.md')), /全局闭锁|不完整/);
  await assert.rejects(journal.assertAccess(path.join(f.temp, 'unrelated.md'), { mutation: true }), /全局闭锁|不完整/);
  assert.equal(await journal.assertAccess(f.source, { inspect: true }), true);
});

test('forbidden plan payload and invalid records are rejected before creating a worker receipt', async t => {
  const f = await fixture(t), journal = new MoveJournal(f.journalDirectory);
  await assert.rejects(journal.prepare({ ...f.plan, NextBase64: 'private fixture' }), /包含未允许字段/);
  await assert.rejects(journal.prepare({ ...f.plan, records: [{ ...f.plan.records[0], relative: '../escape' }] }), /越界/);
  assert.equal(journal.problem, null);
  await assert.rejects(fs.lstat(f.journalDirectory), { code: 'ENOENT' });
});

