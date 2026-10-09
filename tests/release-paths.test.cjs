const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { releaseDirectory } = require('../scripts/release-paths.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

test('release output follows package version and preserves exact explicit overrides', async () => {
  const workspace = await createSmokeWorkspace('release-paths');
  try {
    await fs.writeFile(path.join(workspace.root, 'package.json'), JSON.stringify({ version: '0.2.15', build: { directories: { output: 'releases' } } }));
    assert.equal(releaseDirectory(workspace.root), path.join(workspace.root, 'releases', '0.2.15'));
    assert.equal(releaseDirectory(workspace.root, workspace.outputs), workspace.outputs);
    await fs.writeFile(path.join(workspace.root, 'package.json'), JSON.stringify({ version: '0.2.16', build: { directories: { output: 'releases' } } }));
    assert.equal(releaseDirectory(workspace.root), path.join(workspace.root, 'releases', '0.2.16'));
  } finally { await cleanupSmokeWorkspace(workspace); }
});
