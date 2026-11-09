const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const root = path.resolve(__dirname, '..');

test('list continuation tab and equivalent spaces retain source and visual indent', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('tab-continuation');
  const file = path.join(workspace.fixture, 'tabs.md');
  const longText = '中文文字需要自然折行并保持对齐。'.repeat(10);
  const source = `START\n\n- Parent one\n  BASE_CONTINUATION\n\t  TAB_PLUS_TWO ${longText}\n      SIX_SPACES ${longText}\n\tTAB_CONTINUATION\n    SPACE_CONTINUATION\n  \tSPACE_TAB\n    SPACE_TAB_EQUIVALENT\n\t\tDOUBLE_TAB\n        EIGHT_SPACES\n\n> - Quote parent\n> \t  QUOTE_TAB\n>       QUOTE_SPACES\n\n\`\`\`text\n\tCODE_TAB\n\`\`\`\n`;
  let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    await fs.writeFile(file, source, 'utf8');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [file] : [root, file], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow();
    const editor = page.locator('.cm-content');
    await editor.waitFor(); await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => {
      const content = document.querySelector('.cm-content'), view = document.querySelector('.cm-editor');
      if (!content || !view) return false;
      const style = getComputedStyle(content), canvas = document.createElement('canvas').getContext('2d');
      canvas.font = style.font;
      return Math.abs(parseFloat(getComputedStyle(view).getPropertyValue('--md-list-space-width')) - canvas.measureText(' ').width) < .02;
    });
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
      await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
      await page.evaluate(() => {
        const style = document.createElement('style'); style.id = 'tab-before-demo';
        style.textContent = '.cm-md-indent-tab { display:inline!important; width:auto!important; overflow:visible!important; }';
        document.head.append(style);
      });
      await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'tab-continuation-before.png') });
      await page.evaluate(() => document.querySelector('#tab-before-demo').remove());
    }
    const positions = await page.evaluate(() => {
      const find = token => {
        const lines = [...document.querySelectorAll('.cm-line')];
        const line = lines.find(item => item.textContent.includes(token));
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, offset = node.textContent.indexOf(token);
          if (offset < 0) continue;
          const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
          const wrapRange = document.createRange(); wrapRange.setStart(node, offset); wrapRange.setEnd(node, node.textContent.length);
          const style = getComputedStyle(line);
          const indent = document.createRange(); indent.setStart(node, 0); indent.setEnd(node, offset);
          return { left: range.getBoundingClientRect().left, wrapped: [...wrapRange.getClientRects()].filter(rect => rect.width).map(rect => ({ left: rect.left, top: rect.top })), indent: indent.getBoundingClientRect().toJSON(), text: line.textContent,
            tabSize: getComputedStyle(document.querySelector('.cm-content')).tabSize,
            letterSpacing: style.letterSpacing, lineHeight: style.lineHeight, paddingLeft: style.paddingLeft, textIndent: style.textIndent, html: line.outerHTML };
        }
        throw Error('Missing ' + token);
      };
      return { base: find('BASE_CONTINUATION'), tabPlusTwo: find('TAB_PLUS_TWO'), sixSpaces: find('SIX_SPACES'), tab: find('TAB_CONTINUATION'), spaces: find('SPACE_CONTINUATION'), spaceTab: find('SPACE_TAB'), spaceTabEquivalent: find('SPACE_TAB_EQUIVALENT'), doubleTab: find('DOUBLE_TAB'), eightSpaces: find('EIGHT_SPACES'), quoteTab: find('QUOTE_TAB'), quoteSpaces: find('QUOTE_SPACES') };
    });
    assert.equal(await fs.readFile(file, 'utf8'), source, 'the source still contains a literal tab and four spaces');
    assert.equal(positions.tab.tabSize, '4');
    assert.ok(Math.abs(positions.tab.left - positions.spaces.left) < 1.5,
      `equivalent indentation should have the same visual position: ${JSON.stringify(positions)}`);
    assert.ok(Math.abs(positions.doubleTab.left - positions.eightSpaces.left) < 1.5,
      `two tabs should align with eight spaces: ${JSON.stringify(positions)}`);
    assert.ok(Math.abs(positions.tabPlusTwo.left - positions.sixSpaces.left) < 1.5,
      `tab plus two spaces should align with six spaces: ${JSON.stringify(positions)}`);
    assert.ok(Math.abs(positions.spaceTab.left - positions.spaceTabEquivalent.left) < 1.5, 'spaces followed by a tab align to the next tab stop');
    assert.ok(Math.abs(positions.quoteTab.left - positions.quoteSpaces.left) < 1.5,
      `tabs and spaces should also align inside quoted lists: ${JSON.stringify(positions)}`);
    assert.ok(positions.tabPlusTwo.wrapped.length > 1, 'long continuation actually wraps');
    assert.ok(positions.tabPlusTwo.wrapped.every(rect => Math.abs(rect.left - positions.tabPlusTwo.left) < 1.5), 'wrapped continuation aligns to its first row');
    assert.ok(Math.abs(positions.tabPlusTwo.wrapped[0].top - positions.base.wrapped[0].top - parseFloat(positions.base.lineHeight)) < 1.5,
      'a leading tab does not increase the line height');
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
      await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'tab-continuation-after.png') });
    }

    await page.locator('.cm-line').filter({ hasText: 'BASE_CONTINUATION' }).click();
    await page.keyboard.press('Home'); await page.keyboard.press('Tab');
    const indented = source.replace('  BASE_CONTINUATION', '\t  BASE_CONTINUATION');
    await waitForFile(file, value => value === indented);
    await page.keyboard.press('Control+z'); await waitForFile(file, value => value === source);
    await page.keyboard.press('Control+Shift+z'); await waitForFile(file, value => value === indented);
    await page.locator('.cm-line').filter({ hasText: 'BASE_CONTINUATION' }).click(); await page.keyboard.press('End');
    await page.evaluate(() => {
      const data = new DataTransfer(); data.setData('text/plain', '\tPASTED');
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const pasted = indented.replace('BASE_CONTINUATION', 'BASE_CONTINUATION\tPASTED');
    await waitForFile(file, value => value === pasted);
    await page.keyboard.press('Control+z'); await waitForFile(file, value => value === indented);
    await page.reload(); await page.locator('.cm-content').waitFor();
    await page.locator('.cm-line').filter({ hasText: 'BASE_CONTINUATION' }).waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), indented, 'saved tab survives reopening');
    await page.locator('.cm-line').filter({ hasText: 'BASE_CONTINUATION' }).click();
    await page.keyboard.press('Home'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.insertText('X');
    const afterTab = indented.replace('\t  BASE_CONTINUATION', '\tX  BASE_CONTINUATION');
    await waitForFile(file, value => value === afterTab);
    await page.keyboard.press('Control+z'); await waitForFile(file, value => value === indented);
    await page.locator('.cm-line').filter({ hasText: 'BASE_CONTINUATION' }).click();
    await page.keyboard.press('Home'); await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Backspace');
    await waitForFile(file, value => value === source);
    await page.keyboard.press('Control+z'); await waitForFile(file, value => value === indented);
    const mixedLine = page.locator('.cm-line').filter({ hasText: 'SPACE_TAB' }).first();
    await mixedLine.click(); await page.keyboard.press('Home'); await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
    const selected = page.locator('.cm-proseSelectionBackground'); await selected.waitFor();
    const selectionBox = await selected.boundingBox(), tabBox = await mixedLine.locator('.cm-md-indent-tab').boundingBox();
    assert.ok(selectionBox && tabBox && Math.abs(selectionBox.x - tabBox.x) < 2 && Math.abs(selectionBox.width - tabBox.width) < 2,
      `selection over a partial tab stop follows the visible tab width: ${JSON.stringify({ selectionBox, tabBox })}`);
    await page.keyboard.press('ArrowRight');
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.querySelector('.cm-cursor-primary')?.getAnimations().map(animation => animation.finished.catch(() => {})) || []);
    });
    const caret = await page.locator('.cm-cursor-primary').boundingBox();
    assert.ok(caret && Math.abs(caret.x - (tabBox.x + tabBox.width)) < 2,
      `caret after tab reaches its visual edge: ${JSON.stringify({ caret, tabBox })}`);
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Backspace');
    await waitForFile(file, value => value === indented.replace('  \tSPACE_TAB\n', '  SPACE_TAB\n'));
    await page.keyboard.press('Control+z'); await waitForFile(file, value => value === indented);
    await page.getByRole('button', { name: '切换到预览', exact: true }).click();
    const preview = page.locator('.markdown-preview'); await preview.waitFor();
    assert.ok((await preview.innerText()).includes('BASE_CONTINUATION'), 'list continuation remains visible in reading mode');
    assert.ok((await preview.locator('pre code').last().textContent()).includes('\tCODE_TAB'), 'fenced code retains its literal tab in reading mode');
    assert.equal(await fs.readFile(file, 'utf8'), indented, 'reading mode does not rewrite source indentation');
  } finally {
    if (app) await app.close();
    await cleanupSmokeWorkspace(workspace);
  }
});
