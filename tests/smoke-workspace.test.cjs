const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSmokeWorkspace, cleanupSmokeWorkspace, finalizeSmokeWorkspaces, selectSmokeTempRoot, assertManagedBudget, directoryBytes, MAX_WORKSPACE_BYTES, MAX_MANAGED_BYTES } = require('./smokeWorkspace.cjs');

test('workspace sizing tolerates an application lockfile disappearing between directory read and stat', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-size-race-'));
  const file = path.join(root, 'lockfile'); await fs.writeFile(file, 'x');
  const stat = fs.lstat;
  try {
    fs.lstat = async target => { if (target === file) { await fs.unlink(file); } return stat(target); };
    assert.equal(await directoryBytes(root), 0);
  } finally { fs.lstat = stat; await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows UI tests stop when D: is below reserve unless another root is explicitly selected', () => {
  const gib = 1024 ** 3, dRoot = 'D:/C盘分担/左人笔记临时';
  assert.throws(() => selectSmokeTempRoot({ platform: 'win32', dRoot, dFreeBytes: 0 }), /D: must have at least 9 GiB/);
  assert.throws(() => selectSmokeTempRoot({ platform: 'win32', dRoot, dFreeBytes: 9 * gib - 1 }), /D: must have at least 9 GiB/);
  assert.equal(selectSmokeTempRoot({ platform: 'win32', dRoot, dFreeBytes: 9 * gib }), path.win32.resolve(dRoot));
  assert.throws(() => selectSmokeTempRoot({ platform: 'win32', explicit: 'C:/temp/notes', explicitFreeBytes: gib - 1 }), /below its free-space reserve/);
  assert.equal(selectSmokeTempRoot({ platform: 'win32', explicit: 'C:/temp/notes', explicitFreeBytes: gib, dRoot, dFreeBytes: 0 }), path.win32.resolve('C:/temp/notes'));
  assert.throws(() => selectSmokeTempRoot({ platform: 'win32', explicit: dRoot, explicitFreeBytes: 9 * gib - 1 }), /below its free-space reserve/);
});

test('managed smoke storage reserves one workspace and rejects growth beyond its cap', () => {
  assert.doesNotThrow(() => assertManagedBudget(0));
  assert.throws(() => assertManagedBudget(MAX_MANAGED_BYTES - MAX_WORKSPACE_BYTES + 1), /budget reached/);
  assert.equal(MAX_WORKSPACE_BYTES * 2, MAX_MANAGED_BYTES);
});

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

