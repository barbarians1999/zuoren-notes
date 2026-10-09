const { noteUI, focusNote, moreAction } = require('./noteUi.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PDFDocument, PDFName, PDFString, StandardFonts, rgb } = require('pdf-lib');
const JSZip = require('jszip');
const { _electron: electron, chromium } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

const appRoot = path.resolve(__dirname, '..');
let smokeWorkspace;
let fixtureRoot;
let userData;
let outputs;
let application;
let browser;
const stage = name => process.stderr.write(`[electron-smoke] ${name}\n`);
async function withTimeout(label, operation, ms = 12000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`stage timed out: ${label} after ${ms}ms`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function waitForFileMatch(file, pattern, ms = 6000) {
  const deadline = Date.now() + ms;
  let content = '';
  while (Date.now() < deadline) {
    content = await fs.readFile(file, 'utf8');
    if (pattern.test(content)) return content;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  assert.match(content, pattern);
}

async function launchSecondInstance(executablePath, file) {
  const args = process.env.ZHAOYE_EXE ? [file] : [appRoot, file];
  const child = spawn(executablePath, args, { env: { ...process.env, ZHAOYE_TEST_USER_DATA: userData }, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('second instance did not exit')); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

async function makeFixture() {
  smokeWorkspace = await createSmokeWorkspace('electron-smoke');
  fixtureRoot = smokeWorkspace.fixture; userData = smokeWorkspace.userData; outputs = smokeWorkspace.outputs;
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(outputs, { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, '专题资料'));
  await fs.writeFile(path.join(fixtureRoot, '对照笔记.md'), '# 对照笔记\n\n独立编辑和保存。\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, '专题资料', '下一级笔记.md'), '# 下一级笔记\n', 'utf8');
  const researchNote = '# 剩余价值\n\n1. 第一项正文\n2. 第二项正文即使内容很长并且在较窄的笔记区域内自动换行，编号也应当和第一行正文保持在同一行，后续各行继续沿正文起始位置排列。\n\n我的分析：测试原位保存。\n\n## 概念\n\n```text\n概念其实是理性知识\n```\n\n### 进一步分析\n';
  await fs.writeFile(path.join(fixtureRoot, '研究笔记.md'), researchNote.replaceAll('\n', '\r\n'), 'utf8');
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= 2; number += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`Research Reader - Page ${number}`, { x: 72, y: 750, size: 20, font, color: rgb(.12, .22, .17) });
    page.drawText('Select, annotate, excerpt, and return to the source.', { x: 72, y: 710, size: 12, font });
  }
  const outlines = document.context.obj({ Type: 'Outlines' });
  const outlinesRef = document.context.register(outlines);
  const first = document.context.obj({ Title: PDFString.of('Chapter one'), Parent: outlinesRef, Dest: [document.getPage(0).ref, PDFName.of('Fit')] });
  const second = document.context.obj({ Title: PDFString.of('Chapter two'), Parent: outlinesRef, Dest: [document.getPage(1).ref, PDFName.of('Fit')] });
  const firstRef = document.context.register(first), secondRef = document.context.register(second);
  first.set(PDFName.of('Next'), secondRef); second.set(PDFName.of('Prev'), firstRef);
  outlines.set(PDFName.of('First'), firstRef); outlines.set(PDFName.of('Last'), secondRef);
  document.catalog.set(PDFName.of('Outlines'), outlinesRef);
  await fs.writeFile(path.join(fixtureRoot, '研究资料.pdf'), await document.save());

  const epub = new JSZip();
  epub.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  epub.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  epub.file('OEBPS/content.opf', '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:zhaoye-test</dc:identifier><dc:title>研究读物</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-09-09T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  epub.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">第一章 开端</a></li><li><a href="chapter2.xhtml">第二章 继续阅读</a></li></ol></nav></body></html>');
  epub.file('OEBPS/chapter1.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章 开端</h1><p>这是一本保留在原磁盘位置的测试电子书。</p></body></html>');
  epub.file('OEBPS/chapter2.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章 继续阅读</h1><p>阅读位置和字号会自动记住。</p></body></html>');
  await fs.writeFile(path.join(fixtureRoot, '研究读物.epub'), await epub.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip', compression: 'DEFLATE' }));
}

after(async () => {
  const appProcess = application?.process();
  const pid = appProcess?.pid;
  try {
    if (application) await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 8000))]);
  } catch { /* already closed */ }
  if (pid && appProcess?.exitCode === null) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  try { await browser?.close(); } catch { /* already closed */ }
  if (smokeWorkspace) await cleanupSmokeWorkspace(smokeWorkspace);
});

test('production UI opens original files, autosaves, searches, annotates and returns', { timeout: 120000 }, async () => {
  await makeFixture();
  const executablePath = process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const args = process.env.ZHAOYE_EXE ? [fixtureRoot] : [appRoot, fixtureRoot];
  let page;
  if (process.env.ZHAOYE_CDP_URL) {
    browser = await chromium.connectOverCDP(process.env.ZHAOYE_CDP_URL);
    page = browser.contexts()[0].pages()[0];
  } else {
    application = await electron.launch({ executablePath, args, env: { ...process.env, ZHAOYE_TEST_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' } });
    application.process().stderr?.on('data', chunk => process.stderr.write(chunk));
    page = await application.firstWindow();
  }
  const rendererErrors = [];
  page.setDefaultTimeout(15000);
  page.on('console', message => { if (message.type() === 'error') rendererErrors.push(message.text()); });
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('requestfailed', request => rendererErrors.push(`request failed: ${request.url()} — ${request.failure()?.errorText}`));
  await page.waitForSelector('.topbar');
  stage('app ready');
  assert.equal(await page.title(), '左人笔记 · 阅读与思考');
  assert.equal(await page.locator('.window-controls button').count(), 3);
  const windowControlSize = await page.getByRole('button', { name: '最小化窗口' }).evaluate(element => {
    const bounds = element.getBoundingClientRect(); return { width: bounds.width, height: bounds.height };
  });
  assert.deepEqual(windowControlSize, { width: 44, height: 47 }); // Leave the bottom separator unobstructed.
  await page.getByRole('button', { name: '还原窗口' }).waitFor(); // Startup is maximized.
  await page.getByRole('button', { name: '还原窗口' }).click();
  await page.getByRole('button', { name: '最大化窗口' }).waitFor();
  await page.getByRole('button', { name: '最大化窗口' }).click();
  await page.getByRole('button', { name: '还原窗口' }).waitFor();
  await page.getByText('专题资料', { exact: true }).click();
  await page.getByText('下一级笔记.md', { exact: true }).waitFor();
  await page.getByRole('button', { name: '专题资料' }).waitFor();
  await page.getByRole('button', { name: '返回上一级文件夹' }).click();
  await page.locator('.file-row').filter({ hasText: '研究笔记.md' }).waitFor();
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByLabel('新文件夹名称').fill('右键测试文件夹');
  await page.getByLabel('新文件夹名称').press('Enter');
  await page.locator('.file-row').filter({ hasText: '右键测试文件夹' }).waitFor();
  await fs.access(path.join(fixtureRoot, '右键测试文件夹'));
  await page.locator('.file-row').filter({ hasText: '右键测试文件夹' }).click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: '在新标签页中打开' }).count(), 0);
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByLabel('重命名 右键测试文件夹').fill('已重命名文件夹');
  await page.getByLabel('重命名 右键测试文件夹').press('Enter');
  await page.locator('.file-row').filter({ hasText: '已重命名文件夹' }).waitFor();
  await fs.access(path.join(fixtureRoot, '已重命名文件夹'));
  await assert.rejects(fs.access(path.join(fixtureRoot, '右键测试文件夹')));
  await page.locator('.file-row').filter({ hasText: '已重命名文件夹' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移到回收站' }).click();
  const deletionDialog = page.getByRole('dialog', { name: '移到回收站', exact: true });
  await deletionDialog.waitFor(); assert.match(await deletionDialog.innerText(), /已重命名文件夹.*回收站/);
  await deletionDialog.getByRole('button', { name: '取消', exact: true }).click();
  await deletionDialog.waitFor({ state: 'detached' });
  await fs.access(path.join(fixtureRoot, '已重命名文件夹'));
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByLabel('新文件夹名称').fill('待回收测试文件夹');
  await page.getByLabel('新文件夹名称').press('Enter');
  const disposableFolder = page.locator('.file-row').filter({ hasText: '待回收测试文件夹' });
  await disposableFolder.waitFor();
  await disposableFolder.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移到回收站' }).click();
  await page.getByRole('dialog', { name: '移到回收站', exact: true }).getByRole('button', { name: '移到回收站', exact: true }).click();
  await disposableFolder.waitFor({ state: 'detached' });
  await assert.rejects(fs.access(path.join(fixtureRoot, '待回收测试文件夹')));
  await page.getByRole('button', { name: '新笔记', exact: true }).click();
  await page.getByLabel('新笔记名称').fill('现场笔记');
  await page.getByLabel('新笔记名称').press('Enter');
  await page.locator('.document-tab').filter({ hasText: '现场笔记.md' }).waitFor();
  await fs.access(path.join(fixtureRoot, '现场笔记.md'));
  await page.locator('.file-row').filter({ hasText: '研究笔记.md' }).click({ button: 'right' });
  const contextMenu = page.getByRole('menu');
  await contextMenu.waitFor();
  assert.equal(await contextMenu.getByRole('menuitem').count(), 5);
  await contextMenu.getByRole('menuitem', { name: '在新标签页中打开' }).click();
  await page.getByRole('button', { name: '关闭 现场笔记.md' }).click();
  const wysiwyg = page.locator('.markdown-source-editor .cm-content');
  await wysiwyg.waitFor();
  await wysiwyg.locator('.cm-md-heading-1').filter({ hasText: '剩余价值' }).waitFor();
  await page.waitForTimeout(3500);
  assert.equal(await page.locator('[data-note-controls="primary"] .compact-save').innerText(), '已保存');
  const wordStats = page.getByLabel('字数统计');
  await wordStats.getByText(/^全文 [\d,]+ 字$/).waitFor();
  await wysiwyg.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
  await wordStats.getByText('已选 4 字', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputs, '左人笔记-字数统计.png'), fullPage: true });
  await page.keyboard.press('ArrowRight');
  await wordStats.getByText('已选 0 字', { exact: true }).waitFor();
  const marker = wysiwyg.locator('.cm-md-list-marker').first();
  assert.equal(await marker.innerText(), '1.');
  assert.ok(await marker.evaluate(el => Math.abs(el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top) < 8));
  await page.screenshot({ path: path.join(outputs, '照页-文件夹浏览与列表对齐.png'), fullPage: true });
  const mainWithSidebar = await page.locator('.main').boundingBox(); assert.ok(mainWithSidebar);
  await page.locator('.sidebar-toggle').click();
  await page.locator('.sidebar').waitFor({ state: 'detached' });
  const mainWithoutSidebar = await page.locator('.main').boundingBox(); assert.ok(mainWithoutSidebar);
  assert.ok(mainWithoutSidebar.width >= mainWithSidebar.width + 240, `main area should use released sidebar width: ${JSON.stringify({ mainWithSidebar, mainWithoutSidebar })}`);
  assert.ok(mainWithoutSidebar.x < mainWithSidebar.x, `main area should move to the left edge: ${JSON.stringify({ mainWithSidebar, mainWithoutSidebar })}`);
  await page.screenshot({ path: path.join(outputs, '照页-资料栏收起.png'), fullPage: true });
  await page.getByRole('button', { name: '展开资料栏', exact: true }).click();
  assert.ok(await page.locator('.sidebar').isVisible());
  await moreAction(page, '展开大纲');
  await page.locator('.note-outline').getByRole('button', { name: '2 概念' }).click();
  await moreAction(page, '收起大纲');
  await moreAction(page, '展开大纲');
  const code = page.locator('.cm-editor'); await code.waitFor();
  assert.equal(await code.evaluate(element => getComputedStyle(element).fontSize), '18px');
  assert.equal(await page.locator('.cm-gutters').isVisible(), false);
  await code.locator('.cm-content').click(); await page.keyboard.press('Control+A');
  const codeSelection = code.locator('.cm-proseSelectionBackground:visible').first(); await codeSelection.waitFor();
  assert.notEqual(await codeSelection.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  const selectedCodeText = await code.locator('.cm-content').evaluate(element => {
    const style = getComputedStyle(element, '::selection');
    return { background: style.backgroundColor, color: style.color };
  });
  assert.notEqual(selectedCodeText.color, 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: path.join(outputs, '照页-代码选区.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '资料栏 已展开', exact: true }).count(), 0, 'sidebar control lives in the topbar, not duplicated in settings');
  await page.getByRole('button', { name: /全屏阅读.*进入/ }).waitFor();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'constructivist-dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-theme')), 'constructivist-dark');
  await page.waitForTimeout(220);
  const darkAppearance = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    topbar: getComputedStyle(document.querySelector('.topbar')).backgroundColor,
    noteContent: getComputedStyle(document.querySelector('.note-content')).backgroundColor,
    milkdown: getComputedStyle(document.querySelector('.markdown-source-editor')).backgroundColor,
    editor: getComputedStyle(document.querySelector('.markdown-source-editor .cm-content')).backgroundColor,
    text: getComputedStyle(document.querySelector('.markdown-source-editor .cm-content')).color,
    themeButton: getComputedStyle(document.querySelector('.theme-options button')).backgroundColor,
  }));
  assert.equal(darkAppearance.text, 'rgb(236, 233, 224)');
  assert.equal(darkAppearance.noteContent, 'rgb(0, 0, 0)');
  await page.screenshot({ path: path.join(outputs, '照页-黑暗模式.png'), fullPage: true });
  assert.equal(await page.getByRole('button', { name: '跟随系统', exact: true }).count(), 1);
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-theme')), 'constructivist');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'constructivist');
  const readingSize = page.getByRole('slider', { name: '正文字体大小' });
  await readingSize.fill('22');
  assert.equal(await wysiwyg.evaluate(element => getComputedStyle(element).fontSize), '22px');
  assert.equal(await code.evaluate(element => getComputedStyle(element).fontSize), '22px');
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-reading-size')), '22');
  await page.screenshot({ path: path.join(outputs, '照页-正文字号设置.png'), fullPage: true });
  await page.getByRole('button', { name: '恢复默认 18px' }).click();
  assert.equal(await wysiwyg.evaluate(element => getComputedStyle(element).fontSize), '18px');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(outputs, '照页-大纲与代码块.png'), fullPage: true });
  await moreAction(page, '收起大纲');
  await page.locator('.file-row').filter({ hasText: '对照笔记.md' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.document-tab').length === 2);
  assert.equal(await page.locator('.document-tab').count(), 2);
  await page.locator('.document-tab').filter({ hasText: '对照笔记.md' }).waitFor();
  await page.locator('.file-row').filter({ hasText: '研究笔记.md' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.document-tab').length === 2);
  assert.equal(await page.locator('.document-tab').count(), 2);
  await page.locator('.document-tab').filter({ hasText: '研究笔记.md' }).waitFor();
  await page.locator('.file-row').filter({ hasText: '对照笔记.md' }).click({ button: 'right' });
  await page.getByRole('menuitem',{name:'在右侧打开',exact:true}).click();
  const secondary = page.locator('[data-note-group="secondary"] .cm-content'); await secondary.waitFor();
  stage('dual panes ready');
  const splitEditorLayouts = await page.locator('.panes .markdown-source-editor .cm-scroller > .cm-content').evaluateAll(elements => elements.map(element => {
    const scroller = element.closest('.cm-scroller'), content = element.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
    const clientLeft = viewport.left + scroller.clientLeft, clientRight = clientLeft + scroller.clientWidth;
    return { width: content.width, paneWidth: scroller.clientWidth, centerError: Math.abs((content.left - clientLeft) - (clientRight - content.right)) };
  }));
  assert.equal(splitEditorLayouts.length, 2, 'both comparison panes should keep independent editor columns');
  for (const layout of splitEditorLayouts) {
    assert.ok(Math.abs(layout.width - Math.min(layout.paneWidth, 880)) <= 2, `split editor width: ${JSON.stringify(layout)}`);
    assert.ok(layout.centerError <= 2, `split editor centering: ${JSON.stringify(layout)}`);
  }
  await secondary.click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('第二栏独立自动保存');
  await page.waitForTimeout(1300);
  assert.match(await fs.readFile(path.join(fixtureRoot, '对照笔记.md'), 'utf8'), /第二栏独立自动保存/);
  const primaryPane = noteUI(page, 'primary');
  const secondaryPane = noteUI(page, 'secondary');
  await primaryPane.locator('.markdown-source-editor .cm-content').click();
  await page.keyboard.press('Control+f');
  await primaryPane.locator('.find-bar').waitFor();
  assert.equal(await secondaryPane.locator('.find-bar').count(), 0, 'Ctrl+F should open only the focused primary pane');
  await primaryPane.getByRole('textbox', { name: '查找文本' }).fill('第一项正文');
  await primaryPane.getByText('1 / 1', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await primaryPane.getByText('1 / 1', { exact: true }).waitFor();
  await primaryPane.getByRole('button', { name: '展开替换' }).click();
  await primaryPane.getByRole('textbox', { name: '替换为' }).waitFor();
  assert.equal(await primaryPane.getByRole('textbox', { name: '查找文本' }).inputValue(), '第一项正文', 'opening replace should preserve the search query');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '替换为');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '替换为', 'opening replace should focus the replacement input');
  await primaryPane.getByRole('button', { name: '收起替换' }).click();
  await primaryPane.getByRole('textbox', { name: '替换为' }).waitFor({ state: 'detached' });
  assert.equal(await primaryPane.getByRole('textbox', { name: '查找文本' }).inputValue(), '第一项正文', 'closing replace should preserve the search query');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '查找文本');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '查找文本', 'closing replace should restore focus to the search input');
  await page.keyboard.press('Escape');
  await primaryPane.locator('.find-bar').waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '收起资料栏', exact: true }).click();
  await page.getByRole('button', { name: '展开资料栏', exact: true }).focus();
  await page.keyboard.press('Control+f');
  assert.equal(await page.locator('.find-bar').count(), 0, 'Ctrl+F outside note panes should stay inactive');
  await page.getByRole('button', { name: '展开资料栏', exact: true }).click();

  await secondary.click(); await page.keyboard.press('Control+h');
  await secondaryPane.locator('.find-bar').waitFor();
  assert.equal(await primaryPane.locator('.find-bar').count(), 0, 'Ctrl+H should open only the focused secondary pane');
  const secondaryFind = secondaryPane.getByRole('textbox', { name: '查找文本' });
  await secondaryFind.fill('独立');
  await secondaryPane.getByText('1 / 2', { exact: true }).waitFor();
  await secondaryFind.press('Enter');
  await secondaryPane.getByText('2 / 2', { exact: true }).waitFor();
  await secondaryFind.press('Shift+Enter');
  await secondaryPane.getByText('1 / 2', { exact: true }).waitFor();
  await secondaryPane.getByRole('textbox', { name: '替换为' }).fill('独立已处理');
  await secondaryPane.getByRole('button', { name: '替换', exact: true }).click();
  await secondaryPane.getByText('1 / 2', { exact: true }).waitFor();
  await secondaryPane.getByRole('textbox', { name: '替换为' }).fill('右栏');
  await secondaryPane.getByRole('button', { name: '全部替换', exact: true }).click();
  await secondaryPane.getByText('0 / 0', { exact: true }).waitFor();
  await page.waitForTimeout(1300);
  const replacedSecondary = await fs.readFile(path.join(fixtureRoot, '对照笔记.md'), 'utf8');
  assert.match(replacedSecondary, /右栏已处理编辑和保存/);
  assert.match(replacedSecondary, /第二栏右栏自动保存/);
  assert.doesNotMatch(replacedSecondary, /独立/);
  assert.match(await fs.readFile(path.join(fixtureRoot, '研究笔记.md'), 'utf8'), /第一项正文/);
  stage('dual-pane find/replace passed');

  stage('preview: closing secondary find');
  await withTimeout('close secondary find', secondaryPane.locator('.find-bar button[aria-label="关闭查找"]').click());
  stage('preview: switching mode');
  await focusNote(page, 'primary');
  await withTimeout('switch primary to preview', primaryPane.locator('.note-toolbar button[aria-label="切换到预览"]').click());
  stage('preview: waiting for document');
  const primaryPreview = primaryPane.locator('.markdown-preview');
  await withTimeout('wait for preview', primaryPreview.waitFor());
  stage('preview: clicking document');
  await withTimeout('focus preview', primaryPreview.click());
  await primaryPreview.focus();
  stage(`preview: focused ${await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName || 'none')}`);
  stage('preview: sending shortcut');
  const shortcutAllowed = await withTimeout('dispatch Ctrl+H in preview', primaryPreview.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', ctrlKey: true, bubbles: true, cancelable: true }))));
  assert.equal(shortcutAllowed, false, 'preview Ctrl+H should be consumed by the active note pane');
  stage('preview: waiting for find bar');
  await withTimeout('wait for preview find bar', primaryPane.locator('.find-bar').waitFor());
  await primaryPane.getByRole('textbox', { name: '查找文本' }).fill('剩余价值');
  await primaryPane.getByText('1 / 1', { exact: true }).waitFor();
  await primaryPane.getByRole('button', { name: '切到编辑后替换', exact: true }).waitFor();
  assert.equal(await primaryPane.locator('.markdown-preview').count(), 1, 'Ctrl+H in preview should not switch to edit mode');
  await page.keyboard.press('Escape');
  await primaryPane.locator('.note-toolbar button[aria-label="切换到源码编辑"]').click();
  await primaryPane.locator('.markdown-source-editor .cm-content').waitFor();
  await primaryPane.locator('.note-toolbar button[aria-label="切换到预览"]').click();
  await primaryPane.locator('.markdown-preview').waitFor();
  assert.notEqual((await primaryPane.locator('.markdown-preview').innerText()).trim(), '正在排版…', 'preview should settle after a second mode switch');
  await primaryPane.locator('.note-toolbar button[aria-label="切换到源码编辑"]').click();
  await primaryPane.locator('.markdown-source-editor .cm-content').waitFor();
  stage('preview shortcut passed');

  await page.screenshot({ path: path.join(outputs, '照页-双栏笔记.png'), fullPage: true });
  await secondary.click(); await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter'); await page.keyboard.insertText('关闭分屏前也要保存');
  await page.locator('[data-note-controls="secondary"] .compact-save').filter({ hasText: '编辑中' }).waitFor();
  await moreAction(page, '关闭笔记分屏');
  await page.locator('[data-note-group="secondary"]').waitFor({ state: 'hidden' });
  await page.locator('[data-tabs-group="primary"] [role="tab"]').filter({hasText:'研究笔记.md'}).click();
  await waitForFileMatch(path.join(fixtureRoot, '对照笔记.md'), /关闭分屏前也要保存/);
  assert.match(await fs.readFile(path.join(fixtureRoot, '对照笔记.md'), 'utf8'), /关闭分屏前也要保存/);
  await wysiwyg.click(); await page.keyboard.press('Control+A');
  await page.locator('.selection-toolbar').waitFor();
  assert.equal(await page.locator('.selection-toolbar').count(), 1, 'only one selection toolbar');
  const toolbar = page.locator('.selection-toolbar');
  await toolbar.waitFor();
  const toolbarState = await toolbar.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const items = [...element.querySelectorAll('button')].map(item => {
      const itemBounds = item.getBoundingClientRect();
      return { width: itemBounds.width, height: itemBounds.height };
    });
    const style = getComputedStyle(element);
    return {
      display: style.display,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      items,
    };
  });
  assert.equal(toolbarState.display, 'flex');
  assert.ok(toolbarState.bounds.width > toolbarState.bounds.height * 2, `toolbar should be horizontal: ${JSON.stringify(toolbarState.bounds)}`);
  assert.ok(toolbarState.bounds.x > 0 && toolbarState.bounds.y > 0, `toolbar should not be at the window origin: ${JSON.stringify(toolbarState.bounds)}`);
  assert.ok(toolbarState.bounds.x + toolbarState.bounds.width <= toolbarState.viewport.width && toolbarState.bounds.y + toolbarState.bounds.height <= toolbarState.viewport.height, `toolbar should stay inside the window: ${JSON.stringify(toolbarState)}`);
  assert.ok(toolbarState.items.length >= 13 && toolbarState.items.every(item => item.width >= 24 && item.width <= 80 && item.height >= 24 && item.height <= 48), `selection toolbar items should have bounded sizes: ${JSON.stringify(toolbarState.items)}`);
  await wysiwyg.focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('WYSIWYG edit works');
  await waitForFileMatch(path.join(fixtureRoot, '研究笔记.md'), /WYSIWYG edit works/);
  await wysiwyg.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Shift+End'); await page.keyboard.insertText('自动保存验证：中文内容。');
  await waitForFileMatch(path.join(fixtureRoot, '研究笔记.md'), /自动保存验证/);
  await wysiwyg.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Shift+End'); await page.keyboard.insertText('自动保存验证：冲突后保留我的内容。');
  await page.locator('.note-toolbar .compact-save').filter({ hasText: '编辑中' }).waitFor();
  await fs.writeFile(path.join(fixtureRoot, '研究笔记.md'), '# 外部编辑器版本\n', 'utf8');
  await page.waitForSelector('text=文件发生外部修改');
  stage('conflict flow passed');
  await page.getByRole('button', { name: '保留我的内容' }).click();
  await waitForFileMatch(path.join(fixtureRoot, '研究笔记.md'), /冲突后保留我的内容/);
  await page.getByPlaceholder('搜索文件名或笔记内容').fill('自动保存验证');
  await page.getByPlaceholder('搜索文件名或笔记内容').press('Enter');
  await page.waitForSelector('text=搜索结果');
  await page.getByPlaceholder('搜索文件名或笔记内容').fill('');
  await page.getByText('研究读物.epub', { exact: false }).first().click();
  const epubFrame = page.frameLocator('.epub-viewer iframe').first();
  await epubFrame.getByText('第一章 开端').waitFor({ timeout: 20000 });
  assert.match(await epubFrame.locator('body').evaluate(element => getComputedStyle(element).fontFamily), /字体管家仿宋体 \(非商业使用\)/);
  const epubBeforeSidebar = await page.locator('.epub-viewer iframe').boundingBox(); assert.ok(epubBeforeSidebar);
  await page.getByRole('button', { name: '收起资料栏' }).first().click();
  await page.waitForTimeout(320);
  const epubAfterSidebar = await page.locator('.epub-viewer iframe').boundingBox(); assert.ok(epubAfterSidebar);
  assert.ok(epubAfterSidebar.width > epubBeforeSidebar.width + 100, `EPUB 阅读区域应跟随资料栏收起而变宽: before=${epubBeforeSidebar.width}, after=${epubAfterSidebar.width}`);
  const epubSplitLayout = await epubFrame.locator('body').evaluate(element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { bodyWidth: bounds.width, columnWidth: Number.parseFloat(style.columnWidth), columnGap: Number.parseFloat(style.columnGap) };
  });
  assert.ok(epubSplitLayout.bodyWidth > 0 && epubSplitLayout.columnWidth >= epubSplitLayout.bodyWidth * .7, `分屏 EPUB 应自动退回单页: ${JSON.stringify(epubSplitLayout)}`);
  assert.equal(await page.getByRole('button', { name: /标注/ }).getAttribute('aria-expanded'), 'false');
  assert.ok(await page.locator('.epub-reader-shell').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'EPUB 阅读区不应出现横向溢出');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await page.waitForTimeout(320);
  const epubReadLayout = await epubFrame.locator('body').evaluate(element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { bodyWidth: bounds.width, columnWidth: Number.parseFloat(style.columnWidth), columnGap: Number.parseFloat(style.columnGap) };
  });
  assert.ok(epubReadLayout.bodyWidth > 0 && epubReadLayout.columnWidth > 0 && epubReadLayout.columnWidth < epubReadLayout.bodyWidth * .7, `宽屏 EPUB 应使用双页排版: ${JSON.stringify(epubReadLayout)}`);
  await page.getByRole('button', { name: '展开资料栏' }).first().click();
  await page.waitForTimeout(320);
  await epubFrame.locator('body').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('ArrowRight');
  await epubFrame.getByText('第二章 继续阅读').waitFor({ timeout: 20000 });
  await page.waitForTimeout(240);
  await page.keyboard.press('ArrowLeft');
  await epubFrame.getByText('第一章 开端').waitFor({ timeout: 20000 });
  await page.waitForTimeout(240);
  await page.locator('.epub-viewer').hover();
  await page.mouse.wheel(0, 240);
  await epubFrame.getByText('第二章 继续阅读').waitFor({ timeout: 20000 });
  await page.waitForTimeout(240);
  await page.mouse.wheel(0, -240);
  await epubFrame.getByText('第一章 开端').waitFor({ timeout: 20000 });
  await page.waitForTimeout(240);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const epubSize = page.getByRole('slider', { name: '正文字体大小', exact: true });
  await epubSize.focus(); await epubSize.press('ArrowRight');
  const sharedSize = await epubSize.inputValue();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.epub-pane')?.dataset.reflowing === 'false');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await epubFrame.getByText('第二章 继续阅读').waitFor({ timeout: 20000 });
  stage('epub navigation passed');
  await page.screenshot({ path: path.join(outputs, '照页-EPUB预览.png'), fullPage: true });
  await page.waitForTimeout(1000);
  const sidecars = (await fs.readdir(path.join(fixtureRoot, '.reader'))).filter(name => name.endsWith('.epub.json'));
  assert.equal(sidecars.length, 1);
  const epubMeta = JSON.parse(await fs.readFile(path.join(fixtureRoot, '.reader', sidecars[0]), 'utf8'));
  assert.match(epubMeta.cfi, /^epubcfi\(/);
  assert.equal(epubMeta.fontSize, 100, 'legacy field is retained; the shared setting owns typography');
  await page.locator('.file-row').filter({ hasText: '研究笔记.md' }).click();
  await page.getByText('研究读物.epub', { exact: false }).first().click();
  await page.frameLocator('.epub-viewer iframe').first().getByText('第二章 继续阅读').waitFor({ timeout: 20000 });
  assert.equal(await page.frameLocator('.epub-viewer iframe').first().locator('p').first().evaluate(element => getComputedStyle(element).fontSize), sharedSize + 'px');
  await page.getByText('研究资料.pdf', { exact: false }).first().click();
  await page.waitForSelector('canvas');
  await page.waitForFunction(() => (document.querySelector('canvas')?.width || 0) > 500);
  const pdfResolution = await page.locator('[data-pdf-page="1"] canvas').evaluate(canvas => {
    const bounds = canvas.getBoundingClientRect();
    return { backingWidth: canvas.width, backingHeight: canvas.height, cssWidth: bounds.width, cssHeight: bounds.height, devicePixelRatio: window.devicePixelRatio };
  });
  const expectedOutputScale = Math.min(3, Math.max(1, pdfResolution.devicePixelRatio || 1));
  assert.ok(Math.abs(pdfResolution.backingWidth / pdfResolution.cssWidth - expectedOutputScale) < .02, `PDF canvas should render at display pixel density: ${JSON.stringify(pdfResolution)}`);
  assert.ok(Math.abs(pdfResolution.backingHeight / pdfResolution.cssHeight - expectedOutputScale) < .02, `PDF canvas height should render at display pixel density: ${JSON.stringify(pdfResolution)}`);
  assert.equal(await page.locator('[data-pdf-page]').count(), 2);
  await page.getByRole('button', { name: '在 PDF 中查找' }).click();
  const pdfFind = page.getByRole('textbox', { name: 'PDF 查找文本' });
  await pdfFind.fill('Page 2');
  await page.getByText('1 / 1', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="当前页码"]').value === '2');
  await page.waitForFunction(() => document.querySelectorAll('.pdf-search-hit').length > 0);
  const pdfFindLayout = await page.evaluate(() => {
    const pane = document.querySelector('.pdf-pane').getBoundingClientRect();
    const bar = document.querySelector('.pdf-find-bar').getBoundingClientRect();
    const controls = [...document.querySelector('.pdf-find-bar').children].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    const span = [...document.querySelectorAll('[data-pdf-page="2"] .textLayer span')].find(element => element.textContent.includes('Page 2'));
    const node = span?.firstChild;
    const start = node?.textContent.indexOf('Page 2') ?? -1;
    const range = document.createRange();
    if (node && start >= 0) { range.setStart(node, start); range.setEnd(node, start + 6); }
    const match = range.getBoundingClientRect();
    const hit = document.querySelector('[data-pdf-page="2"] .pdf-search-hit').getBoundingClientRect();
    const canvas = document.querySelector('[data-pdf-page="2"] canvas').getBoundingClientRect();
    return {
      barInsidePane: bar.left >= pane.left - 1 && bar.right <= pane.right + 1,
      controlsInsideBar: controls.every(rect => rect.left >= bar.left - 1 && rect.right <= bar.right + 1),
      fullMatchCovered: hit.left <= match.left + 1 && hit.right >= match.right - 1,
      matchAlignedWithCanvas: match.left > canvas.left + canvas.width * .39 && match.right < canvas.right,
      metrics: { matchLeft: match.left, matchRight: match.right, canvasLeft: canvas.left, canvasWidth: canvas.width, hitLeft: hit.left, hitRight: hit.right, spanFontSize: getComputedStyle(span).fontSize, spanTransform: getComputedStyle(span).transform, layerScale: getComputedStyle(span.parentElement).getPropertyValue('--total-scale-factor') },
    };
  });
  await page.screenshot({ path: path.join(outputs, '左人笔记-PDF搜索修正.png'), fullPage: true });
  assert.ok(pdfFindLayout.barInsidePane && pdfFindLayout.controlsInsideBar && pdfFindLayout.fullMatchCovered && pdfFindLayout.matchAlignedWithCanvas, `PDF search geometry should align with the canvas: ${JSON.stringify(pdfFindLayout)}`);
  await pdfFind.press('Escape');
  await page.locator('.pdf-find-bar').waitFor({ state: 'detached' });
  stage('pdf find passed');
  await page.getByRole('button', { name: '展开 PDF 大纲' }).click();
  await page.locator('.pdf-outline').getByRole('button', { name: 'Chapter two' }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="当前页码"]').value === '2');
  stage('pdf navigation passed');
  const visiblePdfPage = () => page.evaluate(() => {
    const host = document.querySelector('.pdf-canvas-wrap');
    if (!host) return 0;
    const probe = host.getBoundingClientRect().top + 80;
    return Number([...host.querySelectorAll('[data-pdf-page]')].find(element => element.getBoundingClientRect().bottom > probe)?.getAttribute('data-pdf-page') || 0);
  });
  const pageBeforeZoom = await page.locator('input[aria-label="当前页码"]').inputValue();
  assert.equal(pageBeforeZoom, '2', '缩放回归应先稳定在第 2 页');
  assert.equal(await visiblePdfPage(), Number(pageBeforeZoom));
  const pdfScroll = page.locator('.pdf-canvas-wrap');
  const ctrlWheelPrevented = await pdfScroll.evaluate(element => !element.dispatchEvent(new WheelEvent('wheel', {
    deltaY: -120,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })));
  assert.equal(ctrlWheelPrevented, true, 'Ctrl+滚轮缩放应阻止浏览器页面缩放');
  await page.locator('.zoom-control').getByText('115%', { exact: true }).waitFor();
  await page.waitForTimeout(240);
  const afterZoomPage = await page.locator('input[aria-label="当前页码"]').inputValue();
  const afterZoomVisible = await visiblePdfPage();
  assert.equal(afterZoomPage, pageBeforeZoom, `Ctrl+滚轮放大后应保持当前页 (visible=${afterZoomVisible})`);
  assert.equal(afterZoomVisible, Number(pageBeforeZoom), `Ctrl+滚轮放大后视口应仍位于当前页 (field=${afterZoomPage})`);
  await pdfScroll.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', {
    deltaY: 120,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })));
  await page.locator('.zoom-control').getByText('100%', { exact: true }).waitFor();
  await page.waitForTimeout(240);
  assert.equal(await page.locator('input[aria-label="当前页码"]').inputValue(), pageBeforeZoom, 'Ctrl+滚轮缩小后应保持当前页');
  assert.equal(await visiblePdfPage(), Number(pageBeforeZoom), 'Ctrl+滚轮缩小后视口应仍位于当前页');
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    globalThis.__fullscreenAudit = [];
    for (const event of ['enter-full-screen', 'leave-full-screen']) win.on(event, () => globalThis.__fullscreenAudit.push({ event, state: win.isFullScreen() }));
  });
  await page.getByRole('button', { name: '进入全屏阅读' }).evaluate(button => { window.__fullscreenClicks = 0; button.addEventListener('click', () => window.__fullscreenClicks++); });
  await page.getByRole('button', { name: '进入全屏阅读' }).click();
  try { await page.getByRole('button', { name: '退出全屏阅读' }).waitFor(); }
  catch (error) {
    console.error('[fullscreen-audit]', await application.evaluate(({ BrowserWindow }) => ({ state: BrowserWindow.getAllWindows()[0].isFullScreen(), events: globalThis.__fullscreenAudit })), await page.evaluate(() => ({ clicks: window.__fullscreenClicks, label: document.querySelector('.zoom-control button:last-child')?.getAttribute('aria-label') })));
    throw error;
  }
  await page.waitForFunction(() => document.querySelector('.app').dataset.fullscreen === 'true');
  await page.keyboard.press('F6'); // Fullscreen deliberately hides reader controls until revealed.
  await page.waitForFunction(() => document.querySelector('.app').dataset.chromeVisible === 'true');
  await page.getByRole('button', { name: '退出全屏阅读' }).click();
  await page.getByRole('button', { name: '进入全屏阅读' }).waitFor();
  await page.screenshot({ path: path.join(outputs, '照页-PDF连续阅读.png'), fullPage: true });
  await page.locator('.pdf-outline').getByRole('button', { name: 'Chapter one' }).click();
  await page.getByRole('button', { name: '收起 PDF 大纲' }).click();
  const regionButton = page.locator('.pdf-tools button').filter({ hasText: '框选' });
  await regionButton.click();
  const canvas = page.locator('canvas').first();
  const drawLayer = page.locator('[data-pdf-page="1"] .draw-layer.interactive'); await drawLayer.waitFor();
  const bounds = await drawLayer.boundingBox(); assert.ok(bounds);
  await page.mouse.move(bounds.x + 80, bounds.y + 80); await page.mouse.down(); await page.mouse.move(bounds.x + 250, bounds.y + 155); await page.mouse.up();
  await page.screenshot({ path: path.join(outputs, 'after-drag.png'), fullPage: true });
  await page.waitForSelector('.selection-box');
  await page.getByRole('button', { name: '保存图片摘录' }).click();
  await page.waitForTimeout(1800);
  const markdown = await fs.readFile(path.join(fixtureRoot, '研究笔记.md'), 'utf8');
  assert.match(markdown, /reader-anchor-/); assert.match(markdown, /attachments\//);
  await page.getByRole('button', { name: '切换到预览' }).click();
  await page.getByRole('link', { name: '回到原文' }).click();
  await page.waitForSelector('.annotation.flash');
  const previewImage = page.locator('.markdown-preview img');
  await previewImage.waitFor();
  assert.ok(await previewImage.evaluate(image => image.complete && image.naturalWidth > 0));
  await page.getByRole('button', { name: '切换到源码编辑' }).click();
  await page.locator('.markdown-source-editor .cm-content').waitFor();
  assert.match(await fs.readFile(path.join(fixtureRoot, '研究笔记.md'), 'utf8'), /reader-anchor-/);
  if (process.env.ZHAOYE_SMOKE_OCR === '1') {
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await regionButton.click(); await drawLayer.waitFor();
  const nextBounds = await drawLayer.boundingBox(); assert.ok(nextBounds);
  await page.mouse.move(nextBounds.x + 310, nextBounds.y + 60); await page.mouse.down(); await page.mouse.move(nextBounds.x + 540, nextBounds.y + 160); await page.mouse.up();
  await page.waitForSelector('.selection-box');
  await page.getByRole('button', { name: '识别文字并摘录' }).click();
  stage('ocr started');
  await page.waitForSelector('.ocr-dialog textarea', { timeout: 90000 });
  const recognized = await page.locator('.ocr-dialog textarea').inputValue();
  assert.ok(recognized.trim().length > 2);
  await page.getByRole('button', { name: '确认并插入文字' }).click();
  }
  await page.getByRole('button', { name: '切换到预览' }).click();
  const finalPreview = page.locator('.markdown-preview');
  await finalPreview.waitFor();
  await page.waitForFunction(() => document.querySelector('.markdown-preview')?.textContent?.includes('自动保存验证'));
  const previewState = await finalPreview.evaluate(element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    const pane = element.closest('.note-content').getBoundingClientRect();
    const column = element.querySelector(':scope > p')?.getBoundingClientRect();
    return { text: element.textContent, htmlLength: element.innerHTML.length, fontFamily: style.fontFamily, color: style.color, width: bounds.width, height: bounds.height, rightInset: pane.right - bounds.right, columnWidth: column?.width ?? 0 };
  });
  assert.match(previewState.text || '', /自动保存验证/);
  assert.match(previewState.fontFamily, /字体管家仿宋体 \(非商业使用\)/);
  assert.ok(previewState.htmlLength > 20 && previewState.width > 300 && previewState.height > 300);
  assert.ok(previewState.rightInset <= 2, `preview scrollbar area should reach the pane's right edge: ${JSON.stringify(previewState)}`);
  assert.ok(previewState.columnWidth > 0 && previewState.columnWidth <= 882, `reading column remains centered and comfortably narrow: ${previewState.columnWidth}`);
  await page.screenshot({ path: path.join(outputs, '照页-预览.png'), fullPage: true });
  if (!process.env.ZHAOYE_CDP_URL) {
    await launchSecondInstance(executablePath, path.join(fixtureRoot, '对照笔记.md'));
    await page.locator('.document-tab.foreground-tab').filter({ hasText: '对照笔记.md' }).waitFor();
    await page.locator('.markdown-source-editor .cm-content').locator('.cm-line').filter({ hasText: '对照笔记' }).waitFor();
    await page.locator('.markdown-source-editor .cm-content').getByText('右栏已处理编辑和保存。', { exact: true }).waitFor();
  }
  assert.deepEqual(rendererErrors, []);
});
