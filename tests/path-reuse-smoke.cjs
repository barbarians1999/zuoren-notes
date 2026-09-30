const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

const appRoot = path.resolve(__dirname, '..');
let smokeWorkspace;
let fixtureRoot;
let userData;
let application;

after(async () => {
  const process = application?.process();
  const pid = process?.pid;
  try { if (application) await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 8000))]); } catch { /* already closed */ }
  if (pid && process?.exitCode === null) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  if (smokeWorkspace) await cleanupSmokeWorkspace(smokeWorkspace);
});

test('a deleted Markdown path can be recreated and autosaved', { timeout: 90000 }, async () => {
  smokeWorkspace = await createSmokeWorkspace('path-reuse-smoke');
  fixtureRoot = smokeWorkspace.fixture; userData = smokeWorkspace.userData;
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  const notePath = path.join(fixtureRoot, '可重用.md');
  await fs.writeFile(notePath, '# 旧内容\n', 'utf8');

  const executablePath = process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const args = process.env.ZHAOYE_EXE ? [fixtureRoot] : [appRoot, fixtureRoot];
  application = await electron.launch({ executablePath, args, env: { ...process.env, ZHAOYE_TEST_USER_DATA: userData } });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector('.topbar');
  await page.locator('.file-row').filter({ hasText: '可重用.md' }).click();
  const deletionDialog = new Promise(resolve => page.once('dialog', async dialog => { await dialog.accept(); resolve(); }));
  await page.locator('.file-row').filter({ hasText: '可重用.md' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移到回收站' }).click();
  await deletionDialog;
  await page.locator('.file-row').filter({ hasText: '可重用.md' }).waitFor({ state: 'detached' });
  await assert.rejects(fs.access(notePath));

  await page.getByRole('button', { name: '新笔记', exact: true }).click();
  await page.getByLabel('新笔记名称').fill('可重用.md');
  await page.getByLabel('新笔记名称').press('Enter');
  await page.locator('.document-tab').filter({ hasText: '可重用.md' }).waitFor();
  const editor = page.locator('.markdown-source-editor .cm-content');
  await editor.waitFor();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('路径重用后仍能保存');
  const deadline = Date.now() + 8000;
  let content = '';
  while (Date.now() < deadline) {
    content = await fs.readFile(notePath, 'utf8');
    if (content.includes('路径重用后仍能保存')) break;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  assert.match(content, /路径重用后仍能保存/);
});
