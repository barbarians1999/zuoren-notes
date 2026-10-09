const { noteUI, focusNote, moreAction } = require('./noteUi.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const JSZip = require('jszip');
const { _electron } = require('playwright');
const { THEMES } = require('../src/appearanceTheme.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const { assertGlyphActions } = require('./chromeAssertions.cjs');
const appRoot = path.resolve(__dirname, '..');
const labels = { constructivist: '浅色', 'constructivist-paper': '纸页红', 'constructivist-dark': '深色' };
const custom = Object.keys(THEMES);
let workspace, application;
const rgb = hex => 'rgb(' + hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16)).join(', ') + ')';

async function stopApplication() {
  const app = application; application = undefined;
  if (!app) return;
  const child = app.process();
  try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 5000))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
async function launchApplication() {
  const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
  application = await _electron.launch({
    executablePath: packaged || path.join(appRoot, 'node_modules/electron/dist/electron.exe'),
    args: packaged ? [workspace.fixture] : [appRoot, workspace.fixture],
    env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData },
  });
  if (packaged) {
    const version = require('../package.json').version;
    assert.deepEqual(await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() })), { packaged: true, version });
  }
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  await page.locator('.topbar').waitFor();
  await page.waitForFunction(async () => (await window.reader.getWindowState()).maximized);
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setBounds({ width: 1280, height: 900 });
  });
  return page;
}
async function openSettings(page) {
  if (!await page.locator('.settings-popover').count()) await page.getByRole('button', { name: '设置', exact: true }).click();
}
async function chooseTheme(page, name) {
  await openSettings(page);
  const button = page.getByRole('button', { name: labels[name], exact: true });
  await button.click();
  await page.waitForFunction(name => document.documentElement.dataset.theme === name && document.querySelector('.app')?.dataset.theme === name, name);
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-theme')), name);
}
async function openEditor(page) {
  await page.keyboard.press('Escape');
  await page.locator('.file-row').filter({ hasText: 'theme.md' }).click();
  const pane = noteUI(page, 'primary');
  if (await pane.locator('.markdown-preview').count()) await pane.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
  await pane.locator('.cm-content').waitFor();
  return pane.locator('.cm-content');
}
async function screenshot(page, name) {
  if (!process.env.ZHAOYE_THEME_SCREENSHOTS) return;
  await fs.mkdir(process.env.ZHAOYE_THEME_SCREENSHOTS, { recursive: true });
  // Let the existing 140 ms button transitions finish before visual QA.
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(process.env.ZHAOYE_THEME_SCREENSHOTS, name + '.png') });
}
async function resizeWindow(page, width, height) {
  // Windows scaling can round outer bounds by a CSS pixel. Wait for the
  // actual Electron content size, not the requested outer window size.
  const contentSize = await application.evaluate(({ BrowserWindow }, bounds) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds(bounds);
    return window.getContentSize();
  }, { width, height });
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, contentSize);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function fixtures() {
  workspace = await createSmokeWorkspace('themes-smoke');
  await fs.mkdir(workspace.fixture, { recursive: true });
  await fs.mkdir(workspace.userData, { recursive: true });
  const original = '# 主题与阅读\n\n保留连续 Markdown 编辑和 Live Preview。\n\n## 编辑体验\n\n**粗体**、*斜体*、~~删除线~~、==高亮==和 [链接](https://example.com)。\n\n> 引用与正文都应清晰可读。\n\n1. 有序列表\n2. 编辑方式不变\n\n- [ ] 待办事项\n\n| 功能 | 状态 |\n| --- | --- |\n| 保存与撤销 | 保留 |\n\n```js\nconst theme = "可自由切换";\n```\n\n---\n\n末尾正文\n';
  await fs.writeFile(path.join(workspace.fixture, 'theme.md'), original, 'utf8');
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) document.addPage([595, 842]).drawText('Theme test - page ' + n, { font, x: 72, y: 750, size: 22 });
  await fs.writeFile(path.join(workspace.fixture, 'theme.pdf'), await document.save());
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">theme-audit</dc:identifier><dc:title>Theme audit</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  zip.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">第一章</a></li><li><a href="two.xhtml">第二章</a></li></ol></nav></body></html>');
  for (const [file, title] of [['one', '第一章'], ['two', '第二章']]) {
    zip.file('OEBPS/' + file + '.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + title + '</title><style>p { color: #000; } span { color: #000; }</style></head><body><h1>' + title + ' 阅读与主题</h1><p>EPUB 内页与软件界面采用一致的配色。<span>仿宋字体与阅读位置保持不变。</span></p><blockquote>不同配色不改变书籍内容。</blockquote><p><a href="one.xhtml">章节链接</a> 与 <code>代码</code>。</p></body></html>');
  }
  await fs.writeFile(path.join(workspace.fixture, 'theme.epub'), await zip.generateAsync({ type: 'nodebuffer' }));
  return original;
}

after(async () => { await stopApplication(); if (workspace) await cleanupSmokeWorkspace(workspace); });

test('themes persist, share reader colors and preserve editing history, PDF paper and EPUB position', { timeout: 240000 }, async () => {
  const original = await fixtures(), notePath = path.join(workspace.fixture, 'theme.md');
  let page = await launchApplication();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let editor = await openEditor(page);
  await editor.evaluate(element => { window.__themeEditor = element; });
  const originalMetrics = await editor.evaluate(element => {
    const css = getComputedStyle(element); return { font: css.fontFamily, size: css.fontSize, leading: css.lineHeight, width: css.maxWidth };
  });
  await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nTHEME-UNDO');
  for (const [name, theme] of Object.entries(THEMES)) {
    await chooseTheme(page, name);
    assert.equal(await page.locator('.theme-options button').count(), 4);
    if (name === 'constructivist-dark') {
      for (const selector of ['.topbar', '.sidebar', '.note-workspace-bar', '.note-content', '.cm-editor']) {
        assert.equal(await page.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)', selector);
      }
    }
    const colors = await page.evaluate(() => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      return { background: css('.cm-editor').backgroundColor, text: css('.cm-content').color,
        settings: css('.settings-popover').backgroundColor, sidebar: css('.sidebar').backgroundColor,
        scheme: getComputedStyle(document.documentElement).colorScheme, sameEditor: window.__themeEditor === document.querySelector('.cm-content') };
    });
    assert.deepEqual(colors, { background: rgb(theme.colors.surface), text: rgb(theme.colors.text),
      settings: rgb(theme.colors.surface), sidebar: rgb(theme.colors.sidebar), scheme: theme.colorScheme, sameEditor: true }, name);
    assert.deepEqual(await editor.evaluate(element => {
      const css = getComputedStyle(element); return { font: css.fontFamily, size: css.fontSize, leading: css.lineHeight, width: css.maxWidth };
    }), originalMetrics, 'theme does not alter document typography');
    // Color transitions finish after the theme identity has already changed.
    const expectedControls = { background: rgb(theme.colors['mode-bg']), color: rgb(theme.colors['on-mode']), radius: '2px' };
    await page.waitForFunction(expected => {
      const css = getComputedStyle(document.querySelector('.layout-tabs button.active'));
      return css.backgroundColor === expected.background && css.color === expected.color;
    }, expectedControls);
    const controls = await page.locator('.layout-tabs button.active').evaluate(button => {
      const css = getComputedStyle(button); return { background: css.backgroundColor, color: css.color, radius: css.borderTopLeftRadius };
    });
    assert.deepEqual(controls, expectedControls, 'both themes keep clear, square active controls');
    await page.mouse.move(1, 1);
    await page.waitForFunction(expected => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      return css('.settings-menu > .quiet-action').color === expected.ink
        && css('.window-controls > button').color === expected.ink
        && css('.file-row.selected').backgroundColor === expected.selected;
    }, { ink: rgb(theme.colors['topbar-text']), selected: rgb(theme.colors['selected-row-bg']) });
    const visualRoles = await page.evaluate(() => {
      const style = selector => getComputedStyle(document.querySelector(selector));
      const md = style('.file-icon.md'), epub = style('.file-icon.epub');
      return {
        topbar: style('.topbar').backgroundColor,
        topbarAction: style('.settings-menu > .quiet-action').color,
        windowControl: style('.window-controls > button').color,
        selectedFile: style('.file-row.selected').backgroundColor,
        workspaceHead: style('.markdown-workspace-head').backgroundColor,
        newNoteBackground: style('.top-actions .new-note-action').backgroundColor,
        markdownIcon: { background: md.backgroundColor, color: md.color },
        epubIcon: { background: epub.backgroundColor, color: epub.color },
        headingDecoration: style('.cm-md-heading').textDecorationLine,
        quoteBackground: style('.cm-md-quote').backgroundColor,
        codeRadius: style('.cm-md-code-preview').borderTopLeftRadius,
      };
    });
    assert.deepEqual(visualRoles, {
      topbar: rgb(theme.colors['topbar-bg']),
      topbarAction: rgb(theme.colors['topbar-text']),
      windowControl: rgb(theme.colors['topbar-text']),
      selectedFile: rgb(theme.colors['selected-row-bg']),
      workspaceHead: rgb(theme.colors.chrome), newNoteBackground: rgb(theme.colors['action-bg']),
      markdownIcon: { background: 'rgba(0, 0, 0, 0)', color: rgb(theme.colors.accent) },
      epubIcon: { background: rgb(theme.colors['epub-icon-bg']), color: rgb(theme.colors['epub-icon-text']) },
      headingDecoration: 'none', quoteBackground: 'rgba(0, 0, 0, 0)', codeRadius: '2px',
    }, 'theme chrome follows the reference palette without tinting Markdown badges');
    const bounds = await page.locator('.settings-popover').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, 'settings remain in view');
    if (custom.includes(name)) {
      await page.keyboard.press('Escape');
      await page.locator('.cm-scroller').evaluate(element => { element.scrollTop = 0; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      await screenshot(page, name + '-editor');
      if (custom.includes(name)) {
        await resizeWindow(page, 960, 640);
        await screenshot(page, name + '-editor-narrow');
        await resizeWindow(page, 1280, 900);
      }
    }
    await page.keyboard.press('Escape');
    await assertGlyphActions(page, page.locator('.note-controls-slot .workspace-mode-switch button, .note-controls-slot .workspace-icon-action'));
    await page.locator('.file-row').filter({ hasText: 'theme.md' }).click({ button: 'right' });
    const menu = page.getByRole('menu'); await menu.waitFor();
    assert.equal(await menu.evaluate(element => getComputedStyle(element).backgroundColor), rgb(theme.colors.surface));
    assert.equal(await menu.getByRole('menuitem').first().evaluate(element => getComputedStyle(element).color), rgb(theme.colors.text));
    if (custom.includes(name)) {
      assert.deepEqual(await menu.evaluate(element => ({ radius: getComputedStyle(element).borderTopLeftRadius, shadow: getComputedStyle(element).boxShadow })),
        { radius: '2px', shadow: 'none' });
      await screenshot(page, name + '-menu');
      if (name === 'constructivist-dark') {
        // Force a fresh pointer entry after screenshots/native window resizing;
        // hovering the same coordinates can retain a stale Chromium hover path.
        await page.bringToFront(); await page.mouse.move(1, 1);
        const item = menu.getByRole('menuitem').first(); await item.hover();
        await page.waitForFunction(color => getComputedStyle(document.querySelector('[role="menuitem"]')).color === color, rgb(theme.colors['hover-text']));
        assert.equal(await item.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
        assert.notEqual(await item.evaluate(el => getComputedStyle(el).boxShadow), 'none', 'night hover has an explicit marker');
      }
    }
    await page.keyboard.press('Escape');
  }
  await editor.click(); await page.keyboard.press('Control+z');
  assert.doesNotMatch(await editor.innerText(), /THEME-UNDO/, 'theme changes retain undo history');
  assert.equal(await waitForFile(notePath, text => text === original), original);
  const beforeStat = await fs.stat(notePath);
  await noteUI(page, 'primary').getByRole('button', { name: '切换到预览', exact: true }).click();
  const preview = page.locator('.note-pane[data-pane-id="primary"] .markdown-preview'); await preview.waitFor();
  for (const name of custom) {
    await chooseTheme(page, name); await page.keyboard.press('Escape');
    assert.equal(await preview.evaluate(element => getComputedStyle(element).color), rgb(THEMES[name].colors.text));
    assert.equal(await preview.locator('h1').evaluate(element => getComputedStyle(element).color), rgb(THEMES[name].colors.heading));
    assert.equal(await preview.locator('a').evaluate(element => getComputedStyle(element).color), rgb(THEMES[name].colors.link));
    assert.equal(await preview.locator('mark').evaluate(element => getComputedStyle(element).color), rgb(THEMES[name].colors['mark-text']));
    if (custom.includes(name)) await screenshot(page, name + '-preview');
  }

  await page.locator('.file-row').filter({ hasText: 'theme.pdf' }).click();
  await page.waitForFunction(() => document.querySelector('[data-pdf-page="1"] canvas')?.width > 0);
  const pageNumber = page.getByRole('textbox', { name: '当前页码' });
  await pageNumber.fill('2'); await pageNumber.press('Enter');
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-pdf-page="2"] canvas');
    return canvas?.width > 0 && canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255
      && document.querySelector('[aria-label="当前页码"]')?.value === '2';
  });
  await page.evaluate(() => { window.__themePdfCanvas = document.querySelector('[data-pdf-page="2"] canvas'); });
  const beforePdf = await page.evaluate(() => {
    const canvas = window.__themePdfCanvas;
    return { width: canvas.width, height: canvas.height, paper: [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data] };
  });
  for (const name of custom) {
    await chooseTheme(page, name); await page.keyboard.press('Escape');
    assert.equal(await pageNumber.inputValue(), '2');
    assert.equal(await page.evaluate(() => window.__themePdfCanvas === document.querySelector('[data-pdf-page="2"] canvas')), true);
    const pdf = await page.evaluate(() => {
      const canvas = window.__themePdfCanvas;
      return { width: canvas.width, height: canvas.height, paper: [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data] };
    });
    assert.equal(pdf.width, beforePdf.width); assert.equal(pdf.height, beforePdf.height);
    assert.deepEqual(pdf.paper, name === 'constructivist-dark' ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    assert.equal(await page.locator('[data-pdf-page="2"] .canvas-holder').evaluate(element => getComputedStyle(element).backgroundColor), name === 'constructivist-dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
    assert.equal(await page.locator('.pdf-navigation').evaluate(bar => bar.getBoundingClientRect().height), 40);
    await assertGlyphActions(page, page.locator('.pdf-navigation button'));
    await screenshot(page, name + '-pdf');
    await resizeWindow(page, 960, 640);
    await screenshot(page, name + '-pdf-narrow');
    await resizeWindow(page, 1280, 900);
  }
  await resizeWindow(page, 960, 640);
  await screenshot(page, 'constructivist-dark-pdf-narrow');
  assert.equal(await pageNumber.inputValue(), '2', 'restyling and narrow layout keep the selected PDF page');
  await resizeWindow(page, 1280, 900);

  await page.locator('.file-row').filter({ hasText: 'theme.epub' }).click();
  await page.getByRole('button', { name: '展开 EPUB 大纲', exact: true }).click();
  const toc = page.getByRole('complementary', { name: 'EPUB 大纲', exact: true });
  await toc.getByRole('button', { name: '第二章', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.epub-viewer iframe')].some(frame => frame.contentDocument?.body?.textContent?.includes('第二章 阅读与主题')));
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__themeFrame = [...document.querySelectorAll('.epub-viewer iframe')].find(frame => frame.contentDocument?.body?.textContent?.includes('第二章 阅读与主题'));
    window.__themeBookDocument = window.__themeFrame.contentDocument;
  });
  const beforeEpub = await page.evaluate(() => ({ chapter: document.querySelector('.epub-chapter').textContent,
    font: window.__themeFrame.contentWindow.getComputedStyle(window.__themeBookDocument.body).fontFamily, text: window.__themeBookDocument.body.textContent }));
  for (const name of custom) {
    await chooseTheme(page, name); await page.keyboard.press('Escape');
    await page.waitForFunction(color => {
      const frame = window.__themeFrame;
      return frame.contentWindow.getComputedStyle(frame.contentDocument.body).backgroundColor === color;
    }, rgb(THEMES[name].colors.surface));
    const book = await page.evaluate(() => {
      const doc = window.__themeFrame.contentDocument, css = element => window.__themeFrame.contentWindow.getComputedStyle(element);
      return { chapter: document.querySelector('.epub-chapter').textContent, font: css(doc.body).fontFamily, text: doc.body.textContent,
        sameDocument: doc === window.__themeBookDocument, background: css(doc.body).backgroundColor, color: css(doc.querySelector('p')).color,
        span: css(doc.querySelector('p span')).color, heading: css(doc.querySelector('h1')).color, link: css(doc.querySelector('a')).color,
        styleCount: doc.querySelectorAll('#zuoren-notes-epub-theme').length };
    });
    assert.deepEqual(book, { ...beforeEpub, sameDocument: true, background: rgb(THEMES[name].colors.surface), color: rgb(THEMES[name].colors.text),
      span: rgb(THEMES[name].colors.text), heading: rgb(THEMES[name].colors.heading), link: rgb(THEMES[name].colors.link), styleCount: 1 }, name);
    assert.equal(await page.frameLocator('.epub-viewer iframe').first().locator('h1').evaluate(async heading => {
      await document.fonts.ready;
      const family = getComputedStyle(heading).fontFamily;
      return family === getComputedStyle(parent.document.querySelector('.markdown-preview h1')).fontFamily
        && [...document.fonts].some(font => font.family === 'Zhaoye Heading' && font.status === 'loaded');
    }), true, 'EPUB headings load the same bundled serif as Markdown, without changing the body font');
    const chrome = await page.locator('.epub-viewer').evaluate(viewer => ({ shadow: getComputedStyle(viewer).boxShadow,
      radius: getComputedStyle(viewer).borderTopLeftRadius, toolbar: document.querySelector('.epub-navigation').getBoundingClientRect().height }));
    assert.deepEqual(chrome, { shadow: 'none', radius: '0px', toolbar: 39 });
    assert.equal(await page.locator('.epub-reader-shell').evaluate(shell => {
      const css = getComputedStyle(shell), viewer = shell.querySelector('.epub-viewer'), inner = getComputedStyle(viewer);
      return css.padding === '0px' && css.backgroundColor === inner.backgroundColor && inner.borderTopWidth === '0px';
    }), true, 'EPUB reads on one surface without a gray mat or page frame');
    await assertGlyphActions(page, page.locator('.epub-header-actions button'));
    if (custom.includes(name)) await screenshot(page, name + '-epub');

  }
  await resizeWindow(page, 960, 640);
  for (const name of custom) {
    await chooseTheme(page, name); await page.keyboard.press('Escape');
    await screenshot(page, name + '-epub-narrow');
  }
  await resizeWindow(page, 1280, 900);
  assert.equal(await fs.readFile(notePath, 'utf8'), original);
  assert.equal((await fs.stat(notePath)).mtimeMs, beforeStat.mtimeMs, 'appearance changes do not rewrite notes');

  await chooseTheme(page, 'constructivist');
  await page.keyboard.press('Escape');
  await toc.getByRole('button', { name: '第一章', exact: true }).click();
  await page.waitForFunction(color => [...document.querySelectorAll('.epub-viewer iframe')].some(frame => {
    const doc = frame.contentDocument;
    return doc?.body?.textContent?.includes('第一章 阅读与主题')
      && frame.contentWindow.getComputedStyle(doc.body).backgroundColor === color
      && frame.contentWindow.getComputedStyle(doc.querySelector('h1')).color === 'rgb(23, 23, 23)';
  }), rgb(THEMES.constructivist.colors.surface));
  await resizeWindow(page, 960, 640);
  await openSettings(page);
  const compactSettings = await page.locator('.settings-popover').boundingBox();
  const compactViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(compactSettings.x >= 0 && compactSettings.x + compactSettings.width <= compactViewport.width
    && compactSettings.y + compactSettings.height <= compactViewport.height, 'all theme choices fit at the minimum window size');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'constructivist', 'explicit palette ignores system changes');
  assert.equal(await page.getByRole('button', { name: '跟随系统', exact: true }).count(), 1);
  assert.equal(await page.locator('.theme-options button').count(), 4);
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'constructivist');
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-theme')), 'system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'constructivist-dark');
  assert.equal(await page.getByRole('button', { name: '跟随系统', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.reload(); await page.locator('.topbar').waitFor(); await openSettings(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-theme')), 'system', 'system remains a preference across restart');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'constructivist');
  for (const name of custom) {
    await chooseTheme(page, name); await page.keyboard.press('Escape');
    await page.reload(); await page.locator('.topbar').waitFor(); await openSettings(page);
    assert.equal(await page.getByRole('button', { name: labels[name], exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), name);
  }
  await stopApplication(); page = await launchApplication(); await openSettings(page);
  assert.equal(await page.getByRole('button', { name: '深色', exact: true }).getAttribute('aria-pressed'), 'true', 'cold start restores theme');
  await page.evaluate(() => localStorage.setItem('zhaoye-theme', 'invalid-theme'));
  await page.emulateMedia({ colorScheme: 'light' }); await page.reload(); await page.locator('.topbar').waitFor(); await openSettings(page);
  assert.equal(await page.getByRole('button', { name: '浅色', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'constructivist');

  for (const [saved, scheme, expected] of [
    ['light', 'dark', 'constructivist'], ['blue-white', 'dark', 'constructivist'], ['red-white', 'dark', 'constructivist'],
    ['dark', 'light', 'constructivist-dark'], ['red-black', 'light', 'constructivist-dark'],
    ['system', 'dark', 'constructivist-dark'], ['system', 'light', 'constructivist'],
    ['constructivist-paper', 'dark', 'constructivist-paper'],
  ]) {
    await page.evaluate(value => localStorage.setItem('zhaoye-theme', value), saved);
    await page.emulateMedia({ colorScheme: scheme }); await page.reload(); await page.locator('.topbar').waitFor();
    await page.waitForFunction(({ name, saved }) => document.documentElement.dataset.theme === name && localStorage.getItem('zhaoye-theme') === (saved === 'system' ? 'system' : name), { name: expected, saved });
    await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
    const switched = saved === 'system' ? (scheme === 'dark' ? 'constructivist' : 'constructivist-dark') : expected;
    await page.waitForFunction(name => document.documentElement.dataset.theme === name, switched);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), switched, saved + ' respects the preference');
  }
  await chooseTheme(page, 'constructivist');
  const storageErrors = []; page.on('pageerror', error => storageErrors.push(error.message));
  await page.evaluate(() => {
    window.__themeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'zhaoye-theme') throw new DOMException('test theme write fault', 'QuotaExceededError');
      return window.__themeSetItem.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.getByText('主题已更改，但无法保存；下次启动时可能恢复原设置。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'constructivist-dark');
  await page.evaluate(() => { Storage.prototype.setItem = window.__themeSetItem; });
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === 'zhaoye-theme') throw new DOMException('test theme read fault', 'SecurityError');
      return get.call(this, key);
    };
  });
  await page.reload(); await page.locator('.topbar').waitFor(); await openSettings(page);
  assert.equal(await page.getByRole('button', { name: '浅色', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []); assert.deepEqual(storageErrors, []);
});
