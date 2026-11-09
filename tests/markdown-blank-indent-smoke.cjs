const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const root = path.resolve(__dirname, '..');

test('blank list indentation and editable prefixes stay visually stable', { timeout: 90000 }, async () => {
  const workspace = await createSmokeWorkspace('markdown-blank-indent'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const list = path.join(workspace.fixture, 'list.md');
    const blankCases = [{ name: 'blank.md', source: '- item\n' }, { name: 'blank-paragraph.md', source: '- item\n\n' }];
    const listSource = '- 这个\n-    多个空格\n- [ ] 待办甲\n- [ ]    多空格待办乙\n- [ ]\t制表待办丙\n\noutside';
    await fs.writeFile(list, listSource);
    for (const fixture of blankCases) await fs.writeFile(path.join(workspace.fixture, fixture.name), fixture.source);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow();
    await page.locator('.file-row').filter({ hasText: 'list.md' }).dblclick(); await page.locator('.cm-content').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const settled = () => page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running'
        && Number.isFinite(animation.effect?.getTiming().iterations)).map(animation => animation.finished.catch(() => {})));
    });
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await settled();
    const row = page.locator('.cm-line').filter({ hasText: '这个' });
    const bodyLeft = () => row.evaluate(line => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const text = walker.currentNode, offset = text.textContent.indexOf('这个'); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect().left; }
      throw Error('list text missing');
    });
    const renderedLeft = await bodyLeft();
    const markerGap = async selector => row.locator(selector).evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const text = walker.currentNode, offset = text.textContent.search(/\S/); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect().right; }
      throw Error('marker text missing');
    });
    const wideRow = page.locator('.cm-line').filter({ hasText: '多个空格' });
    const wideBodyLeft = () => wideRow.evaluate(line => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const text = walker.currentNode, offset = text.textContent.indexOf('多个空格'); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect().left; }
      throw Error('wide-prefix list text missing');
    });
    const wideMarkerGap = selector => wideRow.locator(selector).evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const text = walker.currentNode, offset = text.textContent.search(/\S/); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect().right; }
      throw Error('wide-prefix marker text missing');
    });
    const taskGeometry = (row, selector, bodyText) => row.evaluate((line, { selector, bodyText }) => {
      const bodyWalker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let bodyNode;
      while (bodyWalker.nextNode()) if (bodyWalker.currentNode.textContent.includes(bodyText)) { bodyNode = bodyWalker.currentNode; break; }
      if (!bodyNode) throw Error('task body text missing');
      const offset = bodyNode.textContent.indexOf(bodyText), body = document.createRange();
      body.setStart(bodyNode, offset); body.setEnd(bodyNode, offset + 1);
      const marker = line.querySelector(selector); if (!marker) throw Error('task prefix missing: ' + selector);
      let markerRight;
      if (selector === '.cm-md-task-checkbox') markerRight = marker.getBoundingClientRect().right;
      else {
        const walker = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT); let lastNode, lastOffset = -1;
        while (walker.nextNode()) {
          const text = walker.currentNode.textContent;
          for (let index = 0; index < text.length; index++) if (/\S/.test(text[index])) { lastNode = walker.currentNode; lastOffset = index; }
        }
        if (!lastNode) throw Error('task source marker text missing');
        const range = document.createRange(); range.setStart(lastNode, lastOffset); range.setEnd(lastNode, lastOffset + 1);
        markerRight = range.getBoundingClientRect().right;
      }
      return { bodyLeft: body.getBoundingClientRect().left, gap: body.getBoundingClientRect().left - markerRight };
    }, { selector, bodyText });
    const renderedGap = renderedLeft - await markerGap('.cm-md-list-marker');
    assert.ok(Math.abs(renderedGap - 9) < 2, `rendered marker gap should be approximately half an em: ${renderedGap}`);
    const wideRenderedLeft = await wideBodyLeft(), wideRenderedGap = wideRenderedLeft - await wideMarkerGap('.cm-md-list-marker');
    assert.ok(Math.abs(wideRenderedGap - 9) < 2, `multiple source spaces must not widen the rendered marker gap: ${wideRenderedGap}`);
    const taskRow = page.locator('.cm-line').filter({ hasText: '待办甲' });
    const wideTaskRow = page.locator('.cm-line').filter({ hasText: '多空格待办乙' });
    const tabTaskRow = page.locator('.cm-line').filter({ hasText: '制表待办丙' });
    const taskRendered = await taskGeometry(taskRow, '.cm-md-task-checkbox', '待办甲');
    const wideTaskRendered = await taskGeometry(wideTaskRow, '.cm-md-task-checkbox', '多空格待办乙');
    const tabTaskRendered = await taskGeometry(tabTaskRow, '.cm-md-task-checkbox', '制表待办丙');
    assert.ok(Math.abs(taskRendered.gap - 9) < 2, `checkbox-to-body gap should be about half an em: ${taskRendered.gap}`);
    assert.ok(Math.abs(wideTaskRendered.gap - 9) < 2, `multiple spaces after checkbox must not widen the gap: ${wideTaskRendered.gap}`);
    assert.ok(Math.abs(tabTaskRendered.gap - 9) < 2, `a source tab after the checkbox must not widen the gap: ${tabTaskRendered.gap}`);
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
      await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'list-rendered-after.png') });
    }
    await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowRight'); await settled();
    assert.equal(await row.locator('.cm-md-list-prefix').count(), 1, 'the editable prefix occupies one gutter');
    const sourceLeft = await bodyLeft();
    assert.ok(Math.abs(sourceLeft - renderedLeft) < 1.5, `body must not jump when the marker expands: ${renderedLeft} / ${sourceLeft}`);
    const sourceGap = sourceLeft - await markerGap('.cm-md-list-prefix');
    assert.ok(Math.abs(sourceGap - 9) < 2, `source marker gap should be approximately half an em: ${sourceGap}`);
    await page.evaluate(position => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: position } });
    }, listSource.indexOf('-    多个空格') + 1);
    await settled();
    assert.equal(await wideRow.locator('.cm-md-list-prefix').count(), 1, 'the multi-space prefix remains editable as source');
    const wideSourceLeft = await wideBodyLeft(), wideSourceGap = wideSourceLeft - await wideMarkerGap('.cm-md-list-prefix');
    assert.ok(Math.abs(wideSourceLeft - wideRenderedLeft) < 1.5, `active multi-space prefix keeps the body aligned: ${wideRenderedLeft} / ${wideSourceLeft}`);
    assert.ok(Math.abs(wideSourceGap - 9) < 2, `multiple source spaces must not widen the active marker gap: ${wideSourceGap}`);
    await page.evaluate(position => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: position } });
    }, listSource.indexOf('- [ ]    多空格待办乙') + 1);
    await settled();
    assert.equal(await wideTaskRow.locator('.cm-md-list-prefix').count(), 1, 'active task source exposes one normalized prefix');
    const wideTaskSource = await taskGeometry(wideTaskRow, '.cm-md-list-prefix', '多空格待办乙');
    assert.ok(Math.abs(wideTaskSource.bodyLeft - wideTaskRendered.bodyLeft) < 1.5,
      `active task syntax keeps the checkbox body edge: ${wideTaskRendered.bodyLeft} / ${wideTaskSource.bodyLeft}`);
    assert.ok(Math.abs(wideTaskSource.gap - 9) < 2, `active task syntax keeps a half-em gap: ${wideTaskSource.gap}`);
    const taskSpacePosition = listSource.indexOf('- [ ]    多空格待办乙') + 7;
    await page.evaluate(position => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: position } });
    }, taskSpacePosition);
    await page.keyboard.insertText(' ');
    const taskSpaceEdit = listSource.slice(0, taskSpacePosition) + ' ' + listSource.slice(taskSpacePosition);
    await waitForFile(list, value => value === taskSpaceEdit);
    assert.equal(await page.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()), taskSpaceEdit,
      'typing in the active task separator edits the exact source position');
    await page.keyboard.press('Control+z'); await waitForFile(list, value => value === listSource);
    assert.equal(await page.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()), listSource,
      'undo restores the exact task separator source');
    await page.evaluate(position => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: position } });
    }, listSource.indexOf('- [ ]\t制表待办丙') + 2);
    const tabTaskSource = await taskGeometry(tabTaskRow, '.cm-md-list-prefix', '制表待办丙');
    assert.ok(Math.abs(tabTaskSource.bodyLeft - tabTaskRendered.bodyLeft) < 1.5,
      `active task source with a tab keeps its body aligned: ${tabTaskRendered.bodyLeft} / ${tabTaskSource.bodyLeft}`);
    assert.ok(Math.abs(tabTaskSource.gap - 9) < 2, `active task source with a tab keeps a half-em gap: ${tabTaskSource.gap}`);
    const taskTabPosition = listSource.indexOf('- [ ]\t制表待办丙') + 5;
    await page.evaluate(position => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: position } });
    }, taskTabPosition);
    await page.keyboard.insertText(' ');
    const taskTabEdit = listSource.slice(0, taskTabPosition) + ' ' + listSource.slice(taskTabPosition);
    await waitForFile(list, value => value === taskTabEdit);
    assert.equal(await page.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()), taskTabEdit,
      'typing at an active task Tab boundary preserves the literal Tab at the exact source position');
    await page.keyboard.press('Control+z'); await waitForFile(list, value => value === listSource);
    assert.equal(await page.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()), listSource,
      'undo restores the original task Tab separator');
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'list-prefix-after.png') });
    assert.equal(await fs.readFile(list, 'utf8'), listSource);
    for (const fixture of blankCases) {
      const blank = path.join(workspace.fixture, fixture.name), indented = fixture.source + '\t';
      await page.locator('.file-row').filter({ hasText: fixture.name }).dblclick();
      await page.waitForFunction(() => !document.querySelector('.note-body')?.getAnimations().some(animation => animation.playState === 'running'));
      await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('Tab'); await settled();
      const cursorLeft = () => page.locator('.cm-cursor-primary').evaluate(cursor => cursor.getBoundingClientRect().left);
      const before = await cursorLeft();
      const beforePosition = await page.evaluate(() => { const view = document.querySelector('.cm-content').cmTile.root.view; return view.coordsAtPos(view.state.selection.main.head)?.left; });
      await page.keyboard.insertText('文'); await settled();
      const typed = await page.evaluate(() => {
        const view = document.querySelector('.cm-content').cmTile.root.view, pos = view.state.selection.main.head;
        return { textStart: view.coordsAtPos(pos - 1)?.left, textEnd: view.coordsAtPos(pos)?.left, source: view.state.doc.toString() };
      });
      assert.equal(typed.source, indented + '文');
      assert.ok(Math.abs(before - typed.textStart) < 1.5, `empty and typed positions differ: ${before} / ${typed.textStart}`);
      // Separate typing and deletion into distinct undo groups.
      await page.waitForTimeout(650);
      await page.keyboard.press('Backspace'); await settled();
      const deleted = await cursorLeft();
      const deletedPosition = await page.evaluate(() => { const view = document.querySelector('.cm-content').cmTile.root.view; return view.coordsAtPos(view.state.selection.main.head)?.left; });
      assert.ok(Math.abs(before - deleted) < 1.5, `deleting the text must keep the indent: ${JSON.stringify({ before, beforePosition, typed, deleted, deletedPosition })}`);
      await waitForFile(blank, value => value === indented);
      await page.keyboard.press('Control+z'); await waitForFile(blank, value => value === indented + '文');
      await page.keyboard.press('Control+Shift+z'); await waitForFile(blank, value => value === indented);
      if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
        await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, fixture.name + '-indent-after.png') });
      }
    }
  } finally { if (app) await app.close(); await cleanupSmokeWorkspace(workspace); }
});
