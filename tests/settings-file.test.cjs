const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readSettingsFile } = require('../electron/settings-file.cjs');

test('missing settings are empty, while valid settings remain untouched', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhaoye-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  assert.deepEqual(await readSettingsFile(file), { parsed: null, backup: null });
  await fs.writeFile(file, '{"recentFiles":["a.md"]}');
  assert.deepEqual(await readSettingsFile(file), { parsed: { recentFiles: ['a.md'] }, backup: null });
  assert.equal(await fs.readFile(file, 'utf8'), '{"recentFiles":["a.md"]}');
});

test('corrupt settings bytes are moved to a recoverable unique file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhaoye-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, '{"session":');
  const result = await readSettingsFile(file);
  assert.equal(result.parsed, null);
  assert.match(result.backup, /settings\.json\.corrupt-/);
  assert.equal(await fs.readFile(result.backup, 'utf8'), '{"session":');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.deepEqual(await readSettingsFile(file), { parsed: null, backup: null });
});

test('failed backup rejects reads so settings updates cannot overwrite the original', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhaoye-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, 'not json');
  await assert.rejects(readSettingsFile(file, {
    readFile: fs.readFile,
    rename: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  }), { code: 'EACCES' });
  assert.equal(await fs.readFile(file, 'utf8'), 'not json');
});
