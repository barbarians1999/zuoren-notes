const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { _electron } = require('./electronHarness.cjs');
const { digest } = require('../electron/storage.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const root = path.resolve(__dirname, '..');

test('region and OCR handoffs stay bound to the original note, retain retries and preserve one-step undo', { timeout: 90000 }, async t => {
  const workspace = await createSmokeWorkspace('reader-handoff'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const a = path.join(workspace.fixture, 'a.md'), b = path.join(workspace.fixture, 'b.md');
    const originalA = '# A\n\n', originalB = '# B\n\n';
    await fs.writeFile(a, originalA); await fs.writeFile(b, originalB);
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([440, 280]).drawText('Handoff crop and OCR', { font, size: 20, x: 30, y: 240 });
    const bytes = Buffer.from(await pdf.save()), pdfFile = path.join(workspace.fixture, 'paper.pdf');
    await fs.writeFile(pdfFile, bytes);
    const sidecar = path.join(workspace.fixture, '.reader', digest(bytes) + '.json');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('.cm-content').waitFor();
    for (const name of ['a.md', 'b.md']) await page.locator('.file-row').filter({ hasText: name }).dblclick();
    const tabA = page.getByRole('tab', { name: 'a.md', exact: true }), tabB = page.getByRole('tab', { name: 'b.md', exact: true });
    await tabA.click(); await page.locator('.file-row').filter({ hasText: 'paper.pdf' }).click();
    await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] canvas')?.width > 0);
    await app.evaluate(({ ipcMain }) => {
      const attachment = ipcMain._invokeHandlers.get('save-attachment'), anchor = ipcMain._invokeHandlers.get('make-anchor-path');
      globalThis.__handoffAudit = { sources: [], delayAttachment: true, pending: false, release: null, failAnchor: false, anchors: 0,
        delayAnchor: false, anchorPending: false, releaseAnchor: null, holdOcr: false, ocrJobs: [], canceled: [], failCancel: false };
      ipcMain.removeHandler('save-attachment'); ipcMain.handle('save-attachment', async (event, input) => {
        const audit = globalThis.__handoffAudit; audit.sources.push(input.sourcePath);
        if (audit.delayAttachment) { audit.delayAttachment = false; audit.pending = true; await new Promise(resolve => audit.release = resolve); }
        return attachment(event, input);
      });
      ipcMain.removeHandler('make-anchor-path'); ipcMain.handle('make-anchor-path', async (event, input) => {
        const audit = globalThis.__handoffAudit; audit.anchors++;
        if (audit.failAnchor) { audit.failAnchor = false; throw Error('injected handoff insertion failure'); }
        if (audit.delayAnchor) { audit.delayAnchor = false; audit.anchorPending = true; await new Promise(resolve => audit.releaseAnchor = resolve); }
        return anchor(event, input);
      });
      ipcMain.removeHandler('start-ocr'); ipcMain.handle('start-ocr', event => {
        const audit = globalThis.__handoffAudit, jobId = 'handoff-ocr-' + (audit.ocrJobs.length + 1);
        audit.ocrJobs.push(jobId);
        if (!audit.holdOcr) setTimeout(() => event.sender.send('ocr-progress', { jobId, progress: 1, status: 'done', text: 'Captured OCR text' }), 80);
        return { jobId };
      });
      ipcMain.removeHandler('cancel-ocr'); ipcMain.handle('cancel-ocr', (_event, jobId) => {
        const audit = globalThis.__handoffAudit;
        if (audit.failCancel) { audit.failCancel = false; throw Error('injected OCR cancellation failure'); }
        audit.canceled.push(jobId); return true;
      });
    });
    let lastDrag;
    async function draw() {
      await page.getByRole('button', { name: '框选', exact: true }).click();
      const holder = page.locator('[data-pdf-page="1"] .canvas-holder');
      await holder.scrollIntoViewIfNeeded();
      const title = holder.locator('.textLayer span').filter({ hasText: 'Handoff crop and OCR' }); await title.waitFor();
      const rect = await holder.boundingBox(), text = await title.boundingBox();
      assert.ok(rect && text);
      const drag = { x: text.x - 4, y: text.y - 4, width: text.width + 8, height: text.height + 8 };
      await page.mouse.move(drag.x, drag.y); await page.mouse.down();
      await page.mouse.move(drag.x + drag.width, drag.y + drag.height, { steps: 5 }); await page.mouse.up();
      const painted = await holder.locator('.selection-box').boundingBox(); assert.ok(painted);
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(painted[key] - drag[key]) <= 2, 'painted region must match the actual drag: ' + key);
      lastDrag = { x: (drag.x - rect.x) / rect.width, y: (drag.y - rect.y) / rect.height, w: drag.width / rect.width, h: drag.height / rect.height };
      await fs.mkdir(workspace.outputs, { recursive: true });
      await holder.screenshot({ path: path.join(workspace.outputs, 'title-region.png') });
      await page.getByRole('button', { name: '保存图片摘录', exact: true }).waitFor();
    }
    async function assertCrop() {
      const saved = JSON.parse(await fs.readFile(sidecar, 'utf8')).annotations.at(-1).anchor.rects[0];
      for (const key of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(saved[key] - lastDrag[key]) < .002, 'saved region must match the visible box: ' + key);
      const markdown = await fs.readFile(a, 'utf8'), image = markdown.match(/!\[[^\]]*\]\(([^)]+)\)/);
      assert.ok(image, 'image excerpt has a local attachment');
      const bytes = await fs.readFile(path.resolve(workspace.fixture, decodeURIComponent(image[1])));
      const pixels = await page.evaluate(async encoded => {
        const raw = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([raw], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let dark = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] > 200) dark++;
        return { width: canvas.width, height: canvas.height, dark };
      }, bytes.toString('base64'));
      assert.equal(pixels.width, Math.max(1, Math.round(440 * 3 * saved.w)));
      assert.equal(pixels.height, Math.max(1, Math.round(280 * 3 * saved.h)));
      assert.ok(pixels.dark > 100, 'exported crop must contain the title, not the blank region below it');
    }
    async function undoExcerpt() {
      await page.locator('[data-note-group="primary"] .cm-content').click(); await page.keyboard.press('Control+z');
      await waitForFile(a, text => text === originalA);
    }
    await t.test('switching target during attachment I/O does not insert into either note; returning retries the same image', async () => {
      await draw(); await page.getByRole('button', { name: '保存图片摘录', exact: true }).click();
      await app.evaluate(async () => { while (!globalThis.__handoffAudit.pending) await new Promise(resolve => setTimeout(resolve, 10)); });
      await tabB.click(); await app.evaluate(() => globalThis.__handoffAudit.release());
      await page.getByRole('button', { name: '重试操作', exact: true }).waitFor();
      assert.equal(await fs.readFile(a, 'utf8'), originalA); assert.equal(await fs.readFile(b, 'utf8'), originalB);
      await tabA.click(); await page.getByRole('button', { name: '重试操作', exact: true }).click();
      await waitForFile(a, text => text.includes('回到原文') && text.includes('![PDF'));
      assert.equal((await app.evaluate(() => globalThis.__handoffAudit.sources)).length, 1);
      assert.equal((await app.evaluate(() => globalThis.__handoffAudit.sources))[0], a);
      assert.equal(JSON.parse(await fs.readFile(sidecar, 'utf8')).annotations.length, 1);
      await assertCrop();
      await undoExcerpt();
    });
    await t.test('insertion failure exposes a retry without another image or annotation', async () => {
      await draw(); await app.evaluate(() => globalThis.__handoffAudit.failAnchor = true);
      await page.getByRole('button', { name: '保存图片摘录', exact: true }).click();
      await page.getByRole('button', { name: '重试摘录', exact: true }).waitFor();
      assert.equal(JSON.parse(await fs.readFile(sidecar, 'utf8')).annotations.length, 2);
      await page.getByRole('button', { name: '重试摘录', exact: true }).click();
      await waitForFile(a, text => text.includes('回到原文'));
      assert.equal((await app.evaluate(() => globalThis.__handoffAudit.sources)).length, 2);
      assert.equal(JSON.parse(await fs.readFile(sidecar, 'utf8')).annotations.length, 2);
      await undoExcerpt();
    });
    await t.test('OCR insertion failure retains the confirmed text and retries only the original note transaction', async () => {
      await draw(); await page.getByRole('button', { name: '识别文字并摘录', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '扫描文字识别' }); await dialog.locator('textarea').waitFor();
      assert.equal(await dialog.getAttribute('aria-modal'), 'true');
      for (let step = 0; step < 7; step++) {
        await page.keyboard.press(step % 2 ? 'Shift+Tab' : 'Tab');
        assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'Tab stays in the OCR dialog');
      }
      await dialog.getByRole('button', { name: '关闭扫描文字识别', exact: true }).focus();
      const pageBefore = await page.locator('.page-control input').inputValue();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('.page-control input').inputValue(), pageBefore);
      await page.keyboard.press('Control+f');
      assert.equal(await page.getByRole('search', { name: '查找当前 PDF', exact: true }).count(), 0, 'OCR focus must not open PDF search behind the modal');
      await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
      assert.equal(await dialog.isVisible(), true, 'IME Escape does not dismiss OCR');
      const screenshots = process.env.ZUOREN_SCREENSHOT_OUTPUT;
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, 'chrome-ocr-dialog.png') }); }
      await waitForFile(a, text => text.includes('![PDF'));
      await app.evaluate(() => globalThis.__handoffAudit.failAnchor = true);
      await dialog.getByRole('button', { name: '确认并插入文字', exact: true }).click();
      await dialog.getByRole('button', { name: '重试摘录', exact: true }).waitFor();
      assert.equal(JSON.parse(await fs.readFile(sidecar, 'utf8')).annotations.at(-1).ocrText, 'Captured OCR text');
      assert.doesNotMatch(await fs.readFile(a, 'utf8'), /Captured OCR text/);
      await app.evaluate(() => { globalThis.__handoffAudit.delayAnchor = true; });
      await dialog.getByRole('button', { name: '重试摘录', exact: true }).click();
      await app.evaluate(async () => { while (!globalThis.__handoffAudit.anchorPending) await new Promise(resolve => setTimeout(resolve, 10)); });
      assert.equal(await dialog.getAttribute('aria-busy'), 'true');
      await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true, 'writing must finish before dismissal');
      assert.equal(await dialog.getByRole('button', { name: '关闭扫描文字识别', exact: true }).isDisabled(), true);
      await app.evaluate(() => globalThis.__handoffAudit.releaseAnchor());
      await dialog.waitFor({ state: 'hidden' }); await waitForFile(a, text => text.includes('Captured OCR text'));
      await page.waitForFunction(() => document.activeElement?.classList.contains('pdf-pane'));
      assert.equal((await fs.readFile(a, 'utf8')).match(/Captured OCR text/g).length, 1);
      assert.equal(JSON.parse(await fs.readFile(sidecar, 'utf8')).annotations.length, 3);
      assert.equal((await app.evaluate(() => globalThis.__handoffAudit.sources)).length, 3);
      await page.locator('.cm-content').click(); await page.keyboard.press('Control+z');
      await waitForFile(a, text => text.includes('![PDF') && !text.includes('Captured OCR text'));
    });
    await t.test('OCR close and Escape cancel only the active job, preserve saved images and restore focus', async () => {
      await app.evaluate(() => { globalThis.__handoffAudit.holdOcr = true; });
      for (const closeWithEscape of [false, true]) {
        const imageCount = ((await fs.readFile(a, 'utf8')).match(/!\[PDF/g) || []).length;
        await draw(); await page.getByRole('button', { name: '识别文字并摘录', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '扫描文字识别' }); await dialog.waitFor();
        const jobId = await app.evaluate(() => globalThis.__handoffAudit.ocrJobs.at(-1));
        await waitForFile(a, text => (text.match(/!\[PDF/g) || []).length === imageCount + 1);
        const savedText = await fs.readFile(a, 'utf8');
        if (!closeWithEscape) {
          await app.evaluate(() => { globalThis.__handoffAudit.failCancel = true; });
          await dialog.getByRole('button', { name: '关闭扫描文字识别', exact: true }).click();
          await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('取消识别失败'));
          assert.equal(await dialog.isVisible(), true, 'a failed cancellation stays available for retry');
        }
        if (closeWithEscape) await page.keyboard.press('Escape');
        else await dialog.getByRole('button', { name: '关闭扫描文字识别', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.activeElement?.classList.contains('pdf-pane'));
        assert.equal((await app.evaluate(() => globalThis.__handoffAudit.canceled)).at(-1), jobId);
        assert.equal(await fs.readFile(a, 'utf8'), savedText, 'canceling recognition must not discard the saved image excerpt');
      }
      assert.equal((await app.evaluate(() => globalThis.__handoffAudit.canceled)).length, 2);
    });
    assert.equal(await fs.readFile(b, 'utf8'), originalB);
    assert.equal(digest(await fs.readFile(pdfFile)), digest(bytes)); assert.deepEqual(errors, []);
  } finally {
    const child = app?.process();
    if (app) { try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {} }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
