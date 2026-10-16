const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { recoveryDraftHash } = require('../electron/storage.cjs');
const load = createRequire(path.join(__dirname, '../electron/storage.cjs'));
function makeRecovery(sourcePath, index = 0) {
  const recoveryId = `6a8d4aa2-cc3b-4dae-84c4-86b028ad7e2${index}`, content = 'draft ' + index;
  return { name: recoveryId + '.json', raw: JSON.stringify({ version: 1, recoveryId, sourcePath, paneHint: 'primary', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', baseHash: 'a'.repeat(64), draftHash: recoveryDraftHash(content), content, encoding: { bom: false, eol: '\n' } }) };
}

function fixture(caseSensitive = true) {
  const entries = new Map(), moves = []; let inode = 0;
  const add = (name, data) => entries.set(name, { data, ino: ++inode });
  add('/notes');
  const key = name => [...entries.keys()].find(candidate => caseSensitive ? candidate === name : candidate.toLowerCase() === name.toLowerCase());
  const find = name => { const real = key(name); if (!real) throw Object.assign(Error('missing: ' + name), { code: 'ENOENT' }); return entries.get(real); };
  const io = {
    realpath: async name => { find(name); return key(name); },
    stat: async name => { const item = find(name); return { dev: 1, ino: item.ino, isFile: () => item.data !== undefined, isDirectory: () => item.data === undefined }; },
    access: async name => { find(name); },
    readFile: async name => Buffer.from(find(name).data),
    readdir: async (name, options) => [...entries.keys()].filter(item => path.posix.dirname(item) === key(name)).map(item => options?.withFileTypes
      ? { name: path.posix.basename(item), isDirectory: () => entries.get(item).data === undefined, isSymbolicLink: () => false } : path.posix.basename(item)),
    rename: async (from, to) => {
      const real = key(from); find(from); moves.push([from, to]);
      const children = [...entries].filter(([name]) => name === real || name.startsWith(real + '/'));
      for (const [name] of children) entries.delete(name);
      for (const [name, item] of children) entries.set(to + name.slice(real.length), item);
    },
  };
  const sandbox = { module: { exports: {} }, require: name => name === 'node:fs/promises' ? io : name === 'node:path' ? path.posix : load(name), process: { platform: 'darwin' }, Buffer, TextDecoder };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/storage.cjs'), 'utf8'), sandbox);
  const store = new sandbox.module.exports.FileStore(); store.roots.add('/notes');
  return { store, entries, moves, add };
}

test('case-distinct existing files and folders cannot be overwritten by a case-only rename', async () => {
  for (const directory of [false, true]) {
    const { store, entries, moves, add } = fixture();
    const from = directory ? '/notes/Folder' : '/notes/A.md', to = directory ? '/notes/folder' : '/notes/a.md';
    add(from, directory ? undefined : 'first note'); add(to, directory ? undefined : 'different note');
    await assert.rejects(store.renameEntry(from, path.posix.basename(to)), /已经存在/);
    assert.equal(entries.has(from), true); assert.equal(entries.has(to), true);
    if (!directory) assert.equal(entries.get(to).data, 'different note');
    assert.equal(moves.length, 0, 'collision is rejected before moving either entry');
  }
});
test('a genuine case alias or unused case-distinct target can be renamed without changing content', async () => {
  for (const caseSensitive of [true, false]) {
    const { store, entries, add } = fixture(caseSensitive); add('/notes/A.md', 'original note');
    const result = await store.renameEntry('/notes/A.md', 'a.md');
    assert.equal(result.path, '/notes/a.md'); assert.equal(entries.get(result.path).data, 'original note');
  }
});
test('recovery migration distinguishes case-sensitive source files and folder prefixes', async () => {
  for (const directory of [false, true]) {
    const { store, add } = fixture();
    const from = directory ? '/notes/Folder' : '/notes/A.md', other = directory ? '/notes/folder/other.md' : '/notes/a.md';
    if (directory) { add(from); add('/notes/folder'); add(from + '/one.md', 'first note'); }
    else add(from, 'first note');
    add(other, 'other note');
    const parent = directory ? from : '/notes', recovery = parent + '/.reader/recovery';
    add(parent + '/.reader'); add(recovery);
    for (const [index, sourcePath] of [directory ? from + '/one.md' : from, other].entries()) {
      const record = makeRecovery(sourcePath, index);
      add(recovery + '/' + record.name, record.raw);
    }
    const changes = await store.recoveryMigrations(from, directory ? '/notes/Renamed' : '/notes/B.md', directory);
    assert.equal(changes.length, 1, 'another case-distinct note must keep its recovery identity');
    assert.equal(JSON.parse(changes[0].next).sourcePath, directory ? '/notes/Renamed/one.md' : '/notes/B.md');
  }
});
test('recovery migration retains old case aliases and drafts whose source file is already missing', async () => {
  const alias = fixture(false); alias.add('/notes/A.md', 'source'); alias.add('/notes/.reader'); alias.add('/notes/.reader/recovery');
  const old = makeRecovery('/NOTES/a.md'); alias.add('/notes/.reader/recovery/' + old.name, old.raw);
  const renamed = await alias.store.recoveryMigrations('/notes/A.md', '/notes/B.md', false);
  assert.equal(JSON.parse(renamed[0].next).sourcePath, '/notes/B.md');
  const missing = fixture(); missing.add('/notes/Folder'); missing.add('/notes/Folder/.reader'); missing.add('/notes/Folder/.reader/recovery');
  const draft = makeRecovery('/notes/Folder/deleted/note.md'); missing.add('/notes/Folder/.reader/recovery/' + draft.name, draft.raw);
  const moved = await missing.store.recoveryMigrations('/notes/Folder', '/notes/Renamed', true);
  assert.equal(JSON.parse(moved[0].next).sourcePath, '/notes/Renamed/deleted/note.md');
});
