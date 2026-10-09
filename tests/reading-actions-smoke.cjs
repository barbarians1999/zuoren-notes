const { noteUI, focusNote, moreAction } = require('./noteUi.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const appRoot = path.resolve(__dirname, '..');
let application, workspace;
after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});

test('reading tasks use source transactions, isolated undo and guarded saves', { timeout: 90000 }, async t => {
  workspace = await createSmokeWorkspace('reading-tasks');
  await fs.mkdir(workspace.fixture, { recursive: true });
  const first = path.join(workspace.fixture, 'first.md'), second = path.join(workspace.fixture, 'second.md');
  const source = '# Tasks\r\n\r\n- [ ] first **task**\r\n- [x] second task\r\n  - [ ] nested task\r\n\r\n> 1. [ ] quoted task\r\n\r\n~~~md\r\n- [ ] code only\r\n~~~\r\n\r\n<input type="checkbox" data-task-position="3">\r\n';
  await fs.writeFile(first, '\ufeff' + source); await fs.writeFile(second, '- [ ] other file\n');
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  application = await _electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE ? [workspace.fixture] : [appRoot, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.file-row').filter({ hasText: 'first.md' }).click();
  const pane = noteUI(page, 'primary');
  await pane.locator('.cm-content').waitFor();
  await pane.getByRole('button', { name: '切换到预览', exact: true }).click();
  const preview = pane.locator('.markdown-preview:not(.preview-loading)');
  const tasks = preview.locator('input[data-task-nonce]');
  await tasks.first().waitFor();
  assert.equal(await tasks.count(), 4);
  assert.equal(await preview.locator('input:not([data-task-nonce])').isDisabled(), true, 'authored HTML is not a writable task');

  await t.test('click saves the exact task, preserves CRLF/BOM and supports preview undo/redo', async () => {
    await tasks.nth(0).click();
    await waitForFile(first, text => text.includes('- [x] first'));
    const saved = await fs.readFile(first, 'utf8');
    assert.equal(saved, '\ufeff' + source.replace('- [ ] first', '- [x] first'));
    await preview.press('Control+z');
    await waitForFile(first, text => text === '\ufeff' + source);
    await preview.press('Control+y');
    await waitForFile(first, text => text.includes('- [x] first'));
    await tasks.nth(2).click();
    await waitForFile(first, text => text.includes('  - [x] nested'));
    await preview.press('Control+z');
    await waitForFile(first, text => text.includes('  - [ ] nested') && text.includes('- [x] first'));
    assert.equal((await fs.readFile(first, 'utf8')).includes('data-zuoren-task'), false);
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'reading-tasks.png') });
  });
  await t.test('failed writes keep the edit and allow retry without losing history', async () => {
    await application.evaluate(() => {
      const { createRequire } = process.mainModule.require('node:module');
      const load = createRequire(process.mainModule.require('electron').app.getAppPath() + '/package.json');
      const { FileStore } = load('./electron/storage.cjs'), original = FileStore.prototype.saveNote;
      FileStore.prototype.saveNote = async function(input) { FileStore.prototype.saveNote = original; throw Error('injected task save failure'); };
    });
    await tasks.nth(1).click(); await preview.press('Control+s');
    await pane.locator('.markdown-save-state.state-保存失败').waitFor();
    assert.ok((await fs.readFile(first, 'utf8')).includes('- [x] second'));
    await pane.getByRole('button', { name: '立即保存', exact: true }).click();
    await waitForFile(first, text => text.includes('- [ ] second'));
    await preview.press('Control+z');
    await waitForFile(first, text => text.includes('- [x] second'));
  });
  await t.test('switching documents cannot reuse another task position or undo history', async () => {
    await page.locator('.file-row').filter({ hasText: 'second.md' }).click();
    await pane.locator('.cm-content').waitFor();
    await pane.getByRole('button', { name: '切换到预览', exact: true }).click();
    await preview.locator('input[data-task-nonce]').waitFor();
    await preview.locator('input[data-task-nonce]').click();
    await waitForFile(second, text => text === '- [x] other file\n');
    assert.ok((await fs.readFile(first, 'utf8')).includes('- [x] second'));
    await preview.press('Control+z'); await waitForFile(second, text => text === '- [ ] other file\n');
  });
  await t.test('external conflicts do not get overwritten by task edits', async () => {
    await fs.writeFile(second, '- [ ] disk version\n');
    await preview.locator('input[data-task-nonce]').click(); await preview.press('Control+s');
    await page.getByRole('button', { name: '使用磁盘内容', exact: true }).waitFor();
    assert.equal(await fs.readFile(second, 'utf8'), '- [ ] disk version\n');
    await preview.evaluate(element => element.querySelector('input').click());
    assert.equal(await fs.readFile(second, 'utf8'), '- [ ] disk version\n');
    await page.getByRole('button', { name: '使用磁盘内容', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.markdown-preview')?.textContent.includes('disk version'));
  });
  await t.test('old preview HTML cannot edit a newer source; keyboard Space toggles the refreshed task', async () => {
    await fs.writeFile(path.join(workspace.fixture, 'slow-preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4uoAAAAASUVORK5CYII=', 'base64'));
    await application.evaluate(() => {
      const { createRequire } = process.mainModule.require('node:module');
      const load = createRequire(process.mainModule.require('electron').app.getAppPath() + '/package.json');
      const { FileStore } = load('./electron/storage.cjs'), original = FileStore.prototype.checked;
      globalThis.__taskAssets = { hold: true, releases: [] };
      FileStore.prototype.checked = async function(file, options) {
        if (options?.asset && globalThis.__taskAssets.hold && /slow-preview/.test(file)) await new Promise(resolve => globalThis.__taskAssets.releases.push(resolve));
        return original.call(this, file, options);
      };
    });
    const delayed = '# Delayed\n\n- [ ] new task\n\n![image](slow-preview.png)\n';
    await fs.writeFile(second, delayed);
    await page.waitForFunction(() => document.querySelector('[data-pane-id="primary"] .cm-content')?.textContent.includes('new task'));
    assert.ok((await preview.textContent()).includes('disk version'), 'previous HTML remains while its replacement is pending');
    await preview.evaluate(element => element.querySelector('input').click());
    assert.equal(await fs.readFile(second, 'utf8'), delayed, 'a stale checkbox cannot submit an old source offset');
    await application.evaluate(() => { globalThis.__taskAssets.hold = false; for (const release of globalThis.__taskAssets.releases) release(); });
    await page.waitForFunction(() => document.querySelector('.markdown-preview')?.textContent.includes('new task'));
    await preview.locator('input[data-task-nonce]').press('Space');
    await waitForFile(second, text => text.includes('- [x] new task'));
  });
  assert.deepEqual(errors, []);
});
