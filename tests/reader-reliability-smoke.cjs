const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const JSZip = require('jszip');
const { _electron } = require('playwright');
const { digest } = require('../electron/storage.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const appRoot = path.resolve(__dirname, '..');
let workspace, application;

after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});

test('PDF actions are single-flight, undo survives page eviction and EPUB falls back from a stale position', { timeout: 90000 }, async () => {
  workspace = await createSmokeWorkspace('reader-reliability');
  await fs.mkdir(workspace.fixture, { recursive: true });
  await fs.mkdir(workspace.userData, { recursive: true });
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= 8; number++) document.addPage([595, 842]).drawText(`Reader reliability page ${number}`, { font, size: 24, x: 72, y: 750 });
  const pdf = Buffer.from(await document.save()), pdfId = digest(pdf);
  await fs.writeFile(path.join(workspace.fixture, 'audit.pdf'), pdf);
  const other = await PDFDocument.create(); other.addPage();
  await fs.writeFile(path.join(workspace.fixture, 'other.pdf'), await other.save());
  const auxiliary = path.join(workspace.fixture, '.reader'); await fs.mkdir(auxiliary);
  const annotation = { id: '156b22fd-a2c1-49b7-aa7f-7d69de6f0130', type: 'note', anchor: { pdfId, page: 1, rects: [{ x: 0.2, y: 0.2, w: 0.025, h: 0.025 }], rotation: 0 }, text: 'undo-audit', createdAt: new Date().toISOString() };
  const sidecar = path.join(auxiliary, pdfId + '.json');
  await fs.writeFile(sidecar, JSON.stringify({ version: 1, id: pdfId, page: 1, annotations: [annotation] }));
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-audit</dc:identifier><dc:title>Reader audit</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>');
  zip.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter one</a></li></ol></nav></body></html>');
  zip.file('OEBPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter one</title></head><body><h1>Chapter one</h1><p>Intact book content.</p></body></html>');
  const epub = await zip.generateAsync({ type: 'nodebuffer' }), epubId = digest(epub);
  await fs.writeFile(path.join(workspace.fixture, 'bad-position.epub'), epub);
  await fs.writeFile(path.join(auxiliary, epubId + '.epub.json'), JSON.stringify({ version: 2, id: epubId, cfi: 'missing.xhtml', progress: 0.5, fontSize: 100, annotations: [] }));
  const retryNoteA = path.join(workspace.fixture, 'retry-a.md'), retryNoteB = path.join(workspace.fixture, 'retry-b.md');
  await fs.writeFile(retryNoteA, '# Retry target A\n\n'); await fs.writeFile(retryNoteB, '# Retry target B\n\n');
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  application = await _electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE ? [workspace.fixture] : [appRoot, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => { console.error('[reader-reliability] ' + error.stack); errors.push(error.message); });
  // Simulate a visibility notification already queued when its page is
  // disconnected. It must not access the document worker after disposal.
  await page.evaluate(() => {
    const NativeObserver = window.IntersectionObserver;
    window.__latePdfObservers = 0;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) {
        let latestEntries;
        super((entries, observer) => { latestEntries = entries; callback(entries, observer); }, options);
        this.deliverLate = () => {
          if (options?.rootMargin !== '900px' || !latestEntries?.length) return;
          queueMicrotask(() => { window.__latePdfObservers++; callback(latestEntries, this); });
        };
      }
      disconnect() { super.disconnect(); this.deliverLate(); }
    };
  });
  await page.locator('.file-row').filter({ hasText: 'audit.pdf' }).click();
  await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] canvas')?.width > 0);
  await page.getByRole('button', { name: '\u6279\u6ce8', exact: true }).click();
  await page.locator('[data-pdf-page="1"] .draw-layer.interactive').click({ position: { x: 140, y: 160 } });
  await page.getByPlaceholder('\u5199\u4e0b\u6279\u6ce8').fill('repeat-save-audit');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === '\u4fdd\u5b58\u6279\u6ce8');
    button.click(); button.click();
  });
  try { await page.getByPlaceholder('\u5199\u4e0b\u6279\u6ce8').waitFor({ state: 'hidden' }); }
  catch (error) { console.error(await page.locator('body').innerText()); throw error; }
  assert.equal(await page.locator('[data-pdf-page="1"] .annotation.note[title="repeat-save-audit"]').count(), 1);
  await page.getByRole('button', { name: '\u9009\u62e9', exact: true }).click();
  await page.locator('[data-pdf-page="1"] .annotation.note[title="undo-audit"]').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '删除 PDF 标记', exact: true }).click();
  await page.locator('.inline-undo').waitFor();
  const pageInput = page.locator('input[aria-label="\u5f53\u524d\u9875\u7801"]');
  await pageInput.fill('7'); await pageInput.press('Enter');
  await page.locator('[data-pdf-page="1"] canvas').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.inline-undo').count(), 1, 'undo outlives page virtualization');
  // A failed undo must retain the record and support retry.
  await application.evaluate(() => {
    const io = process.getBuiltinModule('node:fs/promises'), original = io.rename;
    io.rename = async (from, to) => {
      if (/[\\/]\.reader[\\/][a-f0-9]{64}\.json$/i.test(String(to))) { io.rename = original; throw new Error('injected undo write failure'); }
      return original(from, to);
    };
  });
  await page.locator('.inline-undo').getByRole('button', { name: '\u64a4\u9500', exact: true }).click();
  await page.getByText('\u6807\u8bb0\u4fdd\u5b58\u5931\u8d25', { exact: false }).waitFor();
  assert.equal(await page.locator('.inline-undo').count(), 1);
  await page.evaluate(() => { const button = document.querySelector('.inline-undo button'); button.click(); button.click(); });
  await page.locator('.inline-undo').waitFor({ state: 'hidden' });
  await pageInput.fill('1'); await pageInput.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] canvas')?.width > 0);
  assert.equal(await page.locator('[data-pdf-page="1"] .annotation.note[title="undo-audit"]').count(), 1);
  const saved = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  assert.equal(saved.annotations.filter(item => item.id === annotation.id).length, 1);
  assert.equal(saved.annotations.filter(item => item.text === 'repeat-save-audit').length, 1);
  await page.locator('[data-pdf-page="1"] .annotation.note[title="undo-audit"]').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '删除 PDF 标记', exact: true }).click();
  await page.locator('.inline-undo').waitFor();
  await page.locator('.file-row').filter({ hasText: 'other.pdf' }).click();
  await page.locator('.file-row.selected').filter({ hasText: 'other.pdf' }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] canvas')?.width > 0);
  assert.equal(await page.locator('.inline-undo').count(), 0, 'undo cannot leak into another PDF');
  await page.locator('.file-row').filter({ hasText: 'bad-position.epub' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.epub-viewer iframe')].some(frame => frame.contentDocument?.body?.textContent?.includes('Intact book content.')));
  await page.getByText('\u539f\u9605\u8bfb\u4f4d\u7f6e\u5df2\u5931\u6548', { exact: false }).waitFor();
  await page.locator('.file-row').filter({ hasText: 'retry-a.md' }).dblclick();
  await page.getByRole('tab', { name: 'retry-a.md', exact: true }).waitFor();
  await page.locator('.file-row').filter({ hasText: 'retry-b.md' }).dblclick();
  const retryTabA = page.getByRole('tab', { name: 'retry-a.md', exact: true });
  const retryTabB = page.getByRole('tab', { name: 'retry-b.md', exact: true });
  await retryTabA.click();
  await page.locator('.file-row').filter({ hasText: 'bad-position.epub' }).click();
  const epubFrame = page.frameLocator('.epub-viewer iframe').last();
  await epubFrame.getByText('Intact book content.', { exact: true }).selectText();
  const actions = page.getByRole('group', { name: '处理选中文本' });
  await actions.waitFor();
  await application.evaluate(() => {
    const io = process.getBuiltinModule('node:fs/promises'), original = io.rename;
    globalThis.__epubSaveStarted = new Promise(resolve => { globalThis.__notifyEpubSaveStarted = resolve; });
    io.rename = async (from, to) => {
      if (/\.epub\.json$/i.test(String(to))) {
        io.rename = original;
        globalThis.__notifyEpubSaveStarted();
        await new Promise(resolve => { globalThis.__releaseEpubSave = resolve; });
      }
      return original(from, to);
    };
  });
  await actions.getByRole('button', { name: '批注并摘录到当前笔记', exact: true }).click();
  await application.evaluate(async () => globalThis.__epubSaveStarted);
  await retryTabB.click();
  await application.evaluate(() => globalThis.__releaseEpubSave());
  await actions.getByText('EPUB 标注已保存，但目标笔记已切换', { exact: false }).waitFor();
  await page.locator('.layout-tabs').getByRole('button', { name: '阅读', exact: true }).click();
  await page.locator('.layout-tabs').getByRole('button', { name: '对照', exact: true }).click();
  await retryTabA.click();
  await actions.getByRole('button', { name: '重试摘录', exact: true }).click();
  await waitForFile(retryNoteA, text => text.includes('回到原文'));
  assert.doesNotMatch(await fs.readFile(retryNoteB, 'utf8'), /回到原文/, 'the retry must not follow the newly active note');
  const writtenEpubMeta = JSON.parse(await fs.readFile(path.join(auxiliary, epubId + '.epub.json'), 'utf8'));
  assert.equal(writtenEpubMeta.annotations.length, 1, 'retry must not duplicate the saved annotation');
  assert.ok(await page.evaluate(() => window.__latePdfObservers) > 0, 'late visibility callbacks exercised PDF disposal');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await application.waitForEvent('close', { timeout: 12000 }); application = undefined;
  const epubMeta = JSON.parse(await fs.readFile(path.join(auxiliary, epubId + '.epub.json'), 'utf8'));
  assert.ok(epubMeta.cfi.startsWith('epubcfi('), 'successful fallback persists a valid position');
  assert.deepEqual(errors, []);
});
