const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

test('settings about shows the running version and opens the GitHub repository externally', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('about');
  const root = path.resolve(__dirname, '..');
  const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
  let application;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    application = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await application.firstWindow();
    await page.locator('.app[data-session-ready="true"]').waitFor();
    const info = await application.evaluate(({ app, shell }) => {
      globalThis.__aboutOpened = [];
      shell.openExternal = async url => { globalThis.__aboutOpened.push(url); };
      return { name: app.getName(), version: app.getVersion() };
    });
    assert.equal(info.version, require('../package.json').version);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '阅读设置' });
    await settings.getByText('关于', { exact: true }).click();
    await settings.getByText(info.name, { exact: true }).waitFor();
    await settings.getByText(`版本 ${info.version}`, { exact: true }).waitFor();
    await settings.getByRole('link', { name: 'GitHub 仓库' }).click();
    await page.waitForFunction(() => document.querySelector('.settings-about[open]'));
    let opened = [];
    for (let attempt = 0; attempt < 40 && !opened.length; attempt++) {
      opened = await application.evaluate(() => globalThis.__aboutOpened);
      if (!opened.length) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(opened, ['https://github.com/barbarians1999/zuoren-notes']);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    const fontSize = settings.getByRole('slider', { name: '正文字体大小' });
    await fontSize.fill('19');
    assert.equal(await fontSize.inputValue(), '19');
    await settings.getByRole('button', { name: '恢复默认 18px' }).click();
    assert.equal(await fontSize.inputValue(), '18');
  } finally {
    if (application) await application.close();
    await cleanupSmokeWorkspace(workspace);
  }
});
