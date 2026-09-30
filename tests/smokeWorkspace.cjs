const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const temporaryRoot = path.resolve(os.tmpdir());
const allocatedRoots = new Set();

async function createSmokeWorkspace(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('Smoke workspace name must be a simple identifier.');
  const root = await fs.mkdtemp(path.join(temporaryRoot, `zuoren-${name}-`));
  allocatedRoots.add(root);
  return {
    root,
    fixture: path.join(root, 'fixture'),
    userData: path.join(root, 'user-data'),
    outputs: path.join(root, 'outputs'),
  };
}

async function cleanupSmokeWorkspace(workspace) {
  const root = path.resolve(workspace?.root || '');
  if (workspace?.cleaned === true && !allocatedRoots.has(root)) return;
  const relative = path.relative(temporaryRoot, root);
  if (!allocatedRoots.has(root) || !relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('zuoren-')) {
    throw new Error('Refusing to clean a smoke workspace that this process did not allocate.');
  }
  if (process.env.ZHAOYE_KEEP_SMOKE_ARTIFACTS === '1') {
    process.stderr.write(`[smoke-workspace] kept artifacts at ${root}\n`);
    allocatedRoots.delete(root);
    workspace.cleaned = true;
    return;
  }
  await fs.rm(root, { recursive: true, force: true });
  allocatedRoots.delete(root);
  workspace.cleaned = true;
}

module.exports = { createSmokeWorkspace, cleanupSmokeWorkspace };
