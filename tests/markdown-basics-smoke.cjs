const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const root = path.resolve(__dirname, '..'), tick = String.fromCharCode(96);
const source = ['cursor', '', '**BoldA** and *ItalicB* and ~~StrikeC~~', '', '- [ ] Task body', '',
  'a\\', 'b', '', tick + '  x  ' + tick, '', tick + 'a', 'b' + tick, '', '> ' + tick + 'a', '> b' + tick, '',
  '- ' + tick + 'a', '  b' + tick, '', tick + 'x😀y' + tick, '', '| H😀 | B |', '| --- | --- |', '| 中😀 | end |', ''].join('\n');

test('basic Markdown live display, local activation, tasks and table navigation preserve the source', { timeout: 90000 }, async t => {
  const workspace = await createSmokeWorkspace('markdown-basics'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const file = path.join(workspace.fixture, 'basics.md'); await fs.writeFile(file, source);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('.file-row').filter({ hasText: 'basics.md' }).dblclick();
    const content = page.locator('.cm-content'); await content.waitFor();
    const home = async () => { await content.focus(); await page.keyboard.press('Control+Home'); };
    const copied = async () => {
      await content.focus(); await page.keyboard.press('Control+A');
      const text = await content.evaluate(el => {
        const data = new DataTransfer();
        el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
        return data.getData('text/markdown');
      });
      await home(); return text;
    };
    await home();
    await t.test('hard breaks and inline-code normalization agree with reading mode without changing raw bytes', async () => {
      await page.waitForFunction(() => document.querySelectorAll('.cm-md-inline-code-content').length === 5);
      const codes = await content.locator('.cm-md-inline-code-content').allTextContents();
      assert.deepEqual(codes, [' x ', 'a b', 'a b', 'a b', 'x😀y']);
      assert.equal(await content.locator('.cm-line').filter({ hasText: /^a\\$/ }).count(), 0, 'hard-break marker is hidden');
      assert.equal(await copied(), source);
      await page.getByRole('button', { name: '切换到预览', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.markdown-preview')?.dataset.previewCurrent === 'true');
      assert.deepEqual(await page.locator('.markdown-preview code').allTextContents(), codes);
      await page.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
      await home();
    });
    await t.test('a real inline-code click maps a UTF-16 display offset to the original source', async () => {
      const code = content.locator('.cm-md-inline-code-content').filter({ hasText: 'x😀y' });
      await code.scrollIntoViewIfNeeded();
      const point = await code.evaluate(el => {
        const range = document.createRange(); range.setStart(el.firstChild, 3); range.setEnd(el.firstChild, 4);
        const box = range.getBoundingClientRect(); return { x: box.left + Math.min(1, box.width / 10), y: box.top + box.height / 2 };
      });
      await page.mouse.click(point.x, point.y); await page.keyboard.type('!');
      const offset = source.indexOf('x😀y') + 3;
      await waitForFile(file, text => text === source.slice(0, offset) + '!' + source.slice(offset));
      await page.keyboard.press('Control+Z');
      await waitForFile(file, text => text === source);
      await home();
    });
    await t.test('moving inside one inline format leaves its neighbors rendered', async () => {
      await content.locator('.cm-md-strong').filter({ hasText: 'BoldA' }).click();
      const line = content.locator('.cm-line').filter({ hasText: 'BoldA' });
      assert.match(await line.textContent(), /\*\*BoldA\*\*/);
      assert.doesNotMatch(await line.textContent(), /\*ItalicB\*|~~StrikeC~~/);
      assert.equal(await line.locator('.cm-md-emphasis').count(), 1);
      assert.equal(await copied(), source);
    });
    await t.test('dragging from rendered inline code selects text instead of the whole source construct', async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
      await home();
      const code = content.locator('.cm-md-inline-code-content').filter({ hasText: 'x😀y' });
      await code.scrollIntoViewIfNeeded();
      const start = await code.evaluate(el => {
        const range = document.createRange(); range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, 1);
        const box = range.getBoundingClientRect(); return { x: box.left + 1, y: box.top + box.height / 2 };
      });
      await page.evaluate(() => {
        window.__inlineDragTrace = [];
        window.__inlineDragObserve = event => window.__inlineDragTrace.push({ type: event.type, buttons: event.buttons,
          x: event.clientX, selected: window.getSelection()?.toString(), active: !!document.querySelector('.cm-md-inline-code') });
        for (const type of ['mousemove', 'mouseup']) window.addEventListener(type, window.__inlineDragObserve);
      });
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      const end = await content.locator('.cm-md-inline-code').filter({ hasText: 'x😀y' }).evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node; node = walker.nextNode();) {
          const index = node.textContent.indexOf('y'); if (index < 0) continue;
          const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
          const box = range.getBoundingClientRect(); return { x: box.right - 1, y: box.top + box.height / 2 };
        }
        throw Error('active inline-code end was not found');
      });
      await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up();
      const selected = await content.evaluate(el => {
        const data = new DataTransfer();
        el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
        return data.getData('text/markdown');
      });
      const trace = await page.evaluate(() => {
        for (const type of ['mousemove', 'mouseup']) window.removeEventListener(type, window.__inlineDragObserve);
        return window.__inlineDragTrace;
      });
      assert.equal(selected, 'x😀y', JSON.stringify({ start, end, trace }));
      assert.equal(await copied(), source);
      }
    });
    await t.test('task bodies retain checkboxes and prefix source remains reachable', async () => {
      const task = content.locator('.cm-line').filter({ hasText: 'Task body' });
      await task.click({ position: { x: 155, y: 12 } });
      assert.equal(await task.locator('input[type=checkbox]').count(), 1);
      await page.keyboard.press('Home');
      assert.match(await task.textContent(), /- \[ \]/);
      assert.equal(await task.locator('input[type=checkbox]').count(), 0);
      await home();
      await task.locator('input[type=checkbox]').click();
      await waitForFile(file, text => text === source.replace('- [ ]', '- [x]'));
      await content.focus(); await page.keyboard.press('Control+Z');
      await waitForFile(file, text => text === source);
    });
    await t.test('a real table Tab adds a row once, moves cells and undoes in one step', async () => {
      await home();
      await content.locator('.cm-md-table td').last().click();
      await page.keyboard.press('End'); await page.keyboard.press('Tab');
      await waitForFile(file, text => text.includes('|  |  |'));
      await page.keyboard.type('NEW');
      await waitForFile(file, text => text.includes('| NEW |  |'));
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Control+Z');
      await page.keyboard.press('Control+Z');
      await waitForFile(file, text => text === source);
      assert.equal(await copied(), source);
    });
    await fs.mkdir(workspace.outputs, { recursive: true });
    await page.screenshot({ path: path.join(workspace.outputs, 'markdown-basics.png') });
    assert.deepEqual(errors, []);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await app.waitForEvent('close'); app = undefined;
  } finally {
    if (app) await app.close();
    await cleanupSmokeWorkspace(workspace);
  }
});
