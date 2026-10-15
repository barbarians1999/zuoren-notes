const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const root = path.resolve(__dirname, '..');

test('shared chrome preserves focus, async failures and confirmed copy feedback', { timeout: 90000 }, async t => {
  const workspace = await createSmokeWorkspace('chrome-interaction'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const original = '# Reading notes\n\nPreserve the editor and its undo history.\n';
    for (const name of ['a.md', 'b.md']) await fs.writeFile(path.join(workspace.fixture, name), original);
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([440, 300]).drawText('Confirmed clipboard feedback', { font, size: 18, x: 32, y: 250 });
    const pdfBytes = Buffer.from(await pdf.save()); await fs.writeFile(path.join(workspace.fixture, 'paper.pdf'), pdfBytes);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    const screenshots = process.env.ZUOREN_SCREENSHOT_OUTPUT;
    if (screenshots) await fs.mkdir(screenshots, { recursive: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.bringToFront();
    const row = name => page.locator('.file-row').filter({ has: page.getByText(name, { exact: true }) });
    await row('a.md').dblclick(); await row('b.md').dblclick();
    await page.locator('.cm-content').waitFor();
    const composingEscape = () => page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));

    await t.test('menus, tabs and settings keep keyboard focus and ignore composing Escape', async () => {
      await row('b.md').click({ button: 'right' });
      const menu = page.getByRole('menu', { name: '文件操作' }); await menu.waitFor();
      if (screenshots) await page.screenshot({ path: path.join(screenshots, 'chrome-file-menu.png') });
      await page.keyboard.press('End'); assert.match(await page.locator(':focus').innerText(), /移到回收站/);
      await page.keyboard.press('Home'); assert.equal(await page.locator(':focus').innerText(), '打开所在路径');
      await composingEscape(); assert.equal(await menu.isVisible(), true);
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
      assert.equal(await row('b.md').evaluate(el => document.activeElement === el), true);
      const a = page.getByRole('tab', { name: 'a.md', exact: true }); await a.click(); await a.focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('[role="tab"]:focus').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('[role="tab"]:focus').innerText(), 'b.md');
      await page.keyboard.press('Home'); assert.equal(await page.locator('[role="tab"]:focus').innerText(), 'a.md');
      await a.click({ button: 'right' }); await page.getByRole('menu', { name: '标签操作' }).waitFor();
      await page.keyboard.press('End'); assert.match(await page.locator(':focus').innerText(), /^关闭/);
      await page.keyboard.press('Escape'); assert.equal(await a.evaluate(el => el === document.activeElement), true);
      const settings = page.getByRole('button', { name: '设置', exact: true });
      await settings.click(); await page.getByRole('dialog', { name: '阅读设置' }).waitFor();
      if (screenshots) await page.screenshot({ path: path.join(screenshots, 'chrome-settings.png') });
      await composingEscape(); assert.equal(await page.locator('.settings-popover').isVisible(), true);
      await page.keyboard.press('Escape'); assert.equal(await settings.evaluate(el => el === document.activeElement), true);
      await settings.click(); await page.locator('.settings-popover').waitFor(); await settings.click();
      await page.locator('.settings-popover').waitFor({ state: 'hidden' });
    });

    await t.test('recycle failure retains the dialog/file and prevents duplicate async submissions', async () => {
      await page.locator('.cm-content').evaluate(el => { window.__originalChromeEditor = el; });
      await app.evaluate(({ ipcMain }) => {
        globalThis.__chromeTrash = { calls: 0, release: null };
        const original = ipcMain._invokeHandlers.get('trash-entry');
        ipcMain.removeHandler('trash-entry');
        ipcMain.handle('trash-entry', async () => {
          globalThis.__chromeTrash.calls++;
          await new Promise(resolve => { globalThis.__chromeTrash.release = resolve; });
          throw Error('injected recycle failure');
        });
        globalThis.__restoreChromeTrash = () => { ipcMain.removeHandler('trash-entry'); ipcMain.handle('trash-entry', original); };
      });
      await row('b.md').click({ button: 'right' }); await page.getByRole('menuitem', { name: '移到回收站', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '移到回收站', exact: true }); await dialog.waitFor();
      await page.keyboard.press('Shift+Tab'); assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
      await dialog.getByRole('button', { name: '移到回收站', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.dialog')?.getAttribute('aria-busy') === 'true');
      await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await app.evaluate(() => globalThis.__chromeTrash.calls), 1);
      await app.evaluate(() => globalThis.__chromeTrash.release());
      await dialog.getByRole('alert').waitFor();
      assert.equal(await fs.readFile(path.join(workspace.fixture, 'b.md'), 'utf8'), original);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.__originalChromeEditor === document.querySelector('.cm-content')), true);
      await app.evaluate(() => globalThis.__restoreChromeTrash());
    });

    await t.test('copy waits for confirmation, supports failure and compact PDF tools stay usable', async () => {
      await row('paper.pdf').click(); await page.locator('.layout-tabs').getByRole('button', { name: '阅读', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.textLayer')?.textContent.includes('Confirmed'));
      await page.evaluate(() => {
        window.__chromeCopy = { calls: 0, fail: false };
        Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => {
          const state = window.__chromeCopy; state.calls++; state.text = text;
          if (state.fail) throw Error('injected clipboard failure');
          await new Promise(resolve => { state.release = resolve; });
        } });
      });
      const points = await page.locator('.textLayer').first().evaluate(layer => {
        const node = [...layer.querySelectorAll('span')].find(el => el.firstChild?.nodeType === 3).firstChild;
        const point = (at, end) => { const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 1); const box = range.getBoundingClientRect(); return { x: end ? box.right - .5 : box.left + .5, y: box.top + box.height / 2 }; };
        return [point(0, false), point(8, true)];
      });
      await page.mouse.move(points[0].x, points[0].y); await page.mouse.down(); await page.mouse.move(points[1].x, points[1].y, { steps: 8 }); await page.mouse.up();
      const copy = page.getByRole('button', { name: '复制 PDF 选中文字', exact: true }); await copy.waitFor();
      await copy.click(); assert.equal(await copy.getAttribute('data-feedback'), 'busy');
      assert.equal(await copy.isDisabled(), true);
      await page.evaluate(() => window.__chromeCopy.release());
      await page.waitForFunction(() => document.querySelector('.action-feedback')?.dataset.feedback === 'done');
      assert.equal(await page.evaluate(() => window.__chromeCopy.calls), 1);
      await page.waitForFunction(() => document.querySelector('.action-feedback')?.dataset.feedback === 'ready');
      await page.evaluate(() => { window.__chromeCopy.fail = true; }); await copy.click();
      await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('复制失败'));
      assert.equal(await copy.getAttribute('data-feedback'), 'ready');
      await page.getByRole('button', { name: '取消 PDF 文字选区', exact: true }).click();
      await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setSize(760, 650); });
      await page.locator('.layout-tabs').getByRole('button', { name: '对照', exact: true }).click();
      const tools = page.getByRole('button', { name: 'PDF 标记工具', exact: true }); await tools.waitFor();
      await tools.click(); const menu = page.getByRole('menu', { name: 'PDF 标记工具', exact: true }); await menu.waitFor();
      assert.equal(await menu.getByRole('menuitemcheckbox').count(), 4);
      await page.keyboard.press('End'); assert.equal(await page.locator(':focus').getAttribute('aria-label'), '批注');
      await page.keyboard.press('Escape'); assert.equal(await tools.evaluate(el => el === document.activeElement), true);
      await menu.waitFor({ state: 'hidden' });
      await tools.click();
      try { await menu.getByRole('menuitemcheckbox', { name: '文字高亮', exact: true }).click(); }
      catch (error) { console.log(await page.evaluate(() => ({ menuOpen: !!document.querySelector('[role="menu"]'), expanded: document.querySelector('.toolbar-overflow button')?.getAttribute('aria-expanded'), focused: document.activeElement?.getAttribute('aria-label'), width: document.querySelector('.pdf-pane')?.clientWidth }))); throw error; }
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await fs.readFile(path.join(workspace.fixture, 'paper.pdf')).then(bytes => bytes.equals(pdfBytes)), true);
    });
    await t.test('splitter measures its pane, ignores tiny drags and cancels cleanly', async () => {
      // The compact toolbar case deliberately leaves a 760px window. At that
      // width the 240px pane minimum can clamp a valid drag; use a known wide
      // viewport for the separate, unclamped distance assertion.
      const size = await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1200, 800); return win.getContentSize(); });
      await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, size);
      const splitter = page.getByRole('separator', { name: '调整阅读与笔记宽度', exact: true });
      const panes = page.locator('.panes');
      const ratio = () => panes.evaluate(el => parseFloat(el.style.getPropertyValue('--split-at')));
      const start = async delta => {
        const box = await splitter.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 60); await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + delta, box.y + 60, { steps: 5 });
      };
      const initial = await ratio(), width = await panes.evaluate(el => el.getBoundingClientRect().width);
      await page.locator('.cm-content').evaluate(el => { window.__splitEditor = el; });
      await start(2); await page.mouse.up(); assert.equal(await ratio(), initial, 'micro movement does not resize');
      await start(55);
      const expected = initial + 55 / width * 100;
      await page.waitForFunction(value => Math.abs(parseFloat(document.querySelector('.panes').style.getPropertyValue('--split-at')) - value) < .05, expected);
      assert.ok(Math.abs(await ratio() - expected) < .05, 'drag distance uses the content width, excluding the sidebar');
      await page.mouse.up();
      await page.waitForFunction(value => Math.abs(parseFloat(document.querySelector('.panes').style.getPropertyValue('--split-at')) - value) < .05, expected);
      assert.equal(Number(await splitter.getAttribute('aria-valuenow')), Math.round(expected));
      const committed = await ratio();
      await start(-40); await page.keyboard.press('Escape'); await page.mouse.up();
      assert.ok(Math.abs(await ratio() - committed) < .05, 'Escape restores the committed ratio');
      assert.equal(await page.locator('.splitter-shield').count(), 0);
      await splitter.dblclick(); await page.waitForFunction(() => document.querySelector('[role="separator"]').getAttribute('aria-valuenow') === '50');
      await splitter.focus(); await page.keyboard.press('ArrowRight'); assert.equal(await ratio(), 52);
      // Playwright enables focus emulation in coreBundle.js. A native window
      // switch cannot emit renderer blur until this test-only emulation is off.
      const focusSession = await page.context().newCDPSession(page);
      await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.focus(); win.webContents.focus(); });
      await page.bringToFront(); await page.waitForFunction(() => document.hasFocus());
      await start(-35);
      await app.evaluate(async ({ BrowserWindow }) => {
        const other = new BrowserWindow({ width: 260, height: 160, show: true });
        globalThis.__splitFocusWindow = other;
        await other.loadURL('about:blank'); other.focus();
      });
      await page.waitForFunction(() => !document.querySelector('.panes').hasAttribute('data-pane-dragging'));
      await page.mouse.up(); await app.evaluate(({ BrowserWindow }) => { globalThis.__splitFocusWindow.close(); const main = BrowserWindow.getAllWindows()[0]; main.focus(); main.webContents.focus(); });
      assert.equal(await ratio(), 52, 'window blur cancels rather than committing a half-finished drag');
      assert.equal(await page.evaluate(() => window.__splitEditor === document.querySelector('.cm-content')), true);
      assert.equal(await page.locator('.cm-content').evaluate(el => getComputedStyle(el).userSelect === 'none'), false);
    });
    assert.deepEqual(errors, []);
    for (const name of ['a.md', 'b.md']) assert.equal(await fs.readFile(path.join(workspace.fixture, name), 'utf8'), original);
  } finally {
    const child = app?.process();
    try { await Promise.race([app?.close(), new Promise(resolve => setTimeout(resolve, 2000))]); } catch {}
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
