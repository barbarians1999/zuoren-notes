const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('./electronHarness.cjs');

test('damaged settings are backed up and visibly reported at startup', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhaoye-settings-ui-'));
  const userData = path.join(root, 'profile');
  await fs.mkdir(userData);
  const original = '{"session":';
  await fs.writeFile(path.join(userData, 'settings.json'), original);
  let application;
  try {
    const appRoot = path.resolve(__dirname, '..');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    application = await electron.launch({
      executablePath: packaged || path.join(appRoot, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [] : [appRoot],
      env: { ...process.env, ZHAOYE_TEST_USER_DATA: userData },
    });
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), !!packaged);
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    const page = await application.firstWindow();
    await page.getByText('设置文件损坏', { exact: false }).waitFor({ timeout: 12000 });
    const backup = (await fs.readdir(userData)).find(name => /^settings\.json\.corrupt-/.test(name));
    assert.ok(backup);
    assert.equal(await fs.readFile(path.join(userData, backup), 'utf8'), original);
  } finally {
    const child = application?.process();
    if (application) {
      try { await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch { /* already closed */ }
    }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await fs.rm(root, { recursive: true, force: true });
  }
});
