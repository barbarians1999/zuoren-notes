const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const JSZip = require('jszip');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { createNativeFocusDiagnostics } = require('./nativeFocusDiagnostics.cjs');
const root = path.resolve(__dirname, '..');

// A synchronous blur()/focus() pair may be coalesced before the renderer sees
// a blur. Transfer native focus to a test-owned blank window and observe both
// sides of the cycle instead, without touching any user application.
async function cycleNativeFocus(app, page, label) {
  const diagnostics = await createNativeFocusDiagnostics(app, page, label);
  let windows, originalError;
  try {
    diagnostics.stage('disable-focus-emulation');
    const session = await page.context().newCDPSession(page);
    try { await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }); }
    finally { await session.detach(); }
    diagnostics.stage('create-and-focus-auxiliary');
    windows = await app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      if (!main || main.isDestroyed()) throw Error('The test application window is unavailable');
      const auxiliary = new BrowserWindow({ width: 320, height: 160, show: false,
        title: 'Focus regression fixture', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await auxiliary.loadURL('about:blank');
        auxiliary.show(); auxiliary.focus();
        return { main: main.id, auxiliary: auxiliary.id };
      } catch (error) { if (!auxiliary.isDestroyed()) auxiliary.destroy(); throw error; }
    });
    diagnostics.identify(windows);
    diagnostics.stage('await-renderer-blur');
    await page.waitForFunction(() => !document.hasFocus());
    diagnostics.stage('assert-native-blur');
    assert.deepEqual(await app.evaluate(({ BrowserWindow }, ids) => ({
      main: BrowserWindow.fromId(ids.main)?.isFocused(), auxiliary: BrowserWindow.fromId(ids.auxiliary)?.isFocused(),
    }), windows), { main: false, auxiliary: true }, 'native focus actually leaves the application');
    diagnostics.stage('request-main-focus');
    await app.evaluate(({ BrowserWindow }, ids) => { BrowserWindow.fromId(ids.main)?.focus(); }, windows);
    diagnostics.stage('await-renderer-focus');
    await page.waitForFunction(() => document.hasFocus());
    diagnostics.stage('assert-native-focus');
    assert.equal(await app.evaluate(({ BrowserWindow }, ids) => BrowserWindow.fromId(ids.main)?.isFocused(), windows), true);
    await diagnostics.save('passed');
  } catch (error) {
    originalError = error;
    await diagnostics.save('failed', error);
    throw error;
  } finally {
    try {
      if (windows) await app.evaluate(({ BrowserWindow }, ids) => {
        const auxiliary = BrowserWindow.fromId(ids.auxiliary), main = BrowserWindow.fromId(ids.main);
        if (auxiliary && !auxiliary.isDestroyed()) auxiliary.destroy();
        if (main && !main.isDestroyed()) main.focus();
      }, windows);
    } catch (error) {
      if (!originalError) throw error;
      console.error('[input-focus] cleanup failed after the original failure: ' + error.message);
    } finally { await diagnostics.dispose(); }
  }
}

