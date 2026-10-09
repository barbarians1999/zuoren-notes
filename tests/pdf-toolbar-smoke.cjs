const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { _electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const appRoot = path.resolve(__dirname, '..');
let workspace, application;

after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});

test('PDF single-row controls preserve tools, navigation and usable narrow reading panes', { timeout: 90000 }, async t => {
  workspace = await createSmokeWorkspace('pdf-toolbar');
  await fs.mkdir(workspace.fixture, { recursive: true });
  const filename = 'A-long-PDF-title-with-no-dedicated-heading-row.pdf';
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 4; n++) pdf.addPage([595, 842]).drawText(`Toolbar audit page ${n}`, { font, size: 22, x: 72, y: 750 });
  await fs.writeFile(path.join(workspace.fixture, filename), await pdf.save());
  await fs.writeFile(path.join(workspace.fixture, 'note.md'), '# Note\n\nKeep this note intact.\n');
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  application = await _electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE ? [workspace.fixture] : [appRoot, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const layout = name => page.locator('.layout-tabs').getByRole('button', { name, exact: true });
  await page.locator('.file-row').filter({ hasText: filename }).click();
  await layout('阅读').click();
  await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] canvas')?.width > 0);
  const bar = page.locator('.pdf-navigation'), tools = bar.locator('.pdf-tools');
  const output = process.env.ZUOREN_SCREENSHOT_OUTPUT || workspace.outputs;
  await fs.mkdir(output, { recursive: true });
  const sameRow = async () => {
    // Fullscreen reveals the reader chrome with a short slide transition. The
    // visibility flag changes at the start of that transition, so wait for the
    // toolbar itself to settle before asserting its final geometry.
    await bar.evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    const bounds = await bar.boundingBox(), toolBounds = await tools.boundingBox();
    assert.ok(bounds && toolBounds && bounds.height === 40 && toolBounds.y >= bounds.y && toolBounds.y + toolBounds.height <= bounds.y + bounds.height,
      'toolbar tools must remain within the compact row: ' + JSON.stringify({ bounds, toolBounds }));
    assert.equal(await page.locator('.pdf-pane > .pdf-tools, .reader-document-title').count(), 0);
    assert.equal(await bar.count(), 1);
  };
  await t.test('book name is a tooltip; marking tools directly share the page and zoom row', async () => {
    await sameRow();
    assert.equal(await bar.getAttribute('title'), filename);
    assert.ok((await bar.getByRole('button', { name: '展开 PDF 目录', exact: true }).getAttribute('title')).includes(filename));
    for (const name of ['文字高亮', '框选', '批注', '选择']) {
      const button = tools.getByRole('button', { name, exact: true });
      await button.click(); assert.equal(await button.getAttribute('aria-pressed'), 'true');
      assert.equal(await tools.locator('[aria-pressed="true"]').count(), 1);
    }
    await bar.getByRole('button', { name: '展开 PDF 目录', exact: true }).click();
    await page.locator('.pdf-outline').waitFor();
    await bar.getByRole('button', { name: '收起 PDF 目录', exact: true }).click();
    await page.locator('.pdf-outline').waitFor({ state: 'hidden' });
    const number = bar.getByRole('textbox', { name: '当前页码', exact: true });
    await number.fill('2'); await number.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-pdf-page="2"] canvas')?.width > 0);
    await bar.getByRole('button', { name: '放大', exact: true }).click();
    await page.waitForTimeout(250); assert.equal(await number.inputValue(), '2');
    await bar.getByRole('button', { name: '在 PDF 中查找', exact: true }).click();
    await page.getByRole('textbox', { name: 'PDF 查找文本', exact: true }).fill('Toolbar');
    await page.getByRole('button', { name: '关闭 PDF 查找', exact: true }).click();
    await sameRow(); await page.screenshot({ path: path.join(output, 'pdf-toolbar-wide.png') });
  });
  await t.test('split and narrow panes retain one row with reachable labeled icons', async () => {
    await page.locator('.file-row').filter({ hasText: 'note.md' }).dblclick();
    await layout('对照').click();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
    await page.waitForTimeout(250);
    await sameRow();
    assert.equal(await tools.getByRole('button', { name: '文字高亮', exact: true }).locator('span').isVisible(), false);
    for (const name of ['展开 PDF 目录', '上一页', '下一页', '选择', '文字高亮', '框选', '批注', '在 PDF 中查找', '缩小', '放大', '进入全屏阅读']) {
      const button = bar.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const rect = await button.boundingBox(), bounds = await bar.boundingBox();
      assert.ok(rect && bounds && rect.x >= bounds.x - 1 && rect.x + rect.width <= bounds.x + bounds.width + 1, name);
    }
    await tools.getByRole('button', { name: '文字高亮', exact: true }).click();
    assert.equal(await tools.getByRole('button', { name: '文字高亮', exact: true }).getAttribute('aria-pressed'), 'true');
    await bar.evaluate(el => { el.scrollLeft = 0; });
    await page.screenshot({ path: path.join(output, 'pdf-toolbar-split-narrow.png') });
    assert.equal(await page.locator('.cm-content').count(), 1);
  });
  await t.test('dark reading and fullscreen preserve the merged tools', async () => {
    await layout('阅读').click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await sameRow(); await page.screenshot({ path: path.join(output, 'pdf-toolbar-dark.png') });
    // Native fullscreen events may arrive before the IPC reply. A delayed
    // snapshot must not overwrite the newer event-driven window state.
    await application.evaluate(({ ipcMain, BrowserWindow }) => {
      const original = ipcMain._invokeHandlers.get('window-control');
      globalThis.__fullscreenReplyCount = 0;
      ipcMain.removeHandler('window-control');
      ipcMain.handle('window-control', async (event, action) => {
        if (action !== 'fullscreen') return original(event, action);
        const win = BrowserWindow.fromWebContents(event.sender);
        const before = { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
        await original(event, action);
        for (let i = 0; i < 100 && win.isFullScreen() === before.fullscreen; i++) await new Promise(resolve => setTimeout(resolve, 10));
        win.webContents.send('window-state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
        await new Promise(resolve => setTimeout(resolve, 100));
        globalThis.__fullscreenReplyCount++;
        return before;
      });
    });
    await bar.getByRole('button', { name: '进入全屏阅读', exact: true }).click();
    assert.equal(await application.evaluate(async ({ BrowserWindow }) => {
      for (let i = 0; i < 200 && globalThis.__fullscreenReplyCount < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
      return BrowserWindow.getAllWindows()[0].isFullScreen();
    }), true);
    await page.waitForTimeout(100);
    assert.equal(await bar.locator('.zoom-control button:last-child').getAttribute('aria-label'), '退出全屏阅读', 'late fullscreen reply must not restore an old label');
    await page.mouse.move(400, 2);
    await page.waitForFunction(() => document.querySelector('.app').dataset.chromeVisible === 'true');
    await sameRow();
    await bar.getByRole('button', { name: '退出全屏阅读', exact: true }).click();
    assert.equal(await application.evaluate(async ({ BrowserWindow }) => {
      for (let i = 0; i < 200 && globalThis.__fullscreenReplyCount < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
      return BrowserWindow.getAllWindows()[0].isFullScreen();
    }), false);
    await page.waitForTimeout(100);
    assert.equal(await bar.locator('.zoom-control button:last-child').getAttribute('aria-label'), '进入全屏阅读');
  });
  assert.equal(await fs.readFile(path.join(workspace.fixture, 'note.md'), 'utf8'), '# Note\n\nKeep this note intact.\n');
  assert.deepEqual(errors, []);
});
