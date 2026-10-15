const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const JSZip = require('jszip');
const { noteUI } = require('./noteUi.cjs');
const { platformFonts } = require('./platformFonts.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

async function assertHanYi(page, expression) {
  const fonts = await platformFonts(page, expression);
  assert.ok(fonts.length > 0, 'probe must have rendered glyphs');
  assert.ok(fonts.every(font => font.postScriptName === 'HYShuFang-55W' && font.glyphCount > 0), `Expected exact HanYi 55W glyphs, got ${JSON.stringify(fonts)}`);
}

test('installed HanYi 55W supplies actual editor, preview and EPUB glyphs', { timeout: 60000 }, async t => {
  const workspace = await createSmokeWorkspace('body-font');
  let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const original = '# 标题\n\n汉仪书仿正文测试：阅读编辑保持一致。\n\n**粗体正文** 与 *斜体正文*。\n';
    const notePath = path.join(workspace.fixture, 'font.md');
    await fs.writeFile(notePath, original);
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">hanyi-fixture</dc:identifier><dc:title>Font</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-10-09T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
    zip.file('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">正文</a></li></ol></nav></body></html>');
    zip.file('chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>字体测试</title></head><body><p>汉仪书仿正文测试：阅读编辑保持一致。</p></body></html>');
    const epubPath = path.join(workspace.fixture, 'font.epub');
    const epubBytes = await zip.generateAsync({ type: 'nodebuffer' });
    await fs.writeFile(epubPath, epubBytes);
    const root = path.resolve(__dirname, '..');
    app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow();
    await page.locator('.file-row').filter({ hasText: 'font.md' }).dblclick();
    const body = page.locator('.cm-line').filter({ hasText: '汉仪书仿正文测试' });
    await body.waitFor();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const available = await page.evaluate(async () => {
      try { return (await document.fonts.load('20px "Zuoren HanYi 55W"')).length > 0; }
      catch { return false; }
    });
    assert.equal(await page.evaluate(() => Array.from(document.fonts).some(font => font.family === 'Zuoren HanYi 55W')), true, 'exact local font face must be declared');
    if (!available) { t.skip('HanYi 55W is not installed on this test machine.'); return; }
    await page.locator('.cm-content').evaluate(element => { window.__fontEditor = element; });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('combobox', { name: 'Markdown 正文字体' }).selectOption('hanyi-shufang-55w');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.fonts.ready);
    await assertHanYi(page, `Array.from(document.querySelectorAll('.cm-line')).find(e => e.textContent.includes('汉仪书仿正文测试'))`);
    await assertHanYi(page, `Array.from(document.querySelectorAll('.cm-line')).find(e => e.textContent.includes('粗体正文'))`);
    assert.equal(await page.evaluate(() => window.__fontEditor === document.querySelector('.cm-content')), true);
    await noteUI(page, 'primary').getByRole('button', { name: '切换到预览', exact: true }).click();
    await page.locator('.markdown-preview p').first().waitFor();
    await assertHanYi(page, `document.querySelector('.markdown-preview p')`);
    await assertHanYi(page, `document.querySelector('.markdown-preview strong')`);
    await assertHanYi(page, `document.querySelector('.markdown-preview em')`);
    const headingFonts = await platformFonts(page, `document.querySelector('.markdown-preview h1')`);
    assert.ok(headingFonts.some(font => /SourceHanSerif/.test(font.postScriptName) && font.glyphCount >= 2), `Chinese heading keeps Source Han Serif: ${JSON.stringify(headingFonts)}`);
    assert.ok(headingFonts.every(font => font.postScriptName !== 'HYShuFang-55W'), 'body preference must not replace heading font');
    await page.locator('.file-row').filter({ hasText: 'font.epub' }).click();
    const paragraph = page.frameLocator('.epub-viewer iframe').first().locator('p');
    await paragraph.waitFor();
    await paragraph.evaluate(() => document.fonts.ready);
    await assertHanYi(page, `document.querySelector('.epub-viewer iframe').contentDocument.querySelector('p')`);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('combobox', { name: 'Markdown 正文字体' }).selectOption('fangsong');
    await paragraph.evaluate(() => document.fonts.ready);
    const fallbackFonts = await platformFonts(page, `document.querySelector('.epub-viewer iframe').contentDocument.querySelector('p')`);
    assert.ok(fallbackFonts.every(font => font.postScriptName === 'AaFangSongNon-CommercialUse'), 'existing FangSong remains unchanged');
    await page.getByRole('combobox', { name: 'Markdown 正文字体' }).selectOption('hanyi-shufang-55w');
    await paragraph.evaluate(() => document.fonts.ready);
    await assertHanYi(page, `document.querySelector('.epub-viewer iframe').contentDocument.querySelector('p')`);
    assert.equal(await fs.readFile(notePath, 'utf8'), original);
    assert.deepEqual(await fs.readFile(epubPath), epubBytes);
    assert.deepEqual(errors, []);
  } finally {
    await app?.close();
    await cleanupSmokeWorkspace(workspace);
  }
});
