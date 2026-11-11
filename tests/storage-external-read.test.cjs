const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function fixture(change = {}) {
  const before = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
  let stats = 0, checks = 0;
  const io = {
    realpath: async file => { checks++; return change.redirect && checks > 1 ? '/outside/note.md' : file; },
    stat: async () => { stats++; return stats === 1 ? before : { ...before, ...change }; },
    readFile: async () => Buffer.from(change.bytes || 'new'),
  };
  const realRequire = createRequire(path.join(__dirname, '../electron/storage.cjs')), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/storage.cjs'), 'utf8'), {
    module, require: name => name === 'node:fs/promises' ? io : realRequire(name), process: { platform: 'linux' }, Buffer, TextDecoder, setTimeout,
  });
  const store = new module.exports.FileStore(); store.files.add('/notes/note.md');
  return store;
}
for (const [field, value] of [['ino', 3], ['size', 4], ['mtimeMs', 6], ['ctimeMs', 6], ['dev', 2]]) test(`read spanning a changed ${field} is rejected for retry`, async () => {
  await assert.rejects(fixture({ [field]: value }).readNote('/notes/note.md'), /其他程序修改/);
});
test('changed byte length is rejected even if the provided metadata was unchanged', async () => {
  await assert.rejects(fixture({ bytes: 'larger' }).readNote('/notes/note.md'), /其他程序修改/);
});
test('a path redirected outside the original grant while reading is rejected', async () => {
  await assert.rejects(fixture({ redirect: true }).readNote('/notes/note.md'), /请先/);
});
test('a stable file snapshot returns its actual bytes and hash', async () => {
  const note = await fixture().readNote('/notes/note.md'); assert.equal(note.content, 'new'); assert.equal(note.path, '/notes/note.md'); assert.match(note.hash, /^[0-9a-f]{64}$/);
});
