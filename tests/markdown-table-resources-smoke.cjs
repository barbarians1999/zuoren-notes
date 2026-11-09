const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');

const root = path.resolve(__dirname, '..');
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a82kAAAAASUVORK5CYII=', 'base64');
const source = ['# 表格资源', '', '| 图片 | 跳转 |', '| --- | --- |',
  '| ![本地图](<./中文😀 a.png>) | [本地😀](<./linked file.md>) |',
  '| ![引用图][pic] | [网页][web] |', '| 中😀文 | 普通单元格 |', '',
  '[pic]: ./a%2520b.png', '[web]: https://example.test/table?a=1&b=2', ''].join('\n');

test('table images and modifier links match reading mode without changing UTF-16 editing, undo or saved bytes', { timeout: 90000 }, async t => {
  const workspace = await createSmokeWorkspace('markdown-table-resources'); let app;
  const note = path.join(workspace.fixture, 'table-resources.md'), linked = path.join(workspace.fixture, 'linked file.md');
  const imagePaths = [path.join(workspace.fixture, '中文😀 a.png'), path.join(workspace.fixture, 'a%20b.png')];
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    await fs.writeFile(note, source); await fs.writeFile(linked, '# Linked');
    for (const file of imagePaths) await fs.writeFile(file, tinyPng);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ ipcMain, shell }) => {
      const asset = ipcMain._invokeHandlers.get('asset-url'), openPath = shell.openPath.bind(shell), openExternal = shell.openExternal.bind(shell);
      globalThis.__tableResourcesAudit = { assets: [], paths: [], external: [] };
      ipcMain.removeHandler('asset-url'); ipcMain.handle('asset-url', (event, file) => {
        globalThis.__tableResourcesAudit.assets.push(file); return asset(event, file);
      });
      Object.defineProperty(shell, 'openPath', { configurable: true, value: async file => { globalThis.__tableResourcesAudit.paths.push(file); return ''; } });
      Object.defineProperty(shell, 'openExternal', { configurable: true, value: async url => { globalThis.__tableResourcesAudit.external.push(url); } });
      globalThis.__restoreTableResources = () => {
        ipcMain.removeHandler('asset-url'); ipcMain.handle('asset-url', asset);
        Object.defineProperty(shell, 'openPath', { configurable: true, value: openPath });
        Object.defineProperty(shell, 'openExternal', { configurable: true, value: openExternal });
      };
    });
    const row = page.locator('.file-row').filter({ hasText: 'table-resources.md' }); await row.dblclick();
    const editor = page.locator('[data-note-group="primary"] .cm-content'); await editor.waitFor();
    const home = () => editor.evaluate(element => {
      const view = element.cmTile.root.view; view.dispatch({ selection: { anchor: 0 } }); view.focus();
    });
    const table = editor.locator('.cm-md-table');
    const waitForImages = async selector => {
      await page.waitForFunction(selector => {
        const images = [...document.querySelectorAll(selector + ' img')];
        return images.length === 2 && images.every(image => image.naturalWidth === 1 && image.getAttribute('src')?.startsWith('reader-asset://local/'));
      }, selector);
    };
    const waitForOpens = async (paths, external) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const audit = await app.evaluate(() => globalThis.__tableResourcesAudit);
        if (audit.paths.length === paths && audit.external.length === external) return audit;
        await page.waitForTimeout(25);
      }
      throw Error('Unexpected table open calls: ' + JSON.stringify(await app.evaluate(() => globalThis.__tableResourcesAudit)));
    };
    await home(); await table.waitFor();
    await t.test('local and reference images load through checked asset IPC', async () => {
      await waitForImages('.cm-md-table');
      const audit = await app.evaluate(() => globalThis.__tableResourcesAudit);
      for (const file of imagePaths) assert.ok(audit.assets.includes(file), file);
      assert.equal(await fs.readFile(note, 'utf8'), source);
    });
    await t.test('Ctrl and Cmd clicks open once without activating the table source', async () => {
      const local = table.locator('a').filter({ hasText: '本地😀' }), web = table.locator('a').filter({ hasText: '网页' });
      assert.equal(await local.getAttribute('data-markdown-link'), './linked%20file.md');
      assert.equal(await web.getAttribute('data-markdown-link'), 'https://example.test/table?a=1&b=2');
      await local.click({ modifiers: ['Control'] }); await web.click({ modifiers: ['Meta'] });
      const audit = await waitForOpens(1, 1);
      assert.deepEqual(audit.paths, [linked]); assert.deepEqual(audit.external, ['https://example.test/table?a=1&b=2']);
      await table.waitFor();
      assert.equal(await editor.evaluate(element => element.cmTile.root.view.state.selection.main.head), 0);
      assert.equal(await fs.readFile(note, 'utf8'), source);
    });
    await t.test('reading mode uses the same image files and link destinations', async () => {
      await page.getByRole('button', { name: '切换到预览', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.markdown-preview')?.dataset.previewCurrent === 'true');
      await waitForImages('.markdown-preview');
      const preview = page.locator('.markdown-preview');
      await preview.locator('a').filter({ hasText: '本地😀' }).click({ modifiers: ['Control'] });
      await preview.locator('a').filter({ hasText: '网页' }).click({ modifiers: ['Meta'] });
      const audit = await waitForOpens(2, 2);
      assert.deepEqual(audit.paths, [linked, linked]);
      assert.deepEqual(audit.external, ['https://example.test/table?a=1&b=2', 'https://example.test/table?a=1&b=2']);
      await page.getByRole('button', { name: '切换到源码编辑', exact: true }).click(); await home();
      await waitForImages('.cm-md-table');
    });
    await t.test('ordinary cell clicks preserve UTF-16 position, one-step undo, save and reopen', async () => {
      const cell = table.locator('td').filter({ hasText: /^中😀文$/ }); await cell.scrollIntoViewIfNeeded();
      const point = await cell.evaluate(element => {
        const range = document.createRange(); range.setStart(element.firstChild, 3); range.setEnd(element.firstChild, 4);
        const rect = range.getBoundingClientRect(); return { x: rect.left + 1, y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(point.x, point.y); await table.waitFor({ state: 'detached' });
      const offset = source.indexOf('中😀文') + 3;
      assert.equal(await editor.evaluate(element => element.cmTile.root.view.state.selection.main.head), offset);
      await page.keyboard.insertText('!');
      await waitForFile(note, text => text === source.slice(0, offset) + '!' + source.slice(offset));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      await waitForFile(note, text => text === source); await home(); await waitForImages('.cm-md-table');
      const tab = page.getByRole('tab', { name: /table-resources\.md/ });
      await tab.locator('..').getByRole('button', { name: '关闭 table-resources.md' }).click(); await tab.waitFor({ state: 'detached' });
      await row.dblclick(); await editor.waitFor(); await home(); await waitForImages('.cm-md-table');
      assert.equal(await fs.readFile(note, 'utf8'), source);
    });
    assert.deepEqual(errors, []);
  } finally {
    if (app) { try { await app.evaluate(() => globalThis.__restoreTableResources?.()); } finally { await app.close(); } }
    await cleanupSmokeWorkspace(workspace);
  }
});
