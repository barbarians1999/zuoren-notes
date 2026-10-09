// Isolated launch verification for the archived version, not the current source version.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('../tests/smokeWorkspace.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const current = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const release = path.resolve(root, current.build.directories.output, '0.2.23');
  const workspace = await createSmokeWorkspace('rollback-023');
  await fs.mkdir(workspace.userData, { recursive: true });
  const original = '{"session":';
  await fs.writeFile(path.join(workspace.userData, 'settings.json'), original);
  let application;
  try {
    application = await electron.launch({ executablePath: path.join(release, 'win-unpacked/ZuorenNotes.exe'), args: [],
      env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), '0.2.23');
    const page = await application.firstWindow();
    await page.getByText('设置文件损坏', { exact: false }).waitFor({ timeout: 12000 });
    const backup = (await fs.readdir(workspace.userData)).find(name => /^settings\.json\.corrupt-/.test(name));
    assert.ok(backup);
    assert.equal(await fs.readFile(path.join(workspace.userData, backup), 'utf8'), original);
    const file = path.join(release, 'VALIDATION.json');
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    report.rebuiltPackageStartup = { pass: true, version: '0.2.23', damagedSettingsBackupPreserved: true,
      isolatedProfile: true, verifiedAtUtc: new Date().toISOString(), fullRegressionRerun: false };
    await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.rebuiltPackageStartup, null, 2));
  } finally {
    const child = application?.process();
    if (application) try { await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch { /* already closed */ }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
