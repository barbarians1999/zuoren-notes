const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { FileStore, digest } = require('../electron/storage.cjs');

const storagePath = path.join(__dirname, '../electron/storage.cjs');
const posixOnly = { skip: process.platform === 'win32' && 'POSIX mode bits are not supported on Windows' };
const modeOf = async file => (await fs.stat(file)).mode & 0o777;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-permissions-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic-note.md');
  await fs.writeFile(file, '\ufeffsynthetic original\r\n', { mode: 0o600 });
  const store = new FileStore(); await store.grantRoot(root);
  return { root, file, store };
}

async function loadStorage(io, platform = process.platform) {
  const localRequire = createRequire(storagePath), module = { exports: {} };
  vm.runInNewContext(await fs.readFile(storagePath, 'utf8'), {
    module, require: name => name === 'node:fs/promises' ? io : localRequire(name),
    process: { platform }, Buffer, TextDecoder, setTimeout,
  }, { filename: storagePath });
  return module.exports;
}

test('note saves preserve POSIX permissions while history stays owner-only', posixOnly, async t => {
  for (const mode of [0o600, 0o640, 0o644, 0o660, 0o750, 0o400]) await t.test(mode.toString(8), async t => {
    const { root, file, store } = await fixture(t);
    await fs.chmod(file, mode);
    const before = await fs.readFile(file), note = await store.readNote(file);
    const saved = await store.saveNote({ ...note, content: 'synthetic edited\n' });
    assert.equal(saved.conflict, undefined);
    assert.equal(await modeOf(file), mode, 'atomic replacement must retain the original access mode');
    assert.equal(await fs.readFile(file, 'utf8'), '\ufeffsynthetic edited\r\n');
    const history = path.join(root, '.reader', 'history'), names = await fs.readdir(history);
    assert.equal(names.length, 1);
    assert.equal(await modeOf(path.join(history, names[0])), 0o600);
    assert.deepEqual(await fs.readFile(path.join(history, names[0])), before);
    const current = await store.readNote(file);
    await store.saveNote({ ...current, content: 'another synthetic edit\n' });
    assert.equal(await modeOf(file), mode, 'saving without a new backup must also retain the mode');
    assert.deepEqual((await fs.readdir(root)).sort(), ['.reader', path.basename(file)].sort());
  });
});

test('new notes, atomic files and recovery drafts are private even with a permissive umask', posixOnly, async t => {
  const { root, file } = await fixture(t);
  const script = `
    const fs = require('node:fs/promises'), path = require('node:path');
    const { FileStore, atomicWrite } = require(process.argv[1]);
    (async () => {
      process.umask(0);
      const root = process.argv[2], file = process.argv[3], store = new FileStore();
      await store.grantRoot(root);
      const note = await store.createNoteAt(root, 'created.md', 'new synthetic note');
      const target = path.join(root, 'new-atomic.json'); await atomicWrite(target, '{}');
      const original = await store.readNote(file), recoveryId = '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e19';
      await store.writeRecovery({ sourcePath: file, recoveryId, paneHint: 'primary', baseHash: original.hash,
        content: 'synthetic draft', encoding: { bom: false, eol: '\\n' } });
      const recovery = path.join(root, '.reader', 'recovery', recoveryId + '.json');
      console.log(JSON.stringify(await Promise.all([note.path, target, recovery].map(async name => (await fs.stat(name)).mode & 0o777))));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script, storagePath, root, file]);
  assert.deepEqual(JSON.parse(stdout), [0o600, 0o600, 0o600]);
});

test('replacement restores the original mode rather than restricting it through the current umask', posixOnly, async t => {
  const { file } = await fixture(t);
  const script = `
    const fs = require('node:fs/promises'); const { atomicWrite } = require(process.argv[1]);
    (async () => { process.umask(0o077); await fs.chmod(process.argv[2], 0o664);
      await atomicWrite(process.argv[2], 'synthetic replacement');
      console.log((await fs.stat(process.argv[2])).mode & 0o777);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script, storagePath, file]);
  assert.equal(Number(stdout.trim()), 0o664);
});

