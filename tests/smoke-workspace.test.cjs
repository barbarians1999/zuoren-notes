const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

test('smoke workspaces are unique and cleanup cannot reach outside allocated roots', async () => {
  const first = await createSmokeWorkspace('safety-test');
  const second = await createSmokeWorkspace('safety-test');
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-sentinel-'));
  const externalSentinel = path.join(externalRoot, 'keep.txt');
  await fs.writeFile(externalSentinel, 'preserve');
  try {
    assert.notEqual(first.root, second.root);
    assert.equal(path.dirname(first.outputs), first.root);
    assert.equal(path.dirname(second.outputs), second.root);
    await fs.mkdir(first.fixture); await fs.mkdir(second.fixture);
    await fs.writeFile(path.join(first.fixture, 'first.txt'), 'first');
    await fs.writeFile(path.join(second.fixture, 'second.txt'), 'second');
    await assert.rejects(cleanupSmokeWorkspace({ root: externalRoot }), /Refusing to clean/);
    await cleanupSmokeWorkspace(first);
    await assert.rejects(fs.access(first.root));
    assert.equal(await fs.readFile(path.join(second.fixture, 'second.txt'), 'utf8'), 'second');
    assert.equal(await fs.readFile(externalSentinel, 'utf8'), 'preserve');
  } finally {
    await cleanupSmokeWorkspace(first);
    await cleanupSmokeWorkspace(second);
    await fs.rm(externalRoot, { recursive: true, force: true });
  }
});
