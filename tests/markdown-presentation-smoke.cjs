const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const { noteUI } = require('./noteUi.cjs');
const root = path.resolve(__dirname, '..');
const source = 'cursor\n\n> ```js\n> first\n>\n>   第二行😀\n> ```\n\n> | A | B |\n> | :--- | ---: |\n> | **加粗** | target😀 |\n\n> outer\n> > inner\n> > > deepest\n\n#### Heading four\n\n##### Heading five\n\n###### Heading six\n\n## **Outline** `code` &amp; ##\n\n\\*literal\\* &amp; &#x1F600;\n\ncontrol A&#10;B\n\n```text\n\\*literal\\* &amp;\n```\n';

test('nested Markdown presentation maps clicks to source and preserves paste, outline, undo and saved content', { timeout: 90000 }, async t => {
  const workspace = await createSmokeWorkspace('markdown-presentation'); let app;
  const errors = [];
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const note = path.join(workspace.fixture, 'structure.md'), pasteNote = path.join(workspace.fixture, 'paste.md'), outlineNote = path.join(workspace.fixture, 'outline.md');
    const outlineSource = '<h2 data-zuoren-heading="fake:2">HTML heading</h2>\n\n## <span id="first-md"></span>Same heading\n\n<h2>Another HTML heading</h2>\n\n<span id="second-md"></span>Same heading\n---\n\n> ## Quoted heading\n\n~~~md\n## Code only\n~~~\n';
    const pasteBase = '# Paste base\n';
    await fs.writeFile(note, source); await fs.writeFile(pasteNote, pasteBase);
    await fs.writeFile(outlineNote, outlineSource);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    const launch = async file => {
      app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
        args: packaged ? [file] : [root, file], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
      assert.equal(await app.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
      const page = await app.firstWindow(); page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      return page;
    };
    let page = await launch(workspace.fixture);
    const row = name => page.locator('.file-row').filter({ has: page.getByText(name, { exact: true }) });
    await row('structure.md').dblclick();
    let pane = noteUI(page, 'primary'), content = pane.locator('.cm-content'); await content.waitFor();
    const quotedCode = () => pane.locator('.cm-md-block-wrapper[data-quote-depth="1"] .cm-md-code-preview code');
    const table = () => pane.locator('.cm-md-table table');
    const sourceText = async () => {
      await content.focus(); await page.keyboard.press('Control+a');
      const value = await content.evaluate(el => { const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })); return data.getData('text/markdown'); });
      await page.keyboard.press('Control+Home'); return value;
    };
    const point = (locator, needle) => locator.evaluate((el, needle) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) {
        const offset = node.textContent.indexOf(needle); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect(); return { x: rect.left + Math.min(1, rect.width / 10), y: rect.top + rect.height / 2 };
      }
      throw Error('Pointer text not found: ' + needle);
    }, needle);
    const toPreview = async () => { await pane.getByRole('button', { name: '切换到预览', exact: true }).click(); await pane.locator('.markdown-preview:not(.preview-loading)').waitFor(); };
    const toEdit = async () => { await pane.getByRole('button', { name: '切换到源码编辑', exact: true }).click(); await content.waitFor(); };

    await t.test('inactive code/table retain all content, while quote depths and literal display follow their source context', async () => {
      assert.equal(await quotedCode().textContent(), 'first\n\n  第二行😀');
      assert.equal(await table().count(), 1);
      assert.equal(await table().locator('td').first().innerText(), '加粗');
      assert.match(await table().locator('td').last().evaluate(el => getComputedStyle(el).textAlign), /(?:^|-)right$/);
      const depths = await content.locator('.cm-md-quote').evaluateAll(lines => lines.filter(line => /outer|inner|deepest/.test(line.textContent)).map(line => ({ depth: Number(line.dataset.quoteDepth), padding: parseFloat(getComputedStyle(line).paddingLeft) })));
      assert.deepEqual(depths.map(line => line.depth), [1, 2, 3]);
      assert.ok(depths[2].padding > depths[1].padding && depths[1].padding > depths[0].padding);
      assert.equal(await content.locator('.cm-md-code-preview code').filter({ hasText: '&amp;' }).textContent(), '\\*literal\\* &amp;', 'code is never entity-decoded or reformatted');
      assert.ok((await content.innerText()).includes('*literal* & 😀'), 'inactive prose decodes escapes and entities');
      const control = await content.locator('.cm-line').filter({ hasText: 'control A' }).evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
      assert.ok(control.height < control.line * 1.5, 'decoded newline entities do not introduce untracked CodeMirror line breaks');
      assert.equal(await content.locator('.cm-line.cm-md-quote').filter({ hasText: /^\s*$/ }).count(), 0, 'rendered blocks do not leave an orphan quote line');
      assert.equal(await sourceText(), source);
    });

    await t.test('real second-line code clicks and formatted table-cell clicks edit the correct original UTF-16 position', async () => {
      for (let cycle = 0; cycle < 2; cycle++) for (const [target, needle, offset] of [[quotedCode(), '二', source.indexOf('第二行') + 1], [table().locator('td').first().locator('strong'), '粗', source.indexOf('加粗') + 1]]) {
        await target.scrollIntoViewIfNeeded(); const at = await point(target, needle);
        await page.mouse.click(at.x, at.y); await page.keyboard.insertText('X');
        const expected = source.slice(0, offset) + 'X' + source.slice(offset);
        await waitForFile(note, value => value === expected);
        await content.focus();
        assert.equal(await content.evaluate(el => el === document.activeElement), true, 'undo is sent to this exact note editor');
        await page.keyboard.press('Control+z'); await waitForFile(note, value => value === source);
        await content.focus(); await page.keyboard.press('Control+Home');
      }
      assert.equal(await sourceText(), source);
      for (const target of [quotedCode(), table().locator('td').first()]) {
        await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox();
        await page.mouse.move(box.x + 3, box.y + 8); await page.mouse.down(); await page.mouse.move(box.x + Math.min(65, box.width - 3), box.y + 8, { steps: 5 }); await page.mouse.up();
        assert.equal(await pane.getByRole('toolbar', { name: '选中文本格式' }).count(), 0, 'dragging a rendered block does not select its entire Markdown source');
      }
      const entity = content.locator('.cm-md-literal').filter({ hasText: /^&$/ }).last();
      await entity.scrollIntoViewIfNeeded(); await entity.click();
      assert.equal(await page.evaluate(() => window.getSelection()?.isCollapsed), true, 'a decoded entity click places a caret rather than selecting its paragraph');
      await page.keyboard.insertText('Z');
      const inserted = await waitForFile(note, text => text.length === source.length + 1 && text.replace('Z', '') === source);
      const entityPosition = source.indexOf('&amp;', source.indexOf('\\*literal\\*'));
      assert.ok([entityPosition, entityPosition + 5].includes(inserted.indexOf('Z')), 'the caret maps to a source entity boundary');
      await content.focus(); await page.keyboard.press('Control+z');
      assert.equal(await sourceText(), source, 'entering decoded prose never rewrites its escape/entity syntax');
    });

    await t.test('heading metrics and outline labels agree across modes and remain usable in a narrow dark window', async () => {
      const metrics = () => content.locator('.cm-md-heading').evaluateAll(headings => headings.filter(el => /Heading (four|five|six)/.test(el.textContent)).map(el => ({ text: el.textContent.trim(), size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight, line: getComputedStyle(el).lineHeight })));
      const edit = await metrics();
      await pane.getByRole('button', { name: '展开大纲', exact: true }).click();
      const outline = pane.getByRole('complementary', { name: 'Markdown 大纲', exact: true });
      await outline.getByRole('button', { name: /Outline code &/ }).waitFor();
      const labels = await outline.locator('button > span').allTextContents();
      assert.ok(labels.includes('Outline code &')); assert.equal(labels.some(text => /\*\*|##|&amp;/.test(text)), false);
      await toPreview();
      const read = await pane.locator('.markdown-preview :is(h4,h5,h6)').evaluateAll(headings => headings.map(el => ({ text: el.textContent.trim(), size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight, line: getComputedStyle(el).lineHeight })));
      assert.deepEqual(read, edit);
      assert.deepEqual(await outline.locator('button > span').allTextContents(), labels);
      await outline.getByRole('button', { name: /Outline code &/ }).click();
      await toEdit();
      await pane.getByRole('button', { name: '收起大纲', exact: true }).click();
      await content.focus(); await page.keyboard.press('Control+Home');
      const screenshots = process.env.ZUOREN_SCREENSHOT_OUTPUT;
      if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, 'nested-markdown-light.png') }); }
      await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '深色', exact: true }).click(); await page.keyboard.press('Escape');
      const size = await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setSize(Math.max(900, window.getMinimumSize()[0]), 760); return window.getContentSize(); });
      await page.waitForFunction(([width, height]) => window.innerWidth === width && window.innerHeight === height, size);
      await quotedCode().waitFor(); assert.equal(await quotedCode().textContent(), 'first\n\n  第二行😀');
      assert.equal(await table().count(), 1);
      if (screenshots) await page.locator('.app').screenshot({ path: path.join(screenshots, 'nested-markdown-dark-narrow.png') });
      assert.equal(await sourceText(), source);
    });

    await t.test('HTML ordered-list paste retains nested tasks, quotes/code, zero and multi-digit numbering; one undo restores the note', async () => {
      await row('paste.md').dblclick(); await content.waitFor();
      for (const start of [0, 1, 9, 10]) {
        const html = '<ol start="' + start + '"><li><p>parent</p><ul><li><input type="checkbox" checked>nested task</li></ul></li><li><p>next</p><pre><code>a\n\nb</code></pre><blockquote><p>quoted</p></blockquote></li></ol>';
        await content.focus(); await page.keyboard.press('Control+a');
        await content.evaluate((el, html) => { const data = new DataTransfer(); data.setData('text/html', html); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, html);
        await toPreview();
        const list = pane.locator('.markdown-preview > ol'); await list.waitFor();
        assert.equal(await list.locator(':scope > li').count(), 2);
        assert.equal(Number(await list.getAttribute('start') ?? 1), start);
        assert.equal(await list.locator(':scope > li > ul input[type="checkbox"]').count(), 1);
        assert.equal(await list.locator(':scope > li:nth-child(2) pre code').textContent(), 'a\n\nb\n');
        assert.equal(await list.locator(':scope > li:nth-child(2) blockquote').count(), 1);
        await toEdit(); await content.focus(); await page.keyboard.press('Control+z');
        await waitForFile(pasteNote, text => text === pasteBase);
        assert.equal(await sourceText(), pasteBase, 'the entire rich paste is one undo transaction');
      }
    });
    await t.test('mixed HTML/Markdown outline jumps target source headings, including duplicate labels', async () => {
      await row('outline.md').dblclick(); await content.waitFor(); await toPreview();
      await pane.getByRole('button', { name: '展开大纲', exact: true }).click();
      const outline = pane.getByRole('complementary', { name: 'Markdown 大纲', exact: true });
      await outline.locator('button').nth(2).waitFor();
      assert.equal(await outline.locator('button').count(), 3, 'raw HTML and code headings do not enter the source outline');
      const preview = pane.locator('.markdown-preview');
      await preview.evaluate(element => {
        window.__outlineScroll = [];
        for (const heading of element.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
          const original = heading.scrollIntoView;
          heading.scrollIntoView = function (options) { window.__outlineScroll.push({ id: this.querySelector('[id]')?.id, text: this.textContent }); original.call(this, options); };
        }
      });
      for (const [index, id] of ['first-md', 'second-md'].entries()) {
        await outline.locator('button').nth(index).click();
        assert.equal(await page.evaluate(() => window.__outlineScroll.at(-1)?.id), id, 'outline clicks must not land on HTML or another same-named heading');
      }
      await outline.locator('button').nth(2).click();
      assert.equal(await page.evaluate(() => window.__outlineScroll.at(-1)?.text.trim()), 'Quoted heading');
      await toEdit(); await outline.locator('button').nth(1).click();
      assert.ok((await content.locator('.cm-activeLine').innerText()).includes('second-md'), 'editing jumps to the same source heading');
      assert.equal(await sourceText(), outlineSource);
      assert.equal(await fs.readFile(outlineNote, 'utf8'), outlineSource, 'outline navigation never changes stored Markdown');
    });
    await row('structure.md').dblclick(); assert.equal(await sourceText(), source); await waitForFile(note, value => value === source);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await app.waitForEvent('close'); app = undefined;
    page = await launch(note); pane = noteUI(page, 'primary'); content = pane.locator('.cm-content'); await content.waitFor();
    assert.equal(await sourceText(), source, 'cold reopen retains exact original Markdown');
    assert.deepEqual(errors, []);
  } finally {
    const child = app?.process();
    try { await Promise.race([app?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
