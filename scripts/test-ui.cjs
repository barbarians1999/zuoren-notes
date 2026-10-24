const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { acquireUiLock } = require('./native-ui-lock.cjs');
const { testPlan, groups } = require('./verification-plan.cjs');
const { getSmokeTempRoot, finalizeSmokeWorkspaces } = require('../tests/smokeWorkspace.cjs');
async function runUiTests(files, { root = path.resolve(__dirname, '..'), env = process.env, stdio = 'inherit' } = {}) {
  const lock = await acquireUiLock({ onWait: () => console.error('[native-ui] waiting for the shared desktop; no test timeout has started') });
  try {
    const tempRoot = await getSmokeTempRoot(env);
    console.log('[native-ui] managed temporary workspace: ' + tempRoot);
    const runId = randomUUID();
    let exitCode = 1;
    try {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], {
          cwd: root, stdio, windowsHide: true, env: { ...env, TMP: tempRoot, TEMP: tempRoot, TMPDIR: tempRoot,
            ZUOREN_TEST_TEMP_ROOT: tempRoot, ZHAOYE_DEFER_SMOKE_CLEANUP: '1', ZUOREN_SMOKE_RUN_ID: runId, ZUOREN_UI_LOCK_TOKEN: lock.token },
        });
        child.once('error', reject); child.once('close', code => resolve(code ?? 1));
      });
    } finally {
      const cleanup = await finalizeSmokeWorkspaces(tempRoot, runId, exitCode,
        env.ZHAOYE_KEEP_SMOKE_ARTIFACTS === '1');
      if (cleanup.failed) exitCode = exitCode || 1;
    }
    return exitCode;
  } finally { await lock.release(); }
}
async function main() {
  const args = process.argv.slice(2), root = path.resolve(__dirname, '..');
  let files;
  if (args[0] === '--group') files = groups[args[1]];
  else if (args[0] === '--files') files = args.slice(1);
  else if (args[0] === '--profile') files = testPlan(root, args[1], process.env.ZUOREN_VERIFICATION_PLAN)[args[2] || 'source'];
  if (!Array.isArray(files) || !files.length || files.some(file => !/^tests\/[\w-]+-smoke\.cjs$/.test(file))) throw Error('Use --group editor|readers|workspace, --files tests/NAME-smoke.cjs, or --profile NAME source|packaged');
  for (const file of files) await fs.access(path.join(root, file));
  process.exitCode = await runUiTests(files);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runUiTests };
