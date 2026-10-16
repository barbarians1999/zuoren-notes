const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function createStore({ failures, initial = 'old' }) {
  const files = new Map([['C:/notes/note.md', Buffer.from(initial)]]);
  let attempts = 0;
  const io = {
    open: async file => ({
      writeFile: async data => files.set(file, Buffer.from(data)),
      sync: async () => {},
      close: async () => {},
    }),
    rename: async (from, to) => {
      attempts++;
      if (attempts <= failures) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      if (attempts > failures + 1) throw new Error('unexpected extra rename');
      files.set(to, files.get(from)); files.delete(from);
    },
    unlink: async file => { files.delete(file); },
  };
  const require = createRequire(path.join(__dirname, '../electron/storage.cjs'));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/storage.cjs'), 'utf8'), {
    module,
    require: name => name === 'node:fs/promises' ? io : require(name),
    process: { platform: 'win32' },
    Buffer,
    TextDecoder,
    setTimeout,
  });
  return { store: new module.exports.FileStore(), files, attempts: () => attempts };
}

test('atomic note write retries brief Windows rename locks without leaving the original replaced early', async () => {
  const { store, files, attempts } = createStore({ failures: 2 });
  const original = files.get('C:/notes/note.md').toString();
  const writing = store.writeRecoveryRecord('C:/notes/note.md', Buffer.from('new'));
  assert.equal(files.get('C:/notes/note.md').toString(), original, 'failed attempts never expose a partial write');
  await writing;
  assert.equal(attempts(), 3);
  assert.equal(files.get('C:/notes/note.md').toString(), 'new');
  assert.equal([...files.keys()].some(file => file.endsWith('.tmp')), false);
});

test('atomic note write stops after bounded Windows rename retries and preserves the original', async () => {
  const { store, files, attempts } = createStore({ failures: 20 });
  await assert.rejects(store.writeRecoveryRecord('C:/notes/note.md', Buffer.from('new')), { code: 'EPERM' });
  assert.equal(attempts(), 6);
  assert.equal(files.get('C:/notes/note.md').toString(), 'old');
  assert.equal([...files.keys()].some(file => file.endsWith('.tmp')), false);
});
