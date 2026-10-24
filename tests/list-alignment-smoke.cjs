const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const root = path.resolve(__dirname, '..');
const long = '这是用于检查列表换行对齐的中文正文😀。'.repeat(4);
const source = `cursor\n\n1. ORDERED ${long}\n10. NUMBERED ${long}\n\n## Bullets\n\n- BULLET ${long}\n  CONTINUED ${long}\n\n## Nested\n\n- PARENT\n  1. CHILD_ORDERED ${long}\n     ORDERED_CONTINUED ${long}\n  - CHILD_BULLET ${long}\n    BULLET_CONTINUED ${long}\n\n> 1. QUOTE_ORDERED ${long}\n>\n> - QUOTE_BULLET ${long}\n`;

test('ordered and bullet list text, wrapping and continuations align without changing Markdown', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('list-alignment'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const file = path.join(workspace.fixture, 'lists.md'); await fs.writeFile(file, source);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [file] : [root, file], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.locator('.cm-content').waitFor();
    const screenshot = async (name, selector) => {
      if (!process.env.ZUOREN_SCREENSHOT_OUTPUT) return;
      await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
      await page.locator(selector).evaluate(element => { element.scrollTop = 0; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator(selector).screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, name + '.png') });
    };
    const geometry = async (token, selector) => {
      const target = page.locator(selector).filter({ hasText: new RegExp(token) }).first();
      if (selector === '.cm-line' && !await target.count()) {
        const scroller = page.locator('.cm-scroller'); await scroller.evaluate(element => { element.scrollTop = 0; });
        for (let step = 0; step < 20; step++) {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          if (await target.count()) break;
          await scroller.evaluate(element => { element.scrollTop += element.clientHeight * .8; });
        }
      }
      return target.evaluate((element, token) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) {
        const offset = node.textContent.indexOf(token.trim()); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, node.textContent.length);
        return [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({ x: rect.x, y: rect.y }));
      }
      throw Error('Missing visible text: ' + token + ' in ' + element.outerHTML.slice(0, 400));
      }, token);
    };
    const check = async selector => {
      const first = token => geometry(token, selector).then(rects => rects[0].x);
      for (const [left, right] of [['ORDERED ', 'BULLET '], ['ORDERED ', 'NUMBERED '], ['BULLET ', 'CONTINUED '], ['CHILD_ORDERED ', 'CHILD_BULLET '], ['CHILD_ORDERED ', 'ORDERED_CONTINUED '], ['CHILD_BULLET ', 'BULLET_CONTINUED '], ['QUOTE_ORDERED ', 'QUOTE_BULLET ']]) {
        const positions = [await first(left), await first(right)];
        assert.ok(Math.abs(positions[0] - positions[1]) < 1.5, `${left}/${right} share one text edge: ${positions}`);
      }
      for (const token of ['ORDERED ', 'BULLET ', 'CHILD_ORDERED ', 'CHILD_BULLET ']) {
        const rects = await geometry(token, selector);
        assert.ok(new Set(rects.map(rect => Math.round(rect.y))).size > 1, 'fixture must wrap: ' + token);
        assert.ok(rects.every(rect => Math.abs(rect.x - rects[0].x) < 1.5), 'wrapped text aligns with the first row: ' + JSON.stringify({ token, rects }));
      }
    };
    for (const font of ['fangsong', 'hanyi-shufang-55w']) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('combobox', { name: 'Markdown 正文字体' }).selectOption(font); await page.keyboard.press('Escape');
      await page.evaluate(() => document.fonts.ready);
      await check('.cm-line');
      await screenshot(font + '-edit', '.cm-scroller');
      await page.getByRole('button', { name: '切换到预览', exact: true }).click();
      await page.locator('.markdown-preview li').first().waitFor();
      await check('.markdown-preview li');
      await screenshot(font + '-read', '.markdown-preview');
      await page.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
    }
    const line = page.locator('.cm-line').filter({ hasText: /BULLET / }).filter({ hasNotText: /CHILD_|QUOTE_/ });
    await line.scrollIntoViewIfNeeded();
    const point = await line.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) {
        const offset = node.textContent.indexOf('😀'); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 2);
        const bounds = range.getBoundingClientRect(); return { x: bounds.left + 1, y: bounds.top + bounds.height / 2 };
      }
      throw Error('Missing Emoji click target');
    });
    await page.mouse.click(point.x, point.y); await page.keyboard.insertText('Z');
    const at = source.indexOf('😀', source.indexOf('- BULLET '));
    await waitForFile(file, value => value === source.slice(0, at) + 'Z' + source.slice(at));
    await page.keyboard.press('Control+z'); await waitForFile(file, value => value === source);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
      await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
      await page.locator('.cm-content').press('Control+Home');
      await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'list-alignment.png') });
    }
  } finally { await app?.close(); await cleanupSmokeWorkspace(workspace); }
});
