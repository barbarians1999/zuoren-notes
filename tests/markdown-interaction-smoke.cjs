const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

test('prose selection hugs text and real formatting shortcuts toggle at the caret', { timeout: 60000 }, async () => {
  const root = path.resolve(__dirname, '..'), workspace = await createSmokeWorkspace('markdown-interaction');
  let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const paragraph = '很多人以为，网上动辄几十万的天价彩礼只是段子手编造的极端案例。但只要你走进中西部的县城或乡村，去参加任何一场谈婚论嫁的饭局，就会发现现实比段子要沉重得多。'.repeat(2);
    await fs.writeFile(path.join(workspace.fixture, 'interaction.md'), '# 标题\n\n' + paragraph + '\n\nshortcutword\n');
    const executablePath = process.env.ZHAOYE_EXE || path.join(root, 'node_modules/electron/dist/electron.exe');
    app = await electron.launch({ executablePath, args: process.env.ZHAOYE_EXE ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('.file-row').filter({ hasText: 'interaction.md' }).click();
    const content = page.locator('.cm-content');
    await content.waitFor();
    await content.evaluate(element => element.addEventListener('copy', event => {
      window.__markdownCopiedText = event.clipboardData?.getData('text/plain') || '';
    }));
    await page.evaluate(() => document.fonts.ready);
    const line = content.locator('.cm-line').filter({ hasText: paragraph });
    const points = await line.evaluate(element => {
      const node = element.firstChild;
      function point(offset) { const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1); const r = range.getBoundingClientRect(); return { x: r.left + 1, y: r.top + r.height / 2 }; }
      return { start: point(3), end: point(node.length - 6) };
    });
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 15 }); await page.mouse.up();
    await page.locator('.cm-proseSelectionBackground').first().waitFor();
    const checkGeometry = async () => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(() => {
        const range = getSelection().getRangeAt(0), selected = getSelection().toString();
        const expected = Array.from(range.getClientRects()).filter(r => r.width > 0);
        const actual = Array.from(document.querySelectorAll('.cm-proseSelectionBackground')).map(el => el.getBoundingClientRect());
        const content = document.querySelector('.cm-content'), box = content.getBoundingClientRect(), style = getComputedStyle(content);
        return { selected, count: actual.length, outside: actual.some(r => r.left < box.left + parseFloat(style.paddingLeft) - 1 || r.right > box.right - parseFloat(style.paddingRight) + 1), unmatched: actual.some(r => !expected.some(e => Math.abs(e.left - r.left) < 1 && Math.abs(e.right - r.right) < 1 && Math.abs(e.top - r.top) < 1 && Math.abs(e.bottom - r.bottom) < 1)) };
      });
      assert.ok(geometry.count >= 2, 'fixture wraps across multiple visual lines');
      assert.equal(geometry.outside, false, 'selection never paints the content margins');
      assert.equal(geometry.unmatched, false, 'each overlay matches selected text, not a filled line');
      return geometry.selected;
    };
    const selected = await checkGeometry();
    await page.evaluate(() => { window.__markdownCopiedText = '__copy_pending__'; });
    await page.keyboard.press('Control+c');
    await page.waitForFunction(() => window.__markdownCopiedText !== '__copy_pending__');
    assert.equal(await page.evaluate(() => window.__markdownCopiedText), selected);
    if (process.env.ZHAOYE_INTERACTION_SCREENSHOT) await page.screenshot({ path: process.env.ZHAOYE_INTERACTION_SCREENSHOT });
    await page.setViewportSize({ width: 850, height: 760 });
    await page.waitForTimeout(180); // resize -> CodeMirror layout measurement
    await checkGeometry();
    const shortcutLine = content.locator('.cm-line').filter({ hasText: 'hortcutword' });
    for (const key of ['Control+b', 'Control+i', 'Control+Shift+x']) {
      await shortcutLine.click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
      await page.keyboard.press(key); await page.keyboard.insertText('X');
      await page.keyboard.press(key);
      assert.equal(await shortcutLine.innerText(), 'sXhortcutword', key + ' cancels formatting with caret inside');
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+z');
      assert.equal(await shortcutLine.innerText(), 'shortcutword', key + ' all edits undo');
    }
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.keyboard.press('Escape');
    await shortcutLine.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
    await page.locator('.cm-proseSelectionBackground').first().waitFor();
    await page.getByTitle('行内代码', { exact: true }).click();
    await shortcutLine.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
    await page.getByTitle('行内代码', { exact: true }).click();
    assert.equal(await shortcutLine.innerText(), 'shortcutword', 'floating toolbar shares toggles');
    assert.deepEqual(errors, []);
  } finally { if (app) await app.close(); await cleanupSmokeWorkspace(workspace); }
});
