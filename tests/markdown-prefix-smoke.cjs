const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');

const appRoot = path.resolve(__dirname, '..');

test('Markdown prefix boundaries keep one editable or rendered marker without overlap', { timeout: 45000 }, async () => {
  const workspace = await createSmokeWorkspace('markdown-prefix'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const source = '# \n\n- bullet body\n\n12. ordered body\n\n---\n\nend\n\n';
    const note = path.join(workspace.fixture, 'prefixes.md');
    await fs.writeFile(note, source, 'utf8');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({
      executablePath: packaged || path.join(appRoot, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [note] : [appRoot, workspace.fixture],
      env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData },
    });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    await page.locator('.app[data-session-ready="true"]').waitFor();
    const row = page.locator('.file-row').filter({ hasText: 'prefixes.md' });
    if (!packaged) await row.dblclick();
    await page.locator('.document-tab').filter({ hasText: 'prefixes.md' }).waitFor({ state: 'visible' });
    const editor = page.locator('.cm-content');
    await editor.filter({ hasText: 'ordered body' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.note-body')?.getAnimations().length);

    const lines = () => editor.locator('.cm-line');
    const prefixState = async index => lines().nth(index).evaluate(line => ({
      text: line.textContent,
      prefixCount: line.querySelector('.cm-md-list-prefix') ? 1 : 0,
      prefixText: [...line.querySelectorAll('.cm-md-list-prefix')].map(node => node.textContent).join(''),
      markerCount: line.querySelectorAll('.cm-md-list-marker').length,
      markerGap: (() => {
        const marker = line.querySelector('.cm-md-list-marker');
        if (!marker) return null;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) if (node.textContent.trim() && !node.parentElement.closest('.cm-md-list-marker')) break;
        if (!node) return null;
        const markerRange = document.createRange(); markerRange.selectNodeContents(marker);
        const bodyRange = document.createRange(), start = node.textContent.search(/\S/);
        bodyRange.setStart(node, start); bodyRange.setEnd(node, start + 1);
        return bodyRange.getBoundingClientRect().left - markerRange.getBoundingClientRect().right;
      })(),
    }));

    await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End');
    assert.ok((await lines().nth(0).locator('.cm-md-heading').textContent()).includes('#'), 'the heading hash stays visible under its end caret');
    assert.deepEqual(await prefixState(2), { text: '•bullet body', prefixCount: 0, prefixText: '', markerCount: 1, markerGap: (await prefixState(2)).markerGap });
    assert.deepEqual(await prefixState(4), { text: '12.ordered body', prefixCount: 0, prefixText: '', markerCount: 1, markerGap: (await prefixState(4)).markerGap });
    for (const index of [2, 4]) assert.ok((await prefixState(index)).markerGap > 0, 'rendered marker has a visible gap before body text');

    await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.cm-line:nth-of-type(3) .cm-md-list-prefix'));
    const activeBullet = await prefixState(2);
    assert.equal(activeBullet.prefixText, '- ');
    assert.equal(activeBullet.prefixCount, 1); assert.equal(activeBullet.markerCount, 0, 'editable bullet syntax replaces the preview bullet exactly once');

    await page.keyboard.press('Control+Home');
    for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.cm-line:nth-of-type(5) .cm-md-list-prefix'));
    const activeOrdered = await prefixState(4);
    assert.equal(activeOrdered.prefixText, '12. ');
    assert.equal(activeOrdered.prefixCount, 1); assert.equal(activeOrdered.markerCount, 0, 'editable ordered syntax replaces the preview number exactly once');
    assert.equal(await fs.readFile(note, 'utf8'), source, 'moving the caret across prefixes never changes source');

    // Same-line movement across the horizontal rule's half-open boundary must
    // invalidate its cached preview so Home/Left can reach the exact source.
    const ruleStart = source.indexOf('---');
    await editor.evaluate((element, position) => {
      const view = element.cmTile.root.view;
      view.dispatch({ selection: { anchor: position + 3 }, scrollIntoView: true }); view.focus();
    }, ruleStart);
    assert.equal(await editor.locator('.cm-md-horizontal-rule').count(), 1);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await editor.locator('.cm-md-horizontal-rule').count(), 0, 'Left reveals the horizontal-rule source');
    await page.keyboard.press('End');
    assert.equal(await editor.locator('.cm-md-horizontal-rule').count(), 1, 'End restores the rendered horizontal rule');
    await page.keyboard.press('Home');
    assert.equal(await editor.locator('.cm-md-horizontal-rule').count(), 0, 'Home also reveals the source without changing lines');
    await page.keyboard.insertText('文😀');
    await waitForFile(note, value => value === source.slice(0, ruleStart) + '文😀' + source.slice(ruleStart));
    await page.keyboard.press('Control+z');
    await waitForFile(note, value => value === source);

    // Reproduce the user's actual empty-heading Enter and incremental list typing paths.
    const reproductionFailures = [];
    await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    const firstLine = lines().first();
    const emptyHeadingText = await firstLine.textContent();
    if (!emptyHeadingText.includes('#')) reproductionFailures.push(`empty heading after Enter: ${JSON.stringify(emptyHeadingText)}`);

    await page.keyboard.press('Control+End'); await page.keyboard.type('9.');
    const typedLine = lines().last();
    const typedMarkerText = await typedLine.evaluate(line => line.textContent);
    if ((typedMarkerText.match(/9\./g) || []).length !== 1) reproductionFailures.push(`ordered prefix before separator: ${JSON.stringify(typedMarkerText)}`);
    const bareMarkerState = await typedLine.evaluate(line => ({ prefixes: line.querySelectorAll('.cm-md-list-prefix').length, markers: line.querySelectorAll('.cm-md-list-marker').length }));
    if (bareMarkerState.prefixes !== 1 || bareMarkerState.markers !== 0) reproductionFailures.push(`caret after ordered period: ${JSON.stringify(bareMarkerState)}`);
    await page.keyboard.type(' ');
    const separatedMarkerText = await lines().last().evaluate(line => line.textContent);
    if ((separatedMarkerText.match(/9\./g) || []).length !== 1) reproductionFailures.push(`ordered prefix after separator: ${JSON.stringify(separatedMarkerText)}`);
    const separatedMarkerState = await lines().last().evaluate(line => ({ prefixes: line.querySelectorAll('.cm-md-list-prefix').length, markers: line.querySelectorAll('.cm-md-list-marker').length }));
    if (separatedMarkerState.prefixes !== 0 || separatedMarkerState.markers !== 1) reproductionFailures.push(`caret after ordered separator: ${JSON.stringify(separatedMarkerState)}`);
    await page.keyboard.type('body');
    const completedMarkerText = await lines().last().evaluate(line => line.textContent);
    if ((completedMarkerText.match(/9\./g) || []).length !== 1) reproductionFailures.push(`completed ordered item: ${JSON.stringify(completedMarkerText)}`);
    await page.keyboard.press('Control+Home');
    const previewMarkerText = await lines().last().evaluate(line => line.textContent);
    if ((previewMarkerText.match(/9\./g) || []).length !== 1) reproductionFailures.push(`inactive ordered item: ${JSON.stringify(previewMarkerText)}`);
    const saved = await waitForFile(note, value => value.startsWith('# \n\n\n') && value.endsWith('9. body'));
    assert.ok(saved.startsWith('# \n\n\n') && saved.endsWith('9. body'), 'Enter and preview transitions preserve the exact typed Markdown source');
    assert.deepEqual(reproductionFailures, [], reproductionFailures.join('; '));
  } finally {
    const child = app?.process();
    try { await Promise.race([app?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
