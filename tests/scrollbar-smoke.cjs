const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { PDFDocument } = require('pdf-lib');
const root = path.resolve(__dirname, '..');

test('long notes keep a usable native scrollbar and stable content width', { timeout: 90000 }, async () => {
  const workspace = await createSmokeWorkspace('scrollbar'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const file = path.join(workspace.fixture, 'long.md');
    await fs.writeFile(file, Array.from({ length: 2500 }, (_, index) => `第 ${index + 1} 行：长文滚动与布局检查。`).join('\n'));
    await Promise.all(Array.from({ length: 60 }, (_, index) => fs.writeFile(path.join(workspace.fixture, `z-${String(index).padStart(2, '0')}.md`), '示例')));
    const pdf = await PDFDocument.create(); for (let i = 0; i < 8; i++) pdf.addPage([595, 842]);
    await fs.writeFile(path.join(workspace.fixture, 'book.pdf'), await pdf.save());
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow();
    await page.locator('.file-row').filter({ hasText: 'long.md' }).dblclick();
    const scroller = page.locator('.cm-scroller'); await scroller.waitFor();
    await page.waitForFunction(() => { const el = document.querySelector('.cm-scroller'); return el && el.scrollHeight > el.clientHeight * 10; });
    const info = await scroller.evaluate(el => {
      const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb');
      const old = el.style.overflowY, widthBefore = el.clientWidth;
      el.style.overflowY = 'hidden'; const widthHidden = el.clientWidth;
      el.style.overflowY = old;
      return { widthBefore, widthHidden, minHeight: thumb.minHeight, radius: thumb.borderRadius, gutter: getComputedStyle(el).scrollbarGutter };
    });
    assert.equal(info.gutter, 'stable');
    assert.equal(info.widthBefore, info.widthHidden, 'scrollbar appearing or disappearing does not change content width');
    assert.equal(info.minHeight, '32px'); assert.equal(info.radius, '5px');
    const bounds = await scroller.boundingBox();
    await page.mouse.move(bounds.x + bounds.width - 6, bounds.y + 12);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width - 6, bounds.y + 120, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.cm-scroller').scrollTop > 100);
    const sidebar = page.locator('.file-list');
    await page.waitForFunction(() => { const el = document.querySelector('.file-list'); return el && el.scrollHeight > el.clientHeight; });
    assert.equal(await sidebar.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar-thumb').minHeight), '32px');
    const sideBounds = await sidebar.boundingBox();
    await page.mouse.move(sideBounds.x + sideBounds.width - 6, sideBounds.y + 12);
    await page.mouse.down(); await page.mouse.move(sideBounds.x + sideBounds.width - 6, sideBounds.y + 90, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.file-list').scrollTop > 0);
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
      await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'scrollbar-light.png') });
    }
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.app').getAttribute('data-theme'), 'constructivist-dark');
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'scrollbar-dark.png') });
    await page.getByRole('button', { name: '切换到预览', exact: true }).click();
    const preview = page.locator('.markdown-preview'); await preview.waitFor();
    assert.equal(await preview.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar-thumb').minHeight), '32px');
    await sidebar.evaluate(el => { el.scrollTop = 0; });
    await page.locator('.file-row').filter({ hasText: 'book.pdf' }).click();
    await page.locator('.layout-tabs').getByRole('button', { name: '阅读', exact: true }).click();
    const pdfScroll = page.locator('.pdf-canvas-wrap'); await pdfScroll.waitFor();
    await page.waitForFunction(() => { const el = document.querySelector('.pdf-canvas-wrap'); return el && el.scrollHeight > el.clientHeight; });
    assert.equal(await pdfScroll.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar-thumb').minHeight), '32px');
  } finally {
    if (app) await app.close();
    await cleanupSmokeWorkspace(workspace);
  }
});