test('body clicks and font controls recover content focus without recreating the editor', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('input-focus'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const file = path.join(workspace.fixture, 'focus.md');
    await fs.writeFile(file, 'Plain body text for placing the cursor in the middle.\n\n汉仪书仿55W正文选项：阅读、编辑与撤销都应保持原有操作。\n');
    await fs.mkdir(path.join(workspace.fixture, 'cancel-folder'));
    const epub = new JSZip();
    epub.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    epub.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    epub.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">font-focus-fixture</dc:identifier><dc:title>Font fixture</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-10-07T00:00:00Z</meta></metadata><manifest><item id="toc" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
    epub.file('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Font check</a></li></ol></nav></body></html>');
    epub.file('chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Font check</title></head><body><h1>思源宋体正文</h1><p>这段正文验证思源宋体的内置字体加载，不改写原书。</p></body></html>');
    const epubFile = path.join(workspace.fixture, 'font.epub'), epubBytes = await epub.generateAsync({ type: 'nodebuffer' });
    await fs.writeFile(epubFile, epubBytes);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    assert.deepEqual(await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged })), { version: require('../package.json').version, packaged: !!packaged });
    const page = await app.firstWindow(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('.file-row').filter({ hasText: 'focus.md' }).dblclick();
    const editor = page.locator('[data-pane-id="primary"] .cm-content'); await editor.waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.querySelector('.app').getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getTiming().iterations))
        .map(animation => animation.finished.catch(() => {})));
    });
    await editor.evaluate(element => { window.__focusEditor = element; });
    async function clickMiddle() {
      const line = editor.locator('.cm-line').filter({ hasText: 'Plain body text' });
      const box = await line.boundingBox(); assert.ok(box);
      await page.mouse.click(box.x + 85, box.y + box.height / 2);
      return page.evaluate(() => ({ focused: document.hasFocus(), content: document.activeElement?.classList.contains('cm-content'), collapsed: window.getSelection()?.isCollapsed, sameEditor: window.__focusEditor === document.querySelector('[data-pane-id="primary"] .cm-content') }));
    }
    assert.deepEqual(await clickMiddle(), { focused: true, content: true, collapsed: true, sameEditor: true });
    const box = await editor.locator('.cm-line').filter({ hasText: 'Plain body text' }).boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
    const selected = await page.evaluate(() => window.getSelection().toString());
    assert.ok(selected.length > 0 && selected.length < 'Plain body text for placing the cursor in the middle.'.length,
      'drag selects only the requested characters, not the whole paragraph: ' + JSON.stringify({ selected, box, focus: await page.evaluate(() => ({ active: document.activeElement?.className, selection: window.getSelection()?.toString() })) }));

    // Preserve a live, partial CodeMirror selection across native window
    // deactivation/reactivation. Do not click between the two snapshots:
    // clicking would collapse the selection and miss the reported path.
    const selectionSnapshot = async () => page.evaluate(() => {
      const content = document.querySelector('[data-pane-id="primary"] .cm-content');
      const view = content.cmTile.root.view, selection = view.state.selection.main;
      const clipboard = new DataTransfer();
      content.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true }));
      return { anchor: selection.anchor, head: selection.head, text: view.state.sliceDoc(selection.from, selection.to),
        copied: clipboard.getData('text/markdown') };
    });
    const selectionBeforeFocus = await selectionSnapshot();
    assert.equal(selectionBeforeFocus.text, selected, 'the source selection matches the visible partial drag');
    assert.equal(selectionBeforeFocus.copied, selected, 'copy returns the selected source, not a larger region');
    await cycleNativeFocus(app, page, 'partial-selection');
    await page.waitForFunction(() => document.hasFocus());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await selectionSnapshot(), selectionBeforeFocus,
      'blur/refocus without an intervening click preserves the exact partial source selection');

    await clickMiddle();

    // Exercise actual window deactivate/reactivate, without touching user apps.
    await cycleNativeFocus(app, page, 'body-cursor');
    await clickMiddle();
    await page.waitForFunction(() => document.hasFocus() && document.activeElement?.classList.contains('cm-content'));
    assert.equal(await page.evaluate(() => window.getSelection()?.isCollapsed), true);
    await page.keyboard.insertText('CURSOR');
    const body = await editor.innerText();
    assert.match(body.split('\n')[0], /\S.*CURSOR.*\S/, 'input lands inside the clicked paragraph, not at its edge');
    await editor.press('Control+z');
    await page.waitForFunction(() => !document.querySelector('.cm-content').textContent.includes('CURSOR'));

    // Repeated cancel closes neither the note nor the editor. The modal traps
    // Tab/Escape inside the renderer, not Chromium's blocking native confirm.
    let nativeDialogs = 0; page.on('dialog', async dialog => { nativeDialogs++; await dialog.dismiss(); });
    for (let i = 0; i < 6; i++) {
      await page.locator('.file-row').filter({ hasText: 'cancel-folder' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: '移到回收站', exact: true }).click();
      const modal = page.getByRole('dialog', { name: '移到回收站', exact: true }); await modal.waitFor();
      assert.equal(await modal.getByRole('button', { name: '取消', exact: true }).evaluate(element => element === document.activeElement), true);
      for (let j = 0; j < 4; j++) await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
      assert.equal(await modal.evaluate(element => element.contains(document.activeElement)), true);
      if (i % 2) await page.keyboard.press('Escape'); else await modal.getByRole('button', { name: '取消', exact: true }).click();
      await modal.waitFor({ state: 'detached' }); await fs.access(path.join(workspace.fixture, 'cancel-folder'));
      assert.deepEqual(await clickMiddle(), { focused: true, content: true, collapsed: true, sameEditor: true });
    }
    assert.equal(nativeDialogs, 0);

    await page.getByRole('button', { name: '设置', exact: true }).click();
    const fonts = page.getByRole('combobox', { name: 'Markdown 正文字体', exact: true });
    await cycleNativeFocus(app, page, 'settings-font');
    await fonts.click();
    await page.waitForFunction(() => document.hasFocus() && document.activeElement?.tagName === 'SELECT');
    await page.keyboard.press('End'); await page.keyboard.press('Enter');
    assert.equal(await fonts.inputValue(), 'hanyi-shufang-55w', 'real mouse and keyboard can choose the HanYi system font');
    assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-note-font')), 'hanyi-shufang-55w');
    assert.equal(await fonts.locator('option:checked').textContent(), '汉仪书仿55W');
    assert.match(await editor.evaluate(element => getComputedStyle(element).fontFamily), /汉仪书仿 55W/);
    await page.keyboard.press('Escape');
    assert.deepEqual(await clickMiddle(), { focused: true, content: true, collapsed: true, sameEditor: true });
    assert.equal(await page.evaluate(() => window.__focusEditor === document.querySelector('.cm-content')), true);
    await fs.mkdir(workspace.outputs, { recursive: true });
    await page.screenshot({ path: path.join(workspace.outputs, 'hanyi-body-font-option.png') });
    await page.locator('.file-row').filter({ hasText: 'font.epub' }).click();
    const iframe = page.frameLocator('.epub-viewer iframe').first();
    const paragraph = iframe.locator('p'); await paragraph.waitFor();
    assert.match(await paragraph.evaluate(element => getComputedStyle(element).fontFamily), /汉仪书仿 55W/);
    assert.equal(await paragraph.innerText(), '这段正文验证思源宋体的内置字体加载，不改写原书。');
    await page.screenshot({ path: path.join(workspace.outputs, 'hanyi-epub-font-option.png') });
    assert.deepEqual(await fs.readFile(epubFile), epubBytes);
    assert.deepEqual(errors, []);
  } finally {
    const child = app?.process();
    try { await Promise.race([app?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
