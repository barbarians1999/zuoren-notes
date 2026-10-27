const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const markerName = '.zuoren-smoke-workspace.json';
const gib = 1024 ** 3;
const minDFree = 9 * gib; // Keep the reserved 8 GiB plus room for one test workspace.
const minFallbackFree = gib;
const maxWorkspaceBytes = 512 * 1024 ** 2;
const maxFailureBytes = 256 * 1024 ** 2;
const maxManagedBytes = gib;
const allocatedRoots = new Map();
let selectedRoot;

async function availableBytes(candidate, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  const volumeRoot = paths.parse(paths.resolve(candidate)).root;
  const volume = await fs.statfs(volumeRoot);
  return Number(volume.bavail) * Number(volume.bsize);
}

function selectSmokeTempRoot({ platform = process.platform, explicit, explicitFreeBytes = 0,
  dRoot = 'D:/C盘分担/左人笔记临时', dFreeBytes = 0, fallbackRoot = os.tmpdir(), fallbackFreeBytes = 0 }) {
  const paths = platform === 'win32' ? path.win32 : path;
  if (explicit) {
    const selected = paths.resolve(explicit);
    const volumeRoot = paths.parse(selected).root;
    const dVolumeRoot = path.win32.parse(path.win32.resolve(dRoot)).root;
    const reserve = platform === 'win32' && volumeRoot.toLowerCase() === dVolumeRoot.toLowerCase() ? minDFree : minFallbackFree;
    if (explicitFreeBytes < reserve) throw new Error('Selected test temp root is below its free-space reserve.');
    return selected;
  }
  if (platform === 'win32') {
    if (dFreeBytes < minDFree) throw new Error('D: must have at least 9 GiB free for note UI tests. Set ZUOREN_TEST_TEMP_ROOT explicitly to another volume with at least 1 GiB free; C: is not an automatic fallback.');
    return path.win32.resolve(dRoot);
  }
  if (fallbackFreeBytes < minFallbackFree) throw new Error('The system temporary volume must have at least 1 GiB free for note UI tests.');
  return paths.resolve(fallbackRoot);
}

async function prepareTempRoot(candidate, requiredFree) {
  if (await availableBytes(candidate) < requiredFree) throw new Error('Temporary root is below its free-space reserve.');
  await fs.mkdir(candidate, { recursive: true });
  const item = await fs.lstat(candidate);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('Temporary root is not a real directory.');
  const real = await fs.realpath(candidate);
  if (await availableBytes(real) < requiredFree) throw new Error('Temporary root is below its free-space reserve.');
  return real;
}

async function getSmokeTempRoot(environment = process.env) {
  if (selectedRoot) return selectedRoot;
  const explicit = environment.ZUOREN_TEST_TEMP_ROOT;
  if (explicit) {
    const free = await availableBytes(explicit);
    const target = selectSmokeTempRoot({ explicit, explicitFreeBytes: free });
    const volumeRoot = path.win32.parse(path.win32.resolve(target)).root;
    const required = process.platform === 'win32' && volumeRoot.toLowerCase() === path.win32.parse('D:/').root.toLowerCase() ? minDFree : minFallbackFree;
    return selectedRoot = await prepareTempRoot(target, required);
  }
  if (process.platform === 'win32') {
    const dRoot = 'D:/C盘分担/左人笔记临时';
    const dFreeBytes = await availableBytes('D:/').catch(() => 0);
    const target = selectSmokeTempRoot({ dRoot, dFreeBytes });
    return selectedRoot = await prepareTempRoot(target, minDFree);
  }
  const fallbackRoot = os.tmpdir();
  const target = selectSmokeTempRoot({ platform: process.platform, fallbackRoot, fallbackFreeBytes: await availableBytes(fallbackRoot) });
  return selectedRoot = await prepareTempRoot(target, minFallbackFree);
}

function directoryBytesSync(directory) {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fsSync.readdirSync(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const file = path.join(current, entry.name), stat = fsSync.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(file);
      else total += stat.size;
    }
  }
  return total;
}

async function directoryBytes(directory) {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      let stat;
      try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(file);
      else total += stat.size;
    }
  }
  return total;
}

async function managedBytes(root) {
  let total = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('zuoren-')) continue;
    const directory = path.join(root, entry.name);
    if (!fsSync.existsSync(path.join(directory, markerName))) continue;
    total += await directoryBytes(directory);
  }
  return total;
}

function assertManagedBudget(usedBytes) {
  if (usedBytes + maxWorkspaceBytes > maxManagedBytes) throw new Error('Managed smoke workspace budget reached (' + usedBytes + ' bytes). Inspect retained failure reproductions before retrying.');
}

