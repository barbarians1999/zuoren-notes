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

test('single Markdown newlines stay visible in edit mode and preview mode', { timeout: 90000 }, async () => {
  smokeWorkspace = await createSmokeWorkspace('linebreak-smoke');
  fixtureRoot = smokeWorkspace.fixture; userData = smokeWorkspace.userData;
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, '单换行.md'), '第一行\n第二行\n第三行\n', 'utf8');

  const executablePath = process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const args = process.env.ZHAOYE_EXE ? [fixtureRoot] : [appRoot, fixtureRoot];
  application = await electron.launch({ executablePath, args, env: { ...process.env, ZHAOYE_TEST_USER_DATA: userData } });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector('.topbar');
  await page.locator('.file-row').filter({ hasText: '单换行.md' }).click();
  const editor = page.locator('.markdown-source-editor .cm-content');
  await editor.waitFor();
  const editState = await editor.evaluate(element => ({
    text: element.textContent,
    html: element.innerHTML,
    whiteSpace: getComputedStyle(element).whiteSpace,
    lines: [...element.querySelectorAll('.cm-line')].filter(item => item.textContent.trim()).map(item => ({ text: item.textContent, top: item.getBoundingClientRect().top })),
  }));
  assert.equal(editState.text.replace(/\s+/g, ''), '第一行第二行第三行', JSON.stringify(editState));
  assert.match(editState.whiteSpace, /^(pre-wrap|break-spaces)$/);
  assert.equal(editState.lines.length, 3, `editor lost a line: ${JSON.stringify(editState)}`);
  assert.ok(editState.lines[1].top - editState.lines[0].top > 5, `second line did not move down: ${JSON.stringify(editState)}`);
  assert.ok(editState.lines[2].top - editState.lines[1].top > 5, `third line did not move down: ${JSON.stringify(editState)}`);


  await page.getByRole('button', { name: '切换到预览' }).click();
  const preview = page.locator('.markdown-preview');
  await preview.waitFor();
  await page.waitForFunction(() => document.querySelector('.markdown-preview')?.textContent?.includes('第三行'));
  const previewState = await preview.evaluate(element => ({ text: element.textContent, html: element.innerHTML }));
  assert.equal(previewState.text.replace(/\s+/g, ''), '第一行第二行第三行');
  assert.match(previewState.html, /第一行.*<br>.*第二行.*<br>.*第三行/s);
});
