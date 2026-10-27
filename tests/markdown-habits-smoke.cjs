const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const root = path.resolve(__dirname, '..'), fence = String.fromCharCode(96).repeat(3);

test('confirmed Markdown keyboard habits preserve source and undo in the real editor', { timeout: 150000 }, async t => {
  const workspace = await createSmokeWorkspace('markdown-habits'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const note = path.join(workspace.fixture, 'habits.md'); await fs.writeFile(note, '');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('.file-row').filter({ hasText: 'habits.md' }).dblclick();
    const content = page.locator('.cm-content'); await content.waitFor();
    const press = async key => page.keyboard.press(key);
    const paste = async (type, value) => content.evaluate((element, data) => {
      const transfer = new DataTransfer(); transfer.setData(data.type, data.value);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, { type, value });
    const replace = async value => {
      await content.focus(); await press('Control+A');
      if (value) await paste('text/markdown', value); else await press('Backspace');
      await saved(value);
      await press('Control+Home');
    };
    const saved = async value => {
      try { return await waitForFile(note, text => text === value); }
      catch (error) {
        const actual = await fs.readFile(note, 'utf8');
        throw new assert.AssertionError({ message: 'the synthetic fixture did not reach the expected saved content',
          actual, expected: value, operator: 'strictEqual' });
      }
    };
    const selectLine = async () => { await content.focus(); await press('Control+Home'); await press('Shift+End'); };

    await t.test('ordered list insertion renumbers later siblings in one undo', async () => {
      const before = '1. 苹果\n2. 香蕉\n3. 梨';
      await replace(before); await press('End'); await press('Enter');
      await saved('1. 苹果\n2. \n3. 香蕉\n4. 梨');
      await press('Control+z'); await saved(before);
    });
    await t.test('a completed task continues as an unchecked task', async () => {
      const before = '- [x] 已完成'; await replace(before);
      await press('Control+End'); await press('Enter'); await saved('- [x] 已完成\n- [ ] ');
      await press('Control+z'); await saved(before);
    });
    await t.test('Tab moves the current line only and renumbers affected ordered lists', async () => {
      const before = '1. 第一项\n2. 第二项\n3. 第三项';
      await replace(before); await press('ArrowDown'); await press('End'); await press('Tab');
      await saved('1. 第一项\n\t1. 第二项\n2. 第三项');
      await press('Control+z'); await saved(before);
      const children = '- 父项\n- 当前项\n  - 子项\n- 末项';
      await replace(children); await press('ArrowDown'); await press('End'); await press('Tab');
      await saved('- 父项\n\t- 当前项\n  - 子项\n- 末项');
      await press('Control+z'); await saved(children);
    });
    await t.test('Shift+Enter continues the same list item at its visible text column', async () => {
      for (const before of ['- 苹果', '12. 苹果', '- [x] 苹果']) {
        await replace(before); await press('End'); await press('Shift+Enter'); await page.keyboard.insertText('香蕉');
        await waitForFile(note, text => text.startsWith(before + '\n') && /^[ \t]*香蕉$/.test(text.slice(before.length + 1)));
        const positions = await content.evaluate(element => {
          const lines = [...element.querySelectorAll('.cm-line')];
          const leftOf = (line, text) => {
            const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
            for (let node; node = walker.nextNode();) {
              const offset = node.textContent.indexOf(text); if (offset < 0) continue;
              const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
              return range.getBoundingClientRect().left;
            }
            throw Error('list text not found: ' + text);
          };
          return [leftOf(lines.find(line => line.textContent.includes('苹果')), '苹果'),
            leftOf(lines.find(line => line.textContent.includes('香蕉')), '香蕉')];
        });
        assert.ok(Math.abs(positions[0] - positions[1]) <= 3, before + ': ' + JSON.stringify(positions));
        await page.getByRole('button', { name: '切换到预览', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.markdown-preview')?.dataset.previewCurrent === 'true');
        assert.equal(await page.locator('.markdown-preview li').count(), 1, before);
        const previewPositions = await page.locator('.markdown-preview li').evaluate(element => {
          const leftOf = text => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            for (let node; node = walker.nextNode();) {
              const offset = node.textContent.indexOf(text); if (offset < 0) continue;
              const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
              return range.getBoundingClientRect().left;
            }
            throw Error('preview list text not found: ' + text);
          };
          return [leftOf('苹果'), leftOf('香蕉')];
        });
        assert.ok(Math.abs(previewPositions[0] - previewPositions[1]) <= 3, before + ' preview: ' + JSON.stringify(previewPositions));
        await page.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
      }
    });
    await t.test('Enter in fenced code preserves literal spaces and outdents an empty line in place', async () => {
      const before = fence + 'js\n        内容\n' + fence;
      await replace(before); await press('ArrowDown'); await press('End'); await press('Enter');
      await saved(fence + 'js\n        内容\n        \n' + fence);
      await press('Enter'); await saved(fence + 'js\n        内容\n    \n' + fence);
      await press('Control+z'); await saved(fence + 'js\n        内容\n        \n' + fence);
    });
    await t.test('Enter splits heading into title and normal prose', async () => {
      const before = '## 今天去买书'; await replace(before);
      for (let i = 0; i < 5; i++) await press('ArrowRight');
      await press('Enter'); await saved('## 今天\n去买书');
      await press('Control+z'); await saved(before);
    });
    await t.test('list Backspace removes its prefix; Delete keeps the next prefix', async () => {
      const before = '- 苹果\n- 香蕉'; await replace(before);
      await press('ArrowDown'); await press('Home'); await press('ArrowRight'); await press('ArrowRight');
      await press('Backspace'); await saved('- 苹果\n\n香蕉');
      await page.getByRole('button', { name: '切换到预览', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.markdown-preview')?.dataset.previewCurrent === 'true');
      assert.equal(await page.locator('.markdown-preview > p').filter({ hasText: '香蕉' }).count(), 1, 'the text is a top-level paragraph, not a continuation of the previous list item');
      await page.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
      await content.focus(); await press('Control+z'); await saved(before);
      await press('Control+Home'); await press('End'); await press('Delete');
      await saved('- 苹果- 香蕉');
    });
    await t.test('pasting plain lines creates sibling items and one undo restores the empty item', async () => {
      await replace('- '); await press('Control+End'); await paste('text/plain', '苹果\n香蕉\n梨');
      await saved('- 苹果\n- 香蕉\n- 梨'); await press('Control+z'); await saved('- ');
      await replace('- [x] '); await press('Control+End'); await paste('text/plain', '第一项\n第二项');
      await saved('- [x] 第一项\n- [ ] 第二项'); await press('Control+z'); await saved('- [x] ');
    });
    await t.test('pasting a nested list preserves internal levels at the target position', async () => {
      const before = '- 购物\n  - '; await replace(before); await press('Control+End');
      await paste('text/markdown', '- 苹果\n  - 红苹果\n- 香蕉');
      await saved('- 购物\n  - 苹果\n    - 红苹果\n  - 香蕉');
      await press('Control+z'); await saved(before);
    });
    await t.test('a selected table cell retains its text and Tab navigates to the next cell', async () => {
      const before = '| A | B |\n| --- | --- |\n| 中😀 | second |'; await replace(before);
      // The caret is already inside the source table after replace(), so no
      // rendered table widget exists until it moves outside that table.
      await press('ArrowDown'); await press('ArrowDown');
      await press('Home'); await press('ArrowRight'); await press('ArrowRight');
      await press('Shift+ArrowRight'); await press('Shift+ArrowRight'); await press('Tab');
      await page.keyboard.insertText('X');
      await saved('| A | B |\n| --- | --- |\n| 中😀 | Xsecond |');
      await press('Control+z'); await saved(before);
    });
    await t.test('two physical symbol keys wrap and toggle selection with one-step undo', async () => {
      const before = '苹😀果'; await replace(before); await selectLine(); await page.keyboard.type('**');
      await saved('**苹😀果**');
      // Saving takes longer than the ordinary history grouping window.
      await page.keyboard.type('**'); await saved(before);
      await press('Control+z'); await saved('**苹😀果**');
      await press('Control+z'); await saved(before);
      await selectLine(); await page.keyboard.type('~~'); await saved('~~苹😀果~~');
      await page.keyboard.type('~~'); await saved(before);
      await press('Control+z'); await saved('~~苹😀果~~');
      await replace(before); await selectLine(); await page.keyboard.type(String.fromCharCode(96));
      await saved(String.fromCharCode(96) + before + String.fromCharCode(96));
      await page.keyboard.type(String.fromCharCode(96)); await saved(before);
      await press('Control+z'); await saved(String.fromCharCode(96) + before + String.fromCharCode(96));
    });
    await t.test('unselected delimiters stay literal and Backspace deletes only the left symbol', async () => {
      await replace(''); await page.keyboard.type('**'); await saved('**');
      await replace(''); await page.keyboard.type('~~'); await saved('~~');
      await replace('****'); await press('ArrowRight'); await press('ArrowRight');
      await press('Backspace'); await page.keyboard.insertText('X'); await saved('*X**');
      await replace(''); await page.keyboard.type(String.fromCharCode(96)); await saved(String.fromCharCode(96));
    });
    await t.test('both views share formatted edits and undo history', async () => {
      await replace('共享😀文字');
      await page.getByRole('button', { name: '左右分屏笔记', exact: true }).click();
      const left = page.locator('[data-note-group="primary"] .cm-content');
      const right = page.locator('[data-note-group="secondary"] .cm-content');
      await right.waitFor(); await left.focus(); await press('Control+Home'); await press('Shift+End');
      await page.keyboard.type('**'); await saved('**共享😀文字**');
      await right.locator('.cm-md-strong').filter({ hasText: '共享😀文字' }).waitFor();
      await right.focus(); await press('Control+z'); await saved('共享😀文字');
      assert.equal(await left.locator('.cm-md-strong').count(), 0);
      await page.getByRole('button', { name: '左右分屏笔记', exact: true }).click();
    });
    await t.test('saved Unicode source survives closing and reopening the note', async () => {
      const tab = page.getByRole('tab', { name: /habits\.md/ });
      await tab.locator('..').getByRole('button', { name: '关闭 habits.md' }).click();
      await page.locator('.file-row').filter({ hasText: 'habits.md' }).dblclick();
      await content.waitFor(); await content.focus(); await press('Control+A');
      const source = await content.evaluate(element => {
        const transfer = new DataTransfer();
        element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
        return transfer.getData('text/markdown');
      });
      assert.equal(source, '共享😀文字');
      assert.equal(await fs.readFile(note, 'utf8'), source);
    });
    assert.deepEqual(errors, []);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await app.waitForEvent('close'); app = undefined;
  } finally {
    if (app) await app.close();
    await cleanupSmokeWorkspace(workspace);
  }
});