test('UI workspaces clean on success and retain only bounded fixtures on failure', async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-workspace-exit-')));
  const helper = JSON.stringify(path.join(__dirname, 'smokeWorkspace.cjs'));
  const child = (name, exitCode) => `
    const fs=require('node:fs/promises');
    const path=require('node:path');
    const {createSmokeWorkspace,cleanupSmokeWorkspace}=require(${helper});
    (async()=>{
      const workspace=await createSmokeWorkspace(${JSON.stringify(name)});
      await fs.mkdir(workspace.fixture,{recursive:true});
      await fs.mkdir(path.join(workspace.userData,'Cache'),{recursive:true});
      await fs.mkdir(workspace.outputs,{recursive:true});
      await fs.writeFile(path.join(workspace.fixture,'repro.md'),'small synthetic repro');
      await fs.writeFile(path.join(workspace.userData,'settings.json'),'{}');
      await fs.writeFile(path.join(workspace.userData,'Cache','discard.bin'),'temporary cache');
      await fs.writeFile(path.join(workspace.outputs,'discard.png'),'temporary screenshot');
      await fs.writeFile(path.join(process.env.ZUOREN_TEST_TEMP_ROOT,${JSON.stringify(name + '-root.txt')}),workspace.root);
      await cleanupSmokeWorkspace(workspace);
      await fs.access(path.join(workspace.userData,'Cache'));
      await fs.access(workspace.outputs);
      process.exitCode=${exitCode};
    })().catch(error=>{console.error(error);process.exitCode=2;});
  `;
  const run = (name, exitCode) => {
    const runId = name + '-' + process.pid;
    const result = spawnSync(process.execPath, ['-e', child(name, exitCode)], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, ZUOREN_TEST_TEMP_ROOT: base, ZHAOYE_DEFER_SMOKE_CLEANUP: '1', ZHAOYE_KEEP_SMOKE_ARTIFACTS: '0', ZUOREN_SMOKE_RUN_ID: runId },
    });
    return { result, runId };
  };
  try {
    const passed = run('passed-workspace', 0);
    assert.equal(passed.result.status, 0, passed.result.stderr);
    assert.deepEqual(await finalizeSmokeWorkspaces(base, passed.runId, passed.result.status), { cleaned: 1, retained: 0, failed: 0 });
    const passedRoot = (await fs.readFile(path.join(base, 'passed-workspace-root.txt'), 'utf8')).trim();
    await assert.rejects(fs.access(passedRoot));

    const failed = run('failed-workspace', 1);
    assert.equal(failed.result.status, 1, failed.result.stderr);
    assert.deepEqual(await finalizeSmokeWorkspaces(base, failed.runId, failed.result.status), { cleaned: 0, retained: 1, failed: 0 });
    const failedRoot = (await fs.readFile(path.join(base, 'failed-workspace-root.txt'), 'utf8')).trim();
    assert.equal(await fs.readFile(path.join(failedRoot, 'fixture', 'repro.md'), 'utf8'), 'small synthetic repro');
    assert.equal(await fs.readFile(path.join(failedRoot, 'user-data', 'settings.json'), 'utf8'), '{}');
    await assert.rejects(fs.access(path.join(failedRoot, 'user-data', 'Cache')));
    await assert.rejects(fs.access(path.join(failedRoot, 'outputs')));
    const report = JSON.parse(await fs.readFile(path.join(failedRoot, 'SMOKE-FAILURE.json'), 'utf8'));
    assert.equal(report.state, 'failed'); assert.equal(report.exitCode, 1);
    assert.ok(report.retainedBytes <= require('./smokeWorkspace.cjs').MAX_WORKSPACE_BYTES);
  } finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});

test('node:test failures preserve their synthetic fixture after cleanup hooks run', async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-workspace-node-test-')));
  const helper = JSON.stringify(path.join(__dirname, 'smokeWorkspace.cjs'));
  const testFile = path.join(base, 'failure.test.cjs');
  const source = [
    "const {test}=require('node:test');",
    "const fs=require('node:fs/promises');",
    "const path=require('node:path');",
    "const {createSmokeWorkspace,cleanupSmokeWorkspace}=require(" + helper + ");",
    "test('injected failure',async()=>{",
    "const workspace=await createSmokeWorkspace('node-test-failure');",
    "await fs.mkdir(workspace.fixture,{recursive:true});",
    "await fs.writeFile(path.join(workspace.fixture,'repro.md'),'minimal failure fixture');",
    "await fs.writeFile(path.join(process.env.ZUOREN_TEST_TEMP_ROOT,'node-test-failure-root.txt'),workspace.root);",
    "await cleanupSmokeWorkspace(workspace);",
    "throw Error('intentional workspace cleanup test failure');",
    "});",
  ].join('\n');
  try {
    await fs.writeFile(testFile, source);
    const runId = 'node-test-' + process.pid;
    const childEnv = { ...process.env, ZUOREN_TEST_TEMP_ROOT: base, TMP: base, TEMP: base,
      ZHAOYE_DEFER_SMOKE_CLEANUP: '1', ZHAOYE_KEEP_SMOKE_ARTIFACTS: '0', ZUOREN_SMOKE_RUN_ID: runId };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: childEnv,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(await finalizeSmokeWorkspaces(base, runId, result.status), { cleaned: 0, retained: 1, failed: 0 });
    const root = (await fs.readFile(path.join(base, 'node-test-failure-root.txt'), 'utf8')).trim();
    assert.equal(await fs.readFile(path.join(root, 'fixture', 'repro.md'), 'utf8'), 'minimal failure fixture');
    const failure = JSON.parse(await fs.readFile(path.join(root, 'SMOKE-FAILURE.json'), 'utf8'));
    assert.equal(failure.exitCode, 1);
    assert.ok(failure.retainedBytes <= require('./smokeWorkspace.cjs').MAX_WORKSPACE_BYTES);
  } finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});