async function trimDisposableData(root) {
  await fs.rm(path.join(root, 'outputs'), { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  const userData = path.join(root, 'user-data');
  if (!fsSync.existsSync(userData)) return;
  for (const entry of await fs.readdir(userData, { withFileTypes: true })) {
    if (entry.name === 'settings.json' || /^settings\.json\.corrupt-/.test(entry.name)) continue;
    await fs.rm(path.join(userData, entry.name), { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
}

async function preserveFailure(root, exitCode, name) {
  await trimDisposableData(root);
  let bytes = await directoryBytes(root), omitted = [];
  if (bytes > maxFailureBytes) {
    const files = [], pending = [root];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name), stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) pending.push(file);
        else if (path.basename(file) !== markerName && path.basename(file) !== 'SMOKE-FAILURE.json') files.push({ file, size: stat.size });
      }
    }
    const priority = file => {
      if (/^settings\.json(?:\.corrupt-.*)?$/.test(path.basename(file))) return 9;
      if (/\.(md|json|txt|html|xhtml)$/i.test(file)) return 5;
      if (/\.(pdf|epub)$/i.test(file)) return 3;
      return 1;
    };
    files.sort((a, b) => priority(a.file) - priority(b.file) || b.size - a.size);
    for (const item of files) {
      if (bytes <= maxFailureBytes) break;
      if (priority(item.file) >= 9) continue;
      await fs.rm(item.file, { force: true, maxRetries: 12, retryDelay: 150 });
      bytes -= item.size;
      omitted.push({ path: path.relative(root, item.file), bytes: item.size });
    }
  }
  const report = { state: 'failed', workspace: name, exitCode, retainedBytes: await directoryBytes(root), omitted };
  await fs.writeFile(path.join(root, 'SMOKE-FAILURE.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(root, markerName), JSON.stringify({ state: 'failed', workspace: name, exitCode }) + '\n');
  process.stderr.write('[smoke-workspace] minimal failure repro kept: ' + root + ' (' + report.retainedBytes + ' bytes)\n');
}

async function finalizeSmokeWorkspaces(base, runId, exitCode, keepArtifacts = false) {
  const root = await fs.realpath(base);
  let cleaned = 0, retained = 0, failed = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('zuoren-')) continue;
    const workspaceRoot = path.join(root, entry.name), markerPath = path.join(workspaceRoot, markerName);
    let marker;
    try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); } catch { continue; }
    if (!runId || marker.runId !== runId) continue;
    try {
      const bytes = await directoryBytes(workspaceRoot);
      if (exitCode === 0 && bytes <= maxWorkspaceBytes) {
        if (keepArtifacts) {
          await fs.writeFile(markerPath, JSON.stringify({ state: 'kept', workspace: marker.workspace, runId, finalizedAt: new Date().toISOString() }) + '\n');
          process.stderr.write('[smoke-workspace] kept artifacts at ' + workspaceRoot + '\n');
          retained++;
        } else {
          await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
          cleaned++;
        }
        continue;
      }
      if (exitCode === 0) failed++;
      await preserveFailure(workspaceRoot, exitCode || 1, marker.workspace || entry.name);
      const report = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'SMOKE-FAILURE.json'), 'utf8'));
      retained++;
      if (report.retainedBytes > maxFailureBytes) failed++;
    } catch (error) {
      failed++;
      const detail = { state: 'cleanup-failed', workspace: marker.workspace || entry.name, runId, exitCode: exitCode || 1,
        error: error.message, retainedBytes: await directoryBytes(workspaceRoot).catch(() => null) };
      await fs.writeFile(path.join(workspaceRoot, 'SMOKE-FAILURE.json'), JSON.stringify(detail, null, 2) + '\n').catch(() => {});
      await fs.writeFile(markerPath, JSON.stringify(detail) + '\n').catch(() => {});
      process.stderr.write('[smoke-workspace] cleanup failed; original workspace retained at ' + workspaceRoot + ': ' + error.message + '\n');
    }
  }
  return { cleaned, retained, failed };
}

async function createSmokeWorkspace(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('Smoke workspace name must be a simple identifier.');
  const base = await getSmokeTempRoot();
  const used = await managedBytes(base);
  assertManagedBudget(used);
  const root = await fs.mkdtemp(path.join(base, 'zuoren-' + name + '-'));
  const workspace = { root, name, fixture: path.join(root, 'fixture'), userData: path.join(root, 'user-data'), outputs: path.join(root, 'outputs'), cleaned: false, budgetExceeded: false };
  allocatedRoots.set(root, workspace);
  await fs.writeFile(path.join(root, markerName), JSON.stringify({ state: 'active', workspace: name, runId: process.env.ZUOREN_SMOKE_RUN_ID || null, pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
  return workspace;
}

async function cleanupSmokeWorkspace(workspace) {
  const root = path.resolve(workspace?.root || ''), base = await getSmokeTempRoot();
  const relative = path.relative(base, root), allocated = allocatedRoots.get(root);
  if (workspace?.cleaned && !allocated) return;
  if (!allocated || !relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('zuoren-')) {
    throw new Error('Refusing to clean a smoke workspace that this process did not allocate.');
  }
  if (workspace.cleaned) return;
  workspace.cleaned = true;
  const bytes = await directoryBytes(root);
  if (bytes > maxWorkspaceBytes) workspace.budgetExceeded = true;
  if (process.env.ZHAOYE_DEFER_SMOKE_CLEANUP === '1') {
    workspace.budgetExceeded = bytes > maxWorkspaceBytes;
    if (workspace.budgetExceeded) throw new Error('Smoke workspace exceeded ' + maxWorkspaceBytes + ' bytes; a bounded reproduction will be kept if this run fails.');
    return;
  }
  if (process.env.ZHAOYE_KEEP_SMOKE_ARTIFACTS === '1') {
    if (workspace.budgetExceeded) await preserveFailure(root, 1, workspace.name);
    else fsSync.writeFileSync(path.join(root, markerName), JSON.stringify({ state: 'kept', workspace: workspace.name }) + '\n');
    process.stderr.write('[smoke-workspace] kept artifacts at ' + root + '\n');
    allocatedRoots.delete(root); return;
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  allocatedRoots.delete(root);
  if (workspace.budgetExceeded) throw new Error('Smoke workspace exceeded ' + maxWorkspaceBytes + ' bytes and was removed.');
}

module.exports = { createSmokeWorkspace, cleanupSmokeWorkspace, finalizeSmokeWorkspaces, getSmokeTempRoot, selectSmokeTempRoot, assertManagedBudget, MAX_WORKSPACE_BYTES: maxWorkspaceBytes, MAX_MANAGED_BYTES: maxManagedBytes, directoryBytes };
