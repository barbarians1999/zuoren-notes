const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const JSZip = require('jszip');
const { _electron, readerReady } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');

test('EPUB shares tabs, typography and outline while close failures preserve its session', { timeout: 90000 }, async () => {
  const workspace = await createSmokeWorkspace('epub-workspace'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const note = path.join(workspace.fixture, 'note.md');
    const originalNote = '# 笔记标题\n\n保留笔记的编辑与撤销。\n';
    await fs.writeFile(note, originalNote);
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">workspace-book</dc:identifier><dc:title>阅读札记</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-10-09T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
    zip.file('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">第一章</a></li><li><a href="two.xhtml">第二章</a><ol><li><a href="two.xhtml#middle">第二章中段</a></li></ol></li></ol></nav></body></html>');
    const headingFixtures = Array.from({ length: 6 }, (_, i) => `<h${i + 1}><span style="font-family: sans-serif"><em style="font-family: monospace">${i === 0 ? '第一章' : '标题层级' + (i + 1)}</em></span></h${i + 1}>`).join('');
    zip.file('one.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body>${headingFixtures}<p>阅读正文和笔记使用统一字号。</p></body></html>`);
    const paragraphs = Array.from({ length: 36 }, (_, i) => `<p>第${i}段。${'阅读材料需要保留原来的位置，不能因为调整字号回到章节开头。'.repeat(6)}</p>`).join('');
    zip.file('two.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章</h1>${paragraphs}<h2 id="middle">第二章中段</h2><p>中段定位标记，调整字号仍在这里。</p>${paragraphs}</body></html>`);
    const epubBytes = await zip.generateAsync({ type: 'nodebuffer' });
    const book = path.join(workspace.fixture, 'book.epub'); await fs.writeFile(book, epubBytes);
    const id = createHash('sha256').update(epubBytes).digest('hex');
    const metaPath = path.join(workspace.fixture, '.reader', id + '.epub.json');
    await fs.mkdir(path.dirname(metaPath));
    await fs.writeFile(metaPath, JSON.stringify({ version: 2, id, cfi: '', progress: 0, fontSize: 150, annotations: [] }));
    const root = path.resolve(__dirname, '..');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    if (packaged) assert.equal(await app.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    const capture = async name => {
      if (!process.env.ZHAOYE_THEME_SCREENSHOTS) return;
      await fs.mkdir(process.env.ZHAOYE_THEME_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ZHAOYE_THEME_SCREENSHOTS, name + '.png') });
    };
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('EPUB workspace page error:', error.stack); });
    await page.locator('.file-row').filter({ hasText: 'note.md' }).dblclick();
    const editor = page.locator('.cm-content'); await editor.waitFor();
    await editor.evaluate(element => { window.__epubWorkspaceEditor = element; });
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('UNDO-PRESERVED');
    await page.locator('.file-row').filter({ hasText: 'book.epub' }).click();
    await readerReady(page, 'epub');
    const bar = page.locator('.note-workspace-bar'), readerTab = page.getByRole('tab', { name: 'book.epub', exact: true });
    const assertCompactReaderTab = async () => {
      const geometry = await page.locator('[data-reader-tab="epub"]').evaluate(tab => {
        const bounds = tab.getBoundingClientRect(), style = getComputedStyle(tab);
        const name = tab.querySelector('.tab-file-name'), close = tab.lastElementChild;
        return {
          width: bounds.width, maxWidth: parseFloat(style.maxWidth), grow: style.flexGrow,
          closeGap: close.getBoundingClientRect().left - name.getBoundingClientRect().right,
        };
      });
      assert.equal(geometry.grow, '0', 'reader tab does not stretch across the header');
      assert.ok(Number.isFinite(geometry.maxWidth) && geometry.width <= geometry.maxWidth + 1, 'reader tab uses the shared note-tab width limit');
      assert.ok(geometry.closeGap >= 0 && geometry.closeGap <= 24, 'close button stays beside the filename');
    };
    await assertCompactReaderTab();
    const tabName = page.locator('[data-reader-tab="epub"] .tab-file-name');
    await tabName.evaluate(element => { element.textContent = 'A-very-long-book-filename-that-must-not-stretch-the-tab.epub'; });
    await assertCompactReaderTab();
    assert.equal(await tabName.evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === 'ellipsis'), true, 'long filenames truncate within the tab');
    await tabName.evaluate(element => { element.textContent = 'book.epub'; });
    assert.equal(await readerTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.epub-foot, .epub-pane progress').count(), 0, 'the bottom progress row is removed');
    assert.equal(await page.locator('.reader-document-title, .epub-font-control, .epub-navigation select, .epub-navigation .epub-chapter, .epub-navigation .keyboard-hints').count(), 0);
    const bounds = await bar.boundingBox(), epubBounds = await page.locator('.epub-pane').boundingBox();
    const tabBounds = await readerTab.boundingBox(), noteBounds = await page.getByRole('tab', { name: 'note.md', exact: true }).boundingBox();
    assert.equal(bounds.height, 40); assert.equal(epubBounds.y, bounds.y + bounds.height);
    assert.equal(tabBounds.y, noteBounds.y, 'book and note tabs occupy the same row');
    const paragraphSize = () => page.frameLocator('.epub-viewer iframe').first().locator('p').first().evaluate(element => getComputedStyle(element).fontSize);
    const anchorVisible = cfi => page.locator('.epub-viewer').evaluate((viewer, cfi) => {
      const bounds = viewer.getBoundingClientRect();
      const steps = cfi.split('!')[1].replace(/\).*/, '').split('/').filter(Boolean);
      return [...viewer.querySelectorAll('iframe')].some(frame => {
        const doc = frame.contentDocument;
        let node = doc?.documentElement;
        for (const step of steps) {
          // A layout change may briefly expose an empty or different-spine
          // iframe. It is not proof that the saved text is visible yet.
          if (!node) return false;
          const index = parseInt(step, 10);
          node = index % 2 ? [...node.childNodes].filter(n => n.nodeType === 3)[(index - 1) / 2] : node.children[index / 2 - 1];
        }
        const offset = Number(steps.at(-1).split(':')[1] || 0);
        if (!node || node.nodeType !== 3 || offset < 0 || offset >= node.textContent.length) return false;
        const range = doc.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const local = range.getBoundingClientRect(), outer = frame.getBoundingClientRect();
        return outer.left + local.left < bounds.right && outer.left + local.right > bounds.left &&
          outer.top + local.top < bounds.bottom && outer.top + local.bottom > bounds.top;
      });
    }, cfi);
    const waitForAnchor = async (cfi, message) => {
      const deadline = Date.now() + 3500; let visibleSince = 0;
      while (Date.now() < deadline) {
        if (await anchorVisible(cfi)) {
          visibleSince ||= Date.now();
          if (Date.now() - visibleSince >= 300) return;
        } else visibleSince = 0;
        await page.waitForTimeout(50);
      }
      const detail = await page.locator('.epub-viewer').evaluate((viewer, cfi) => ({
        cfi, bounds: viewer.getBoundingClientRect().toJSON(), reflowing: viewer.closest('.epub-pane')?.dataset.reflowing,
        frames: [...viewer.querySelectorAll('iframe')].map(frame => ({ bounds: frame.getBoundingClientRect().toJSON(),
          scrollX: frame.contentWindow?.scrollX, scrollY: frame.contentWindow?.scrollY,
          text: frame.contentDocument?.body?.textContent?.slice(0, 120) }))
      }), cfi);
      assert.fail(message + ': ' + JSON.stringify(detail));
    };
    assert.equal(await paragraphSize(), '18px', 'legacy book percentage does not override the global size');
    const headingFonts = await page.frameLocator('.epub-viewer iframe').first().locator('body').evaluate(async body => {
      await document.fonts.ready;
      const headings = [...body.querySelectorAll('h1, h2, h3, h4, h5, h6')];
      return {
        levels: headings.length,
        allSerif: headings.every(heading => {
          const family = getComputedStyle(heading).fontFamily;
          return family.startsWith('"Zhaoye Heading"') && [...heading.querySelectorAll('*')].every(child => getComputedStyle(child).fontFamily === family);
        }),
        loaded: [...document.fonts].some(font => font.family === 'Zhaoye Heading' && font.status === 'loaded'),
        bodyFont: getComputedStyle(body).fontFamily,
      };
    });
    assert.equal(headingFonts.levels, 6);
    assert.equal(headingFonts.allSerif, true, 'all heading levels and nested title text use the bundled Source Han Serif');
    assert.equal(headingFonts.loaded, true, 'the heading font is actually loaded, not merely listed in CSS');
    assert.ok(!headingFonts.bodyFont.includes('Zhaoye Heading'), 'heading typography does not replace the selected body font');
    const observeOutlineLayout = async () => {
      await page.locator('.epub-viewer').evaluate(viewer => {
        window.__outlineResizeObserver?.disconnect(); window.__outlineMutationObserver?.disconnect();
        const rect = viewer.getBoundingClientRect();
        window.__outlineViewport = { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
        window.__outlineFrames = [...viewer.querySelectorAll('iframe')].map(frame => ({ frame, document: frame.contentDocument }));
        window.__outlineResizes = 0; window.__outlineMutations = 0;
        window.__outlineObservedSize = null;
        window.__outlineResizeObserver = new ResizeObserver(entries => {
          const { width, height } = entries[0].contentRect;
          // The initial notification is not a resize. Compare content-box
          // measurements to each other, not to rounded border-box geometry.
          const previous = window.__outlineObservedSize;
          if (previous && (previous.width !== width || previous.height !== height)) window.__outlineResizes++;
          window.__outlineObservedSize = { width, height };
        });
        window.__outlineMutationObserver = new MutationObserver(records => { window.__outlineMutations += records.length; });
        window.__outlineResizeObserver.observe(viewer);
        window.__outlineMutationObserver.observe(viewer, { childList: true, subtree: true });
      });
      await page.waitForFunction(() => !!window.__outlineObservedSize);
    };
    const assertOutlineLayout = async () => {
      const state = await page.locator('.epub-viewer').evaluate(viewer => {
        const rect = viewer.getBoundingClientRect();
        return {
          geometry: { width: rect.width, height: rect.height, x: rect.x, y: rect.y },
          original: window.__outlineViewport, resizes: window.__outlineResizes, mutations: window.__outlineMutations,
          sameFrames: window.__outlineFrames.length === viewer.querySelectorAll('iframe').length && window.__outlineFrames.every(({ frame, document }) => viewer.contains(frame) && frame.contentDocument === document),
        };
      });
      assert.deepEqual(state.geometry, state.original, 'outline motion never changes the reading viewport');
      assert.equal(state.resizes, 0, 'outline does not trigger viewport resize');
      assert.equal(state.mutations, 0, 'outline does not replace or repaginate book views');
      assert.equal(state.sameFrames, true, 'the same book documents remain mounted');
    };
    await observeOutlineLayout();
    await page.getByRole('button', { name: '展开 EPUB 大纲', exact: true }).click();
    const outline = page.getByRole('complementary', { name: 'EPUB 大纲', exact: true });
    await outline.waitFor();
    await outline.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    await assertOutlineLayout();
    await page.getByRole('button', { name: '收起 EPUB 大纲', exact: true }).click();
    await outline.waitFor({ state: 'hidden' }); await assertOutlineLayout();
    await page.getByRole('button', { name: '展开 EPUB 大纲', exact: true }).click();
    await outline.getByRole('button', { name: '第二章中段', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.epub-pane')?.dataset.currentChapter === '第二章');
    await waitForFile(metaPath, text => JSON.parse(text).cfi.includes('/6/4'));
    const beforeSize = JSON.parse(await fs.readFile(metaPath, 'utf8')).cfi;
    await waitForAnchor(beforeSize, 'the mid-chapter text anchor is visible before closing the outline');
    await observeOutlineLayout();
    await page.getByRole('button', { name: '收起 EPUB 大纲', exact: true }).click();
    await outline.waitFor({ state: 'hidden' });
    await assertOutlineLayout();
    assert.equal(JSON.parse(await fs.readFile(metaPath, 'utf8')).cfi, beforeSize, 'closing the overlay does not relocate the book');
    // Search and outline share the overlay area rather than covering each other.
    await page.getByRole('button', { name: '展开 EPUB 大纲', exact: true }).click();
    await page.getByRole('button', { name: '在 EPUB 中查找', exact: true }).click();
    await page.locator('.epub-search-panel').waitFor(); await outline.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '展开 EPUB 大纲', exact: true }).click();
    await page.locator('.epub-search-panel').waitFor({ state: 'detached' });
    await outline.evaluate(element => {
      for (const animation of element.getAnimations()) { animation.pause(); animation.currentTime = 0; }
    });
    await outline.getByRole('button', { name: '第二章', exact: true }).focus();
    await assertOutlineLayout();
    await outline.evaluate(element => { for (const animation of element.getAnimations()) animation.finish(); });
    await page.keyboard.press('Escape'); await outline.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '展开 EPUB 大纲', exact: true }).evaluate(button => button === document.activeElement), true, 'closing a focused outline returns focus to its toggle');
    await assertOutlineLayout();
    await waitForAnchor(beforeSize, 'the mid-chapter text anchor is visible before resizing');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const slider = page.getByRole('slider', { name: '正文字体大小', exact: true });
    // Return native keyboard input from the EPUB iframe to the settings widget.
    await slider.click(); await slider.press('End');
    for (let i = 0; i < 6; i++) await slider.press('ArrowLeft');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.epub-pane')?.dataset.reflowing === 'false');
    assert.equal(await paragraphSize(), '22px');
    assert.equal(await editor.evaluate(element => getComputedStyle(element).fontSize), '22px');
    assert.equal(await page.locator('.epub-pane').getAttribute('data-current-chapter'), '第二章');
    const afterSize = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    assert.equal(afterSize.fontSize, 150, 'old metadata remains compatible without overwriting its legacy field');
    assert.equal(afterSize.cfi.split('!')[0], beforeSize.split('!')[0], 'size changes stay in the original spine section');
    await waitForAnchor(beforeSize, 'reflow retains the exact mid-chapter text anchor, not merely the chapter');
    await capture('epub-unified-split');
    // EPUB previews the divider while the pointer is held, retaining the exact
    // iframe/documents; a release commits one new reading width.
    await observeOutlineLayout();
    const splitter = page.getByRole('separator', { name: '调整阅读与笔记宽度', exact: true });
    const divider = await splitter.boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 90); await page.mouse.down();
    await page.mouse.move(divider.x + divider.width / 2 + 60, divider.y + 90, { steps: 10 });
    await page.locator('.splitter-preview').waitFor();
    await assertOutlineLayout();
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.splitter-preview') && document.querySelector('.epub-pane')?.dataset.reflowing === 'false');
    await waitForAnchor(beforeSize, 'committed divider resize retains the exact book text anchor');
    assert.equal(await editor.evaluate(el => el === window.__epubWorkspaceEditor), true, 'resizing keeps the note editor instance');
    await splitter.dblclick();
    await page.waitForFunction(() => document.querySelector('.epub-pane')?.dataset.reflowing === 'false');
    await waitForAnchor(beforeSize, 'double-click balanced panes retain the same text anchor');
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setBounds({ width: 960, height: 640 }); });
    await page.getByRole('button', { name: '展开 EPUB 大纲', exact: true }).click();
    await outline.waitFor();
    await outline.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    const narrowPanel = await outline.boundingBox(), narrowPane = await page.locator('.epub-pane').boundingBox();
    await assertCompactReaderTab();
    assert.ok(narrowPanel.x >= narrowPane.x && narrowPanel.x + narrowPanel.width <= narrowPane.x + narrowPane.width + 1, 'outline stays inside its narrow reader column');
    assert.ok(narrowPanel.width >= Math.min(180, narrowPane.width - 16), 'overlay keeps a usable outline width without shrinking the book');
    for (const control of await page.locator('.epub-header-actions button').all()) {
      const rect = await control.boundingBox();
      assert.ok(rect.x >= narrowPane.x && rect.x + rect.width <= narrowPane.x + narrowPane.width, 'reader actions remain accessible in their own column');
    }
    await capture('epub-unified-split-narrow');
    await page.getByRole('button', { name: '收起 EPUB 大纲', exact: true }).click(); await outline.waitFor({ state: 'hidden' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 900 }));
    await page.waitForFunction(() => innerWidth >= 1279 && !document.querySelector('.epub-outline'));
    await waitForAnchor(beforeSize, 'narrow-window and outline reflow retain the original text anchor');
    await editor.click();
    assert.equal(await readerTab.getAttribute('aria-selected'), 'false');
    await readerTab.click(); assert.equal(await readerTab.getAttribute('aria-selected'), 'true');
    await app.evaluate(() => {
      const { createRequire } = process.mainModule.require('node:module');
      const load = createRequire(process.mainModule.require('electron').app.getAppPath() + '/package.json');
      const { FileStore } = load('./electron/storage.cjs'), original = FileStore.prototype.saveEpub;
      FileStore.prototype.saveEpub = async function () { FileStore.prototype.saveEpub = original; throw Error('injected EPUB close failure'); };
    });
    const close = page.getByRole('button', { name: '关闭 book.epub', exact: true });
    await close.click();
    await page.getByText('阅读进度或标注尚未保存成功，资料仍保留，请重试关闭。', { exact: true }).waitFor();
    assert.equal(await readerTab.count(), 1); assert.equal(await page.locator('.epub-pane').count(), 1);
    await close.click(); await page.locator('.epub-pane').waitFor({ state: 'detached' });
    const savedAnchor = JSON.parse(await fs.readFile(metaPath, 'utf8')).cfi;
    assert.equal(await readerTab.count(), 0);
    assert.equal(await page.locator('.app').getAttribute('data-layout'), 'note');
    assert.equal(await editor.evaluate(element => element === window.__epubWorkspaceEditor), true);
    await editor.press('Control+z'); await waitForFile(note, text => !text.includes('UNDO-PRESERVED'));
    assert.equal(await fs.readFile(note, 'utf8'), originalNote);
    await page.locator('.file-row').filter({ hasText: 'book.epub' }).click();
    await page.waitForFunction(() => !document.querySelector('.epub-loading') && !!document.querySelector('.epub-viewer iframe') && document.querySelector('.epub-pane')?.dataset.currentChapter === '第二章');
    assert.equal(await paragraphSize(), '22px');
    assert.equal(await page.locator('.epub-pane').getAttribute('data-current-chapter'), '第二章', 'reopen restores the saved chapter');
    await waitForAnchor(savedAnchor, 'reopen restores the exact saved text, not just its chapter');
    assert.equal(JSON.parse(await fs.readFile(metaPath, 'utf8')).cfi, savedAnchor, 'reopening must retain the saved semantic anchor for the next layout change');
    await page.locator('.layout-tabs').getByRole('button', { name: '阅读', exact: true }).click();
    assert.equal(await readerTab.getAttribute('aria-selected'), 'true');
    assert.equal(await bar.boundingBox().then(rect => rect.height), 40);
    assert.equal(await page.getByRole('tab', { name: 'note.md', exact: true }).count(), 0, 'reading-only hides note chrome without closing its document');
    await page.waitForFunction(() => document.querySelector('.epub-viewer').getBoundingClientRect().width > 900);
    await assertCompactReaderTab();
    await waitForAnchor(savedAnchor, 'reading-only layout retains the saved text anchor');
    await capture('epub-unified-read-only');
    await readerTab.focus(); await page.keyboard.press('Control+w');
    await page.locator('.epub-pane').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('tab', { name: 'note.md', exact: true }).count(), 1, 'reader Ctrl+W does not close a note');
    assert.deepEqual(await fs.readFile(book), epubBytes);
    assert.deepEqual(errors, []);
  } finally {
    const child = app?.process();
    try { await Promise.race([app?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
