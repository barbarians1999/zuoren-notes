const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const JSZip = require('jszip');
const { _electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { digest } = require('../electron/storage.cjs');
const appRoot = path.resolve(__dirname, '..');
let application, workspace;
after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});
async function makeEpub(title, contents) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const chapters = contents.map((_body, index) => `chapter-${index}.xhtml`);
  zip.file('OEBPS/book.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${title}</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((href, index) => `<item id="ch${index}" href="${href}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_href, index) => `<itemref idref="ch${index}"/>`).join('')}</spine></package>`);
  zip.file('OEBPS/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((href, index) => `<li><a href="${href}">Chapter ${index + 1}</a></li>`).join('')}</ol></nav></body></html>`);
  for (const [index, body] of contents.entries()) zip.file('OEBPS/' + chapters[index], `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${index + 1}</title><style>.hidden { color: red }</style></head><body><h1>Chapter ${index + 1}</h1>${body}</body></html>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
test('EPUB whole-book search crosses inline nodes, navigates safely and isolates books', { timeout: 90000 }, async t => {
  workspace = await createSmokeWorkspace('epub-search'); await fs.mkdir(workspace.fixture, { recursive: true });
  const first = await makeEpub('search-one', ['<p>NEEDLE first chapter.</p>', '<p>needle second chapter.</p><p>multi <em>node</em> phrase</p><p>\u793e<em>\u4f1a</em>\u4e3b\u4e49</p><p>paragraphboundary</p><p>anotherword</p>', Array.from({ length: 600 }, (_, index) => `<p>frequent ${index}</p>`).join('')]);
  await fs.writeFile(path.join(workspace.fixture, 'first.epub'), first);
  await fs.mkdir(path.join(workspace.fixture, '.reader'));
  const existingAnnotation = { id: '12345678-1234-4234-8234-123456789abc', kind: 'highlight', cfiRange: 'epubcfi(/6/2[ch0]!/4/4,/1:0,/1:6)', quote: 'NEEDLE', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
  await fs.writeFile(path.join(workspace.fixture, '.reader', digest(first) + '.epub.json'), JSON.stringify({ version: 2, id: digest(first), cfi: '', progress: 0, fontSize: 100, annotations: [existingAnnotation] }));
  await fs.writeFile(path.join(workspace.fixture, 'second.epub'), await makeEpub('search-two', ['<p>Other book content only.</p>']));
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  application = await _electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE ? [workspace.fixture] : [appRoot, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.file-row').filter({ hasText: 'first.epub' }).click();
  await page.locator('.epub-loading').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '在 EPUB 中查找', exact: true }).click();
  const panel = page.locator('.epub-search-panel'), input = panel.getByRole('textbox', { name: 'EPUB 搜索文本', exact: true });
  async function search(query, count) {
    await input.fill(query);
    await page.waitForFunction(expected => document.querySelector('.epub-search-status')?.textContent === `${expected} 项结果`, count);
    assert.equal(await panel.locator('.epub-search-results > button').count(), count);
  }
  await t.test('literal search, case sensitivity, cross-node Chinese and correct chapter navigation', async () => {
    await search('needle', 2);
    await panel.locator('.epub-search-results > button').nth(1).click();
    await page.waitForFunction(() => document.querySelector('.epub-pane')?.dataset.currentChapter === 'Chapter 2');
    await page.locator('.zuoren-epub-search-hit').waitFor();
    await panel.getByRole('button', { name: 'EPUB 搜索区分大小写', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.epub-search-status')?.textContent === '1 项结果');
    await panel.getByRole('button', { name: 'EPUB 搜索区分大小写', exact: true }).click();
    await search('multi node phrase', 1); await search('\u793e\u4f1a\u4e3b\u4e49', 1);
    await input.fill('paragraphboundaryanotherword');
    await panel.getByText('没有找到匹配内容', { exact: true }).waitFor();
  });
  await t.test('result cap, quick query replacement and close remove temporary marks', async () => {
    await input.fill('frequent'); await panel.getByText('最多显示 500 项，请缩小关键词范围。', { exact: true }).waitFor();
    assert.equal(await panel.locator('.epub-search-results > button').count(), 500);
    await input.fill('frequent'); await input.fill('needle'); await input.fill('absent-phrase');
    await panel.getByText('没有找到匹配内容', { exact: true }).waitFor();
    await search('needle', 2); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.epub-pane')?.dataset.currentChapter === 'Chapter 1');
    await input.press('Escape'); await panel.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.zuoren-epub-search-hit').count(), 0);
    await page.locator('.zhaoye-epub-highlight').waitFor();
  });
  await t.test('Ctrl+F works inside the book and switching books cancels old search', async () => {
    await page.evaluate(() => {
      const doc = document.querySelector('.epub-viewer iframe').contentDocument;
      doc.body.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await input.waitFor(); await search('needle', 2);
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'epub-search.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    const bounds = await panel.evaluate(element => { const a = element.getBoundingClientRect(), b = element.parentElement.getBoundingClientRect(); return { fits: a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom, readable: element.clientWidth >= 200 }; });
    assert.deepEqual(bounds, { fits: true, readable: true });
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'epub-search-narrow.png') });
    await input.fill('frequent'); await page.locator('.file-row').filter({ hasText: 'second.epub' }).click();
    await page.locator('.file-row.selected').filter({ hasText: 'second.epub' }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.epub-viewer iframe')].some(frame => frame.contentDocument?.body?.textContent.includes('Other book content only.')));
    await page.locator('.epub-loading').waitFor({ state: 'hidden' });
    assert.equal(await panel.count(), 0);
    await page.getByRole('button', { name: '在 EPUB 中查找', exact: true }).click();
    assert.equal(await input.inputValue(), '');
    await input.fill('needle'); await panel.getByText('没有找到匹配内容', { exact: true }).waitFor();
    await search('Other book', 1);
  });
  assert.deepEqual(errors, []);
  const sidecar = path.join(workspace.fixture, '.reader', digest(first) + '.epub.json');
  const meta = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  assert.deepEqual(meta.annotations, [existingAnnotation], 'temporary search marks never alter saved annotations');
});
