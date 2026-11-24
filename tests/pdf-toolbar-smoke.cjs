const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, PDFName, PDFString, StandardFonts } = require('pdf-lib');
const { _electron, readerReady, settle } = require('./electronHarness.cjs');
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
  const originalPdf = Buffer.from(await pdf.save());
  await fs.writeFile(path.join(workspace.fixture, filename), originalPdf);
  const bookmarkPdf = await PDFDocument.load(originalPdf);
  const outlineRoot = bookmarkPdf.context.obj({ Type: 'Outlines', Count: 3 });
  const outlineRef = bookmarkPdf.context.register(outlineRoot);
  const destinations = [['Chapter start', 0, 842], ['Same page section', 0, 450], ['Next chapter', 1, 842]];
  const bookmarkRows = destinations.map(([title, index, top]) => bookmarkPdf.context.obj({ Title: PDFString.of(title), Parent: outlineRef, Dest: [bookmarkPdf.getPage(index).ref, PDFName.of('FitH'), top] }));
  const refs = bookmarkRows.map(row => bookmarkPdf.context.register(row));
  for (const [index, row] of bookmarkRows.entries()) {
    if (index > 0) row.set(PDFName.of('Prev'), refs[index - 1]);
    if (index + 1 < refs.length) row.set(PDFName.of('Next'), refs[index + 1]);
  }
  outlineRoot.set(PDFName.of('First'), refs[0]); outlineRoot.set(PDFName.of('Last'), refs.at(-1));
  bookmarkPdf.catalog.set(PDFName.of('Outlines'), outlineRef);
  const bookmarkName = 'with-bookmarks.pdf';
  await fs.writeFile(path.join(workspace.fixture, bookmarkName), await bookmarkPdf.save());
  await fs.writeFile(path.join(workspace.fixture, 'note.md'), '# Note\n\nKeep this note intact.\n');
  await fs.writeFile(path.join(workspace.fixture, 'note-two.md'), '# Second note\n\nKeep the second note intact.\n');
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  application = await _electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE ? [workspace.fixture] : [appRoot, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const layout = name => page.locator('.layout-tabs').getByRole('button', { name, exact: true });
  await page.locator('.file-row').filter({ hasText: filename }).click();
  await layout('阅读').click();
  await readerReady(page, 'pdf', 1);
  const bar = page.locator('.pdf-navigation'), tools = bar.locator('.pdf-tools'), topBar = page.locator('.pdf-top-bar');
  const output = process.env.ZUOREN_SCREENSHOT_OUTPUT || workspace.outputs;
  await fs.mkdir(output, { recursive: true });
  const sameRow = async () => {
    await bar.evaluate(async element => {
      const host = element.closest('.pdf-viewport-stage');
      const top = document.querySelector('.topbar');
      await Promise.all([
        ...element.getAnimations(),
        ...(host ? host.getAnimations() : []),
        ...(top ? top.getAnimations() : []),
      ].map(animation => animation.finished.catch(() => {})));
    });
    const bounds = await bar.boundingBox(), toolBounds = await bar.locator('.pdf-tools, .toolbar-overflow').boundingBox();
    assert.ok(bounds && toolBounds && bounds.height <= 46 && toolBounds.y >= bounds.y - 1 && toolBounds.y + toolBounds.height <= bounds.y + bounds.height + 1 && toolBounds.x >= bounds.x - 1 && toolBounds.x + toolBounds.width <= bounds.x + bounds.width + 1,
      'bottom dock tools must remain within the single compact capsule row: ' + JSON.stringify({ bounds, toolBounds }));
    const topBounds = await topBar.boundingBox();
    assert.ok(topBounds && topBounds.height <= 40, 'PDF top bar fits in the single top row: ' + JSON.stringify(topBounds));
    assert.equal(await page.locator('.pdf-pane > .pdf-tools, .reader-document-title').count(), 0);
    assert.equal(await bar.count(), 1);
  };
  await t.test('book name pill sits in top header while marking tools share the bottom dock with page and zoom', async () => {
    await sameRow();
    assert.equal(await topBar.locator('.pdf-doc-pill').innerText(), filename);
    assert.equal(await bar.getAttribute('title'), filename);
    assert.ok((await topBar.getByRole('button', { name: '展开 PDF 大纲', exact: true }).getAttribute('title')).includes(filename));
    const outlineToggle = await topBar.locator('[data-pdf-outline-toggle]').boundingBox(), topBarBounds = await topBar.boundingBox();
    assert.ok(outlineToggle.x > topBarBounds.x + topBarBounds.width / 2, 'outline control sits beside its right-hand panel');
    for (const name of ['文字高亮', '框选', '批注', '选择']) {
      const button = tools.getByRole('button', { name, exact: true });
      await button.click(); assert.equal(await button.getAttribute('aria-pressed'), 'true');
      assert.equal(await tools.locator('[aria-pressed="true"]').count(), 1);
    }
    await topBar.getByRole('button', { name: '展开 PDF 大纲', exact: true }).click();
    await page.locator('.pdf-outline').waitFor();
    const panel = page.getByRole('complementary', { name: 'PDF 大纲', exact: true });
    assert.equal(await panel.locator('.outline-title').innerText(), '大纲');
    const panelBounds = await panel.boundingBox(), viewportBounds = await page.locator('.pdf-canvas-wrap').boundingBox();
    assert.ok(panelBounds.x >= viewportBounds.x + viewportBounds.width - 1, 'PDF outline uses the same right-hand edge as EPUB and notes');
    await settle(panel); await page.screenshot({ path: path.join(output, 'pdf-outline-right.png') });
    await panel.getByRole('button', { name: '第 2 页', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '2');
    await panel.getByRole('button', { name: '第 2 页', exact: true }).and(panel.locator('[aria-current="location"]')).waitFor();
    assert.equal(await bar.getByRole('textbox', { name: '当前页码', exact: true }).inputValue(), '2', 'books without embedded outlines keep page navigation');
    await panel.getByRole('button', { name: '第 2 页', exact: true }).focus();
    await topBar.getByRole('button', { name: '收起 PDF 大纲', exact: true }).click();
    await page.locator('.pdf-outline').waitFor({ state: 'hidden' });
    assert.equal(await topBar.locator('[data-pdf-outline-toggle]').evaluate(button => document.activeElement === button), true);
    const number = bar.getByRole('textbox', { name: '当前页码', exact: true });
    await number.fill('2'); await number.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-pdf-page="2"] canvas')?.width > 0);
    const previousRevision = await page.locator('[data-pdf-page="2"] .textLayer').getAttribute('data-text-revision');
    await bar.getByRole('button', { name: '放大', exact: true }).click();
    await page.waitForFunction(previous => document.querySelector('[data-pdf-page="2"] .textLayer')?.dataset.textRevision !== previous, previousRevision);
    await readerReady(page, 'pdf', 2); assert.equal(await number.inputValue(), '2');
    await topBar.getByRole('button', { name: '在 PDF 中查找', exact: true }).click();
    await page.getByRole('textbox', { name: 'PDF 查找文本', exact: true }).fill('Toolbar');
    await page.getByRole('button', { name: '关闭 PDF 查找', exact: true }).click();
    await sameRow(); await page.screenshot({ path: path.join(output, 'pdf-toolbar-wide.png') });
  });
  await t.test('up/down scroll the focused PDF, repeat, clamp at boundaries and keep page navigation', async () => {
    const viewport = page.locator('.pdf-canvas-wrap'), pane = page.locator('.pdf-pane');
    const top = () => viewport.evaluate(element => element.scrollTop);
    await viewport.evaluate(element => { element.scrollTop = 100; });
    await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '1');
    await pane.evaluate(element => element.focus({ preventScroll: true }));
    await page.keyboard.press('ArrowDown'); assert.equal(await top(), 164);
    await page.keyboard.press('ArrowUp'); assert.equal(await top(), 100);
    await page.keyboard.down('ArrowDown'); await page.keyboard.down('ArrowDown'); await page.keyboard.up('ArrowDown');
    assert.equal(await top(), 228, 'held-key repeats move once per event without extra browser scrolling');
    await page.keyboard.press('Control+ArrowDown'); assert.equal(await top(), 228, 'modified arrows are not intercepted');
    const ignored = await pane.evaluate(element => {
      const before = element.querySelector('.pdf-canvas-wrap').scrollTop;
      const composing = new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true });
      element.dispatchEvent(composing);
      const handled = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      handled.preventDefault(); element.dispatchEvent(handled);
      return { before, after: element.querySelector('.pdf-canvas-wrap').scrollTop, composingPrevented: composing.defaultPrevented };
    });
    assert.equal(ignored.after, ignored.before); assert.equal(ignored.composingPrevented, false);
    await viewport.evaluate(element => { element.scrollTop = 0; });
    await page.keyboard.press('ArrowUp'); assert.equal(await top(), 0);
    const bottom = await viewport.evaluate(async element => {
      let previousMax = -1, stableFrames = 0;
      for (let frame = 0; frame < 120 && stableFrames < 2; frame++) {
        element.scrollTop = element.scrollHeight;
        await new Promise(requestAnimationFrame);
        const max = element.scrollHeight - element.clientHeight;
        stableFrames = Math.abs(max - previousMax) < .5 && Math.abs(element.scrollTop - max) < .5 ? stableFrames + 1 : 0;
        previousMax = max;
      }
      return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, stable: stableFrames >= 2 };
    });
    assert.equal(bottom.stable, true, 'PDF scroll maximum settles before the boundary check: ' + JSON.stringify(bottom));
    await page.keyboard.press('ArrowDown');
    const afterBottomArrow = await top();
    assert.equal(afterBottomArrow, bottom.top, 'ArrowDown remains clamped at the stable bottom: ' + JSON.stringify({ before: bottom.top, after: afterBottomArrow, max: bottom.max, scrollHeight: bottom.scrollHeight, clientHeight: bottom.clientHeight }));
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '1');
    const firstPageTop = await top();
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '2');
    assert.equal(await top(), firstPageTop + 1280, 'crossing a page updates its number without snapping to the page top');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '3');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '2');
    const number = bar.getByRole('textbox', { name: '当前页码', exact: true });
    await number.focus(); const beforeInput = await top();
    await number.press('ArrowDown'); await number.press('ArrowUp'); assert.equal(await top(), beforeInput, 'page input keeps its native arrow behavior');
    await topBar.getByRole('button', { name: '在 PDF 中查找', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'PDF 查找文本', exact: true });
    const beforeSearch = await top(); await search.press('ArrowDown'); await search.press('ArrowUp');
    assert.equal(await top(), beforeSearch, 'search input does not scroll the PDF');
    await page.getByRole('button', { name: '关闭 PDF 查找', exact: true }).click();
    await topBar.getByRole('button', { name: '展开 PDF 大纲', exact: true }).click();
    const outline = page.locator('.pdf-outline'); await outline.waitFor();
    await outline.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    await outline.getByRole('button', { name: '第 2 页', exact: true }).focus();
    const beforeOutline = await top(); await page.keyboard.press('ArrowDown');
    assert.equal(await top(), beforeOutline, 'outline focus does not invoke reading-position shortcuts');
    await topBar.getByRole('button', { name: '收起 PDF 大纲', exact: true }).click();
    await outline.waitFor({ state: 'hidden' });
  });
  await t.test('split and narrow panes retain one row with reachable labeled icons', async () => {
    await page.locator('.file-row').filter({ hasText: 'note.md' }).dblclick();
    await page.locator('.file-row').filter({ hasText: 'note-two.md' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '在右侧打开', exact: true }).click();
    await page.locator('[data-pane-id="secondary"] .cm-content').waitFor();
    const primaryText = await page.locator('[data-pane-id="primary"] .cm-content').innerText();
    const secondaryText = await page.locator('[data-pane-id="secondary"] .cm-content').innerText();
    await layout('对照').click();
    const size = await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setSize(760, 720); return win.getContentSize(); });
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, size);
    await sameRow();
    const noteRow = page.locator('.note-workspace-bar'), noteSlot = page.locator('.note-header-slot');
    const noteTools = noteSlot.locator('.markdown-workspace-actions');
    assert.equal(await noteRow.isVisible(), true);
    assert.equal(await page.locator('[data-note-group="primary"]').isVisible(), false, 'comparison shows only the active note pane from a dual-note workspace');
    assert.equal(await page.locator('[data-note-group="secondary"]').isVisible(), true);
    const [readerBox, noteBox, rowBox] = await Promise.all([topBar.boundingBox(), noteTools.boundingBox(), noteRow.boundingBox()]);
    assert.ok(readerBox && noteBox && rowBox);
    assert.ok(Math.abs((readerBox.y + readerBox.height / 2) - (noteBox.y + noteBox.height / 2)) <= 2, 'PDF and note tools share the same visible horizontal row');
    for (const bounds of [readerBox, noteBox]) assert.ok(bounds.y >= rowBox.y && bounds.y + bounds.height <= rowBox.y + rowBox.height + 1, 'both tool groups fit inside the shared row');
    const overflow = bar.getByRole('button', { name: 'PDF 标记工具', exact: true });
    await overflow.waitFor();
    for (const [host, name] of [
      [topBar, '展开 PDF 大纲'], [topBar, '在 PDF 中查找'], [topBar, '进入全屏阅读'],
      [bar, '上一页'], [bar, '下一页'], [bar, 'PDF 标记工具'], [bar, '缩小'], [bar, '放大'],
    ]) {
      const button = host.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const rect = await button.boundingBox(), bounds = await host.boundingBox();
      assert.ok(rect && bounds && rect.x >= bounds.x - 1 && rect.x + rect.width <= bounds.x + bounds.width + 1, name);
    }
    for (const name of ['查找', '源码编辑模式', '切换到预览', '展开大纲', '新建空白标签']) {
      const button = noteTools.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const rect = await button.boundingBox(), bounds = await noteSlot.boundingBox();
      assert.ok(rect && bounds && rect.x >= bounds.x - 1 && rect.x + rect.width <= bounds.x + bounds.width + 1, `note control is reachable: ${name}`);
    }
    await overflow.click();
    const menu = page.getByRole('menu', { name: 'PDF 标记工具', exact: true });
    for (const name of ['选择', '文字高亮', '框选', '批注']) assert.equal(await menu.getByRole('menuitemcheckbox', { name, exact: true }).isVisible(), true);
    await menu.getByRole('menuitemcheckbox', { name: '文字高亮', exact: true }).click();
    await overflow.click();
    assert.equal(await menu.getByRole('menuitemcheckbox', { name: '文字高亮', exact: true }).getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Escape');
    await bar.evaluate(el => { el.scrollLeft = 0; });
    await page.screenshot({ path: path.join(output, 'pdf-toolbar-split-narrow.png') });
    assert.equal(await page.locator('.cm-content:visible').count(), 1);
    const beforeEditing = await page.locator('.pdf-canvas-wrap').evaluate(element => element.scrollTop);
    const activeEditor = page.locator('[data-pane-id="secondary"] .cm-content');
    await activeEditor.focus();
    assert.equal(await activeEditor.evaluate(editor => editor === document.activeElement), true, 'the visible comparison note receives keyboard focus');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('.pdf-canvas-wrap').evaluate(element => element.scrollTop), beforeEditing, 'note editing never moves the PDF');
    await layout('阅读').click();
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.layout === 'read');
    assert.equal(await page.locator('.note-group:visible').count(), 0, 'reading mode hides both notes');
    const reader = page.locator('.pdf-pane'); await reader.focus();
    assert.equal(await reader.evaluate(element => element === document.activeElement), true, 'the PDF remains keyboard-focusable after leaving comparison');
    await layout('笔记').click();
    await page.waitForFunction(() => document.querySelector('.panes.note.dual-notes'));
    assert.equal(await page.locator('.note-group:visible').count(), 2, 'note mode restores both open note panes');
    assert.equal(await page.locator('.note-workspace-bar').isVisible(), true);
    assert.equal(await page.locator('[data-pane-id="primary"] .cm-content').innerText(), primaryText);
    assert.equal(await page.locator('[data-pane-id="secondary"] .cm-content').innerText(), secondaryText);
    await page.locator('[data-pane-id="secondary"] .cm-content').focus();
    assert.equal(await page.locator('[data-pane-id="secondary"] .cm-content').evaluate(editor => editor === document.activeElement), true, 'a restored note pane can receive keyboard focus');
    await layout('对照').click();
    await page.waitForFunction(() => document.querySelector('.panes.split'));
    await overflow.waitFor();
    await sameRow();
    assert.equal(await page.locator('[data-note-group="primary"]').isVisible(), false);
    assert.equal(await page.locator('[data-note-group="secondary"] .cm-content').innerText(), secondaryText);
  });
  await t.test('dark reading and fullscreen preserve the merged tools', async () => {
    await layout('阅读').click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '深墨夜读', exact: true }).click();
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
    await topBar.getByRole('button', { name: '进入全屏阅读', exact: true }).click();
    assert.equal(await application.evaluate(async ({ BrowserWindow }) => {
      for (let i = 0; i < 200 && globalThis.__fullscreenReplyCount < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
      return BrowserWindow.getAllWindows()[0].isFullScreen();
    }), true);
    await page.waitForTimeout(100);
    assert.equal(await topBar.getByRole('button', { name: '进入全屏阅读', exact: true }).count(), 0, 'late fullscreen reply must not restore the entry button');
    assert.equal(await topBar.getByRole('button', { name: '退出全屏阅读', exact: true }).count(), 0, 'fullscreen has only the window-level exit');
    await page.mouse.move(400, 2);
    await page.waitForFunction(() => document.querySelector('.app').dataset.chromeVisible === 'true');
    await sameRow();
    await settle(page.locator('.topbar')); await page.screenshot({ path: path.join(output, 'pdf-toolbar-fullscreen.png') });
    await page.getByRole('button', { name: '退出全屏', exact: true }).click();
    assert.equal(await application.evaluate(async ({ BrowserWindow }) => {
      for (let i = 0; i < 200 && globalThis.__fullscreenReplyCount < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
      return BrowserWindow.getAllWindows()[0].isFullScreen();
    }), false);
    await page.waitForTimeout(100);
    assert.equal(await topBar.locator('button[aria-label="进入全屏阅读"]').isVisible(), true);
  });
  await t.test('scrolled PDF and note exit keep topbar window drag regions active', async () => {
    await page.locator('.pdf-canvas-wrap').evaluate(el => { el.scrollTop = 180; });
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.pdfImmersive === 'true');
    const immersiveRegions = await page.evaluate(() => ({
      topbarDrag: getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region').trim(),
      topbarPointer: getComputedStyle(document.querySelector('.topbar')).pointerEvents,
      pdfBarDrag: getComputedStyle(document.querySelector('.pdf-top-bar')).getPropertyValue('-webkit-app-region').trim(),
      pillDrag: getComputedStyle(document.querySelector('.pdf-doc-pill')).getPropertyValue('-webkit-app-region').trim(),
    }));
    assert.deepEqual(immersiveRegions, { topbarDrag: 'drag', topbarPointer: 'auto', pdfBarDrag: 'drag', pillDrag: 'drag' });
    await layout('对照').click();
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.layout === 'split');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region').trim()), 'drag');
    await layout('笔记').click();
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.layout === 'note');
    const afterNote = await page.evaluate(() => ({
      immersiveAttr: document.querySelector('.app')?.dataset.pdfImmersive ?? null,
      topbarDrag: getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region').trim(),
    }));
    assert.deepEqual(afterNote, { immersiveAttr: null, topbarDrag: 'drag' });
  });
  await t.test('embedded PDF bookmarks track jumps and scrolling, including two destinations on one page', async () => {
    await page.locator('.file-row').filter({ hasText: bookmarkName }).click(); await layout('阅读').click();
    await readerReady(page, 'pdf', 1);
    await topBar.getByRole('button', { name: '展开 PDF 大纲', exact: true }).click();
    const outline = page.getByRole('complementary', { name: 'PDF 大纲', exact: true });
    const current = name => outline.getByRole('button', { name, exact: true }).and(outline.locator('[aria-current="location"]'));
    await current('Chapter start').waitFor();
    await outline.getByRole('button', { name: 'Same page section', exact: true }).click();
    await current('Same page section').waitFor();
    assert.equal(await bar.getByRole('textbox', { name: '当前页码', exact: true }).inputValue(), '1');
    await page.locator('.pdf-canvas-wrap').evaluate(el => { el.scrollTop = el.querySelector('[data-pdf-page="2"]').offsetTop + 100; });
    await current('Next chapter').waitFor();
  });
  assert.equal(await fs.readFile(path.join(workspace.fixture, 'note.md'), 'utf8'), '# Note\n\nKeep this note intact.\n');
  assert.deepEqual(await fs.readFile(path.join(workspace.fixture, filename)), originalPdf);
  assert.deepEqual(errors, []);
});