test('atomic temporary files are private before any content is written', posixOnly, async t => {
  const { root, file } = await fixture(t); await fs.chmod(file, 0o664);
  let opened = false;
  const { atomicWrite: instrumentedWrite } = await loadStorage({ ...fs, open: async (name, flags, mode) => {
    assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
    const handle = await fs.open(name, flags, mode); opened = true;
    assert.equal(await modeOf(name), 0o600);
    assert.equal((await handle.stat()).size, 0);
    return handle;
  } });
  await instrumentedWrite(file, 'synthetic replacement');
  assert.equal(opened, true); assert.equal(await modeOf(file), 0o664);
  assert.deepEqual(await fs.readdir(root), [path.basename(file)]);
});

test('save uses permissions changed during backup work and leaves conflicts untouched', posixOnly, async t => {
  const { file, store } = await fixture(t); await fs.chmod(file, 0o644);
  const note = await store.readNote(file), auxiliary = store.auxiliary.bind(store);
  store.auxiliary = async target => { const dir = await auxiliary(target); await fs.chmod(file, 0o600); return dir; };
  await store.saveNote({ ...note, content: 'synthetic edit' });
  assert.equal(await modeOf(file), 0o600);
  const current = await store.readNote(file);
  await fs.writeFile(file, 'synthetic external edit'); await fs.chmod(file, 0o640);
  const conflict = await store.saveNote({ ...current, content: 'must not overwrite' });
  assert.equal(conflict.conflict, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic external edit');
  assert.equal(await modeOf(file), 0o640);
});

test('history writes restrict an existing permissive snapshot at the same destination', posixOnly, async t => {
  const { root, file, store } = await fixture(t);
  const history = path.join(root, '.reader', 'history'); await fs.mkdir(history, { recursive: true });
  const now = Date.now(), prefix = digest(path.basename(file)).slice(0, 16) + '-';
  const target = path.join(history, prefix + now + '.md');
  await fs.writeFile(target, 'synthetic earlier snapshot'); await fs.chmod(target, 0o644);
  const note = await store.readNote(file), before = await fs.readFile(file);
  t.mock.method(Date, 'now', () => now);
  await store.saveNote({ ...note, content: 'synthetic edit' });
  assert.deepEqual(await fs.readFile(target), before); assert.equal(await modeOf(target), 0o600);
});

test('permission and stat errors fail closed, preserving the original and cleaning the temporary file', posixOnly, async t => {
  for (const operation of ['stat', 'chmod', 'sync', 'rename']) await t.test(operation, async t => {
    const { root, file } = await fixture(t), original = await fs.readFile(file);
    const failure = Object.assign(new Error('injected ' + operation + ' failure'), { code: 'EACCES' });
    const io = { ...fs };
    if (operation === 'stat') io.stat = async () => { throw failure; };
    if (operation === 'rename') io.rename = async () => { throw failure; };
    if (operation === 'chmod' || operation === 'sync') io.open = async (...args) => {
      const handle = await fs.open(...args);
      handle[operation] = async () => { throw failure; };
      return handle;
    };
    const { atomicWrite: failingWrite } = await loadStorage(io);
    await assert.rejects(failingWrite(file, 'must not replace'), { code: 'EACCES' });
    assert.deepEqual(await fs.readFile(file), original); assert.equal(await modeOf(file), 0o600);
    assert.deepEqual(await fs.readdir(root), [path.basename(file)]);
  });
});

test('an exclusive temporary-file collision does not delete the file owned by another writer', async t => {
  const { file } = await fixture(t); let unlinks = 0;
  const { atomicWrite: collidingWrite } = await loadStorage({ ...fs,
    open: async () => { throw Object.assign(new Error('synthetic collision'), { code: 'EEXIST' }); },
    unlink: async () => { unlinks++; },
  });
  await assert.rejects(collidingWrite(file, 'must not replace'), { code: 'EEXIST' });
  assert.equal(unlinks, 0);
});

test('Windows atomic writes do not invoke POSIX stat or chmod', async () => {
  let written, renamed = false, closed = false;
  const { atomicWrite: windowsWrite } = await loadStorage({
    stat: async () => { throw new Error('POSIX metadata must not be requested on Windows'); },
    open: async (_file, flags, mode) => {
      assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
      return {
        writeFile: async data => { written = data; },
        chmod: async () => { throw new Error('POSIX chmod must not run on Windows'); },
        sync: async () => {}, close: async () => { closed = true; },
      };
    },
    rename: async () => { assert.equal(closed, true); renamed = true; },
    unlink: async () => {},
  }, 'win32');
  await windowsWrite('C:/synthetic/notes/note.md', 'synthetic Windows edit');
  assert.equal(written, 'synthetic Windows edit'); assert.equal(renamed, true);
});
