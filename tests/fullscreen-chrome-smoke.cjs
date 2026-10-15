const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const JSZip = require('jszip');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const root = path.resolve(__dirname, '..');

test('fullscreen chrome reveals without resizing readers and preserves settings, focus and editor history', { timeout: 120000 }, async () => {
  const workspace = await createSmokeWorkspace('fullscreen-chrome');
  let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const note = '# Heading\n\nBody before fullscreen.\n';
    await fs.writeFile(path.join(workspace.fixture, 'note.md'), note);
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) pdf.addPage([595, 842]).drawText('Fullscreen page ' + i, { font, size: 20, x: 72, y: 760 });
    await fs.writeFile(path.join(workspace.fixture, 'book.pdf'), await pdf.save());
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fullscreen</dc:identifier><dc:title>Fullscreen</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>');
    zip.file('one.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Book</title></head><body><h1>Fullscreen book</h1>' + '<p>Reader position must remain stable when the toolbar appears.</p>'.repeat(60) + '</body></html>');
    await fs.writeFile(path.join(workspace.fixture, 'book.epub'), await zip.generateAsync({ type: 'nodebuffer' }));
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (packaged) assert.equal(await app.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    await page.waitForFunction(async () => (await window.reader.getWindowState()).maximized);
    const row = name => page.locator('.file-row').filter({ hasText: name });
    const show = async () => {
      await page.waitForFunction(() => document.querySelector('.app').dataset.fullscreen === 'true');
      await page.bringToFront(); await page.mouse.move(1, 1); await page.mouse.move(420, 2);
      await page.waitForFunction(() => document.querySelector('.app').dataset.chromeVisible === 'true');
    };
    const hide = async () => { await page.mouse.move(500, 400); await page.locator('.panes').click({ position: { x: 220, y: 240 } }); await page.waitForFunction(() => document.querySelector('.app').dataset.chromeVisible === 'false'); };
    const screenshot = async name => {
      if (!process.env.ZUOREN_SCREENSHOT_OUTPUT) return;
      await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, name + '.png') });
    };
    await row('note.md').dblclick();
    await page.locator('.cm-content').waitFor();
    await page.locator('.cm-content').evaluate(el => { window.__fullscreenEditor = el; });
    const chromeGeometry = await page.evaluate(() => {
      const app = document.querySelector('.app'), topbar = document.querySelector('.topbar'), noteRow = document.querySelector('.note-workspace-bar');
      const styles = getComputedStyle(app);
      return {
        topbarHeight: getComputedStyle(topbar).height,
        expectedTopbarHeight: styles.getPropertyValue('--chrome-topbar-height').trim(),
        noteRowHeight: getComputedStyle(noteRow).height,
        expectedNoteRowHeight: styles.getPropertyValue('--chrome-note-row-height').trim(),
      };
    });
    assert.equal(chromeGeometry.topbarHeight, chromeGeometry.expectedTopbarHeight, 'topbar height comes from the shared chrome token');
    assert.equal(chromeGeometry.noteRowHeight, chromeGeometry.expectedNoteRowHeight, 'note row height comes from the shared chrome token');
    await page.keyboard.press('Control+End'); await page.keyboard.insertText('UNDO-MARKER');
    for (const label of ['浅色', '深色']) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.locator('.settings-popover');
      assert.equal(await settings.getByText('资料栏', { exact: true }).count(), 0);
      assert.equal(await settings.locator('.settings-shortcuts, .settings-heading small, .note-font-control small').count(), 0);
      assert.equal(await settings.getByRole('slider', { name: '正文字体大小' }).count(), 1);
      assert.equal(await settings.getByRole('combobox', { name: 'Markdown 正文字体' }).count(), 1);
      await settings.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.waitForFunction(() => {
        const el = document.querySelector('.workspace-mode-switch button.active');
        if (!el) return false;
        const css = getComputedStyle(el), swatch = document.createElement('span');
        swatch.style.color = 'var(--accent)'; el.append(swatch);
        const ready = css.backgroundColor === 'rgba(0, 0, 0, 0)' && css.color === getComputedStyle(swatch).color;
        swatch.remove(); return ready;
      });
      assert.equal(await page.locator('.workspace-mode-switch button.active').evaluate(el => {
        const css = getComputedStyle(el); const swatch = document.createElement('span'); swatch.style.color = 'var(--accent)'; el.append(swatch);
        const same = css.color === getComputedStyle(swatch).color; swatch.remove(); return same;
      }), true);
    }
    assert.equal(await page.locator('.topbar').evaluate(el => getComputedStyle(el).opacity), '1', 'startup maximized is not immersive fullscreen');
    await page.bringToFront();
    await page.locator('.cm-content').click();
    await page.keyboard.press('F11');
    await page.waitForFunction(() => document.querySelector('.app').dataset.fullscreen === 'true' && document.querySelector('.app').dataset.chromeVisible === 'false');
    // The hidden row is translated during exit. Its layout inset, rather
    // than an arbitrary in-flight visual position, must use the shared token.
    assert.equal(await page.locator('.note-workspace-bar').evaluate(el => parseFloat(getComputedStyle(el).top)), parseFloat(chromeGeometry.expectedTopbarHeight), 'fullscreen note row starts directly below the shared topbar height');
    await screenshot('note-fullscreen-hidden');
    const editorBounds = await page.locator('.cm-editor').boundingBox();
    await show();
    assert.deepEqual(await page.locator('.cm-editor').boundingBox(), editorBounds);
    assert.equal(await page.getByRole('button', { name: '退出全屏', exact: true }).locator('svg.lucide-minimize-2').count(), 1, 'fullscreen exit uses inward arrows');
    assert.equal(await page.getByRole('button', { name: '退出全屏', exact: true }).locator('svg.lucide-maximize-2').count(), 0);
    const exit = await page.evaluate(() => {
      const root = document.querySelector('.app'), top = document.querySelector('.topbar');
      // Finish entry before measuring exit; test geometry, not just CSS names.
      for (const animation of top.getAnimations()) animation.finish();
      const height = top.getBoundingClientRect().height;
      root.dataset.chromeVisible = 'false'; getComputedStyle(top).transform;
      const slide = top.getAnimations().find(animation => animation.transitionProperty === 'transform');
      if (!slide) return null;
      const duration = slide.effect.getTiming().duration;
      slide.pause(); slide.currentTime = Number(duration) / 2;
      const displacement = Math.abs(new DOMMatrix(getComputedStyle(top).transform).m42);
      slide.finish(); root.dataset.chromeVisible = 'true';
      return { duration, fraction: displacement / height };
    });
    assert.ok(exit, 'fullscreen exit uses an actual transform transition');
    assert.equal(exit.duration, 240);
    assert.ok(exit.fraction > .4 && exit.fraction < .6, 'toolbar remains in view halfway through exit instead of disappearing offscreen immediately');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings-popover').waitFor();
    assert.equal(await page.locator('.settings-row').filter({ hasText: '全屏阅读' }).locator('svg.lucide-minimize-2').count(), 1, 'settings shows the same fullscreen exit icon');
    await screenshot('note-fullscreen-settings');
    await page.mouse.move(500, 450); await page.waitForTimeout(800);
    assert.equal(await page.locator('.app').getAttribute('data-chrome-visible'), 'true', 'open settings pins controls');
    await page.keyboard.press('Escape'); await hide();
    await page.keyboard.press('F6');
    await page.waitForFunction(() => document.activeElement?.closest('.topbar') && document.querySelector('.app').dataset.chromeVisible === 'true');
    await page.waitForTimeout(800); assert.equal(await page.locator('.app').getAttribute('data-chrome-visible'), 'true', 'keyboard focus stays visible');
    await page.getByRole('button', { name: '退出全屏', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app').dataset.fullscreen === 'false');
    assert.equal(await page.getByRole('button', { name: '退出全屏', exact: true }).count(), 0, 'restored windows no longer show fullscreen exit');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await page.locator('.settings-row').filter({ hasText: '全屏阅读' }).locator('svg.lucide-maximize-2').count(), 1, 'windowed settings shows outward arrows for entry');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.cm-content').evaluate(el => el === window.__fullscreenEditor), true);
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+z');
    assert.ok(!(await page.locator('.cm-content').innerText()).includes('UNDO-MARKER'), 'fullscreen does not lose undo');
    await row('book.pdf').click(); await page.locator('.layout-tabs').getByRole('button', { name: '阅读', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] canvas')?.width > 0);
    const input = page.getByRole('textbox', { name: '当前页码', exact: true });
    await input.fill('2'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-pdf-page="2"] canvas')?.width > 0);
    await page.waitForFunction(() => document.querySelector('.page-control input')?.value === '2' && document.querySelector('.pdf-canvas-wrap').scrollTop > 400);
    await page.keyboard.press('F11'); await hide();
    const pdfPosition = () => page.locator('.pdf-canvas-wrap').evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth }));
    const before = await pdfPosition(); await screenshot('pdf-fullscreen-hidden'); await show();
    assert.deepEqual(await pdfPosition(), before); assert.equal(await input.inputValue(), '2');
    await screenshot('pdf-fullscreen-revealed');
    await hide(); await page.keyboard.press('F11');
    await page.waitForFunction(() => document.querySelector('.app').dataset.fullscreen === 'false');
    await row('book.epub').click(); await page.locator('.epub-viewer iframe').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.epub-loading'));
    await page.keyboard.press('F11'); await hide();
    await page.waitForFunction(() => [...document.querySelectorAll('.epub-viewer iframe')].some(frame => frame.contentDocument?.body?.textContent?.includes('Reader position')));
    const epubPosition = () => page.locator('.epub-viewer').evaluate(el => ({ height: el.clientHeight, width: el.clientWidth, text: [...el.querySelectorAll('iframe')].map(frame => frame.contentDocument?.body?.textContent || '').join('') }));
    const epubBefore = await epubPosition(); await screenshot('epub-fullscreen-hidden'); await show();
    assert.deepEqual(await epubPosition(), epubBefore);
    await screenshot('epub-fullscreen-revealed');
    await page.locator('.epub-viewer iframe').evaluateAll(frames => { for (const frame of frames) if (frame.contentDocument?.body?.textContent?.includes('Reader position')) { frame.dataset.smokeFullscreenReady = 'true'; break; } });
    const epubBody = page.locator('[data-smoke-fullscreen-ready]').contentFrame().locator('body');
    await epubBody.click();
    await page.keyboard.press('F6');
    await page.waitForFunction(() => !!document.activeElement?.closest('.topbar'));
    await epubBody.click(); await page.keyboard.press('F11');
    await page.waitForFunction(() => document.querySelector('.app').dataset.fullscreen === 'false');
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(1000, 700); });
    await page.keyboard.press('F11'); await show(); await screenshot('epub-fullscreen-narrow');
    await page.keyboard.press('F11'); await page.waitForFunction(() => document.querySelector('.app').dataset.fullscreen === 'false');
    assert.deepEqual(errors, []);
  } finally {
    const child = app?.process();
    if (app) { try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {} }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
