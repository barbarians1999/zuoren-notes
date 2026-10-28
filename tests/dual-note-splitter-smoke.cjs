const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const root = path.resolve(__dirname, '..');

test('dual-note mode places a draggable separator between the editors and persists the shared ratio', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('dual-note-splitter'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    await fs.writeFile(path.join(workspace.fixture, 'left.md'), '# Left\n\nLeft note body.\n');
    await fs.writeFile(path.join(workspace.fixture, 'right.md'), '# Right\n\nRight note body.\n');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    const launch = async restore => {
      app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
        args: packaged ? (restore ? [] : [workspace.fixture]) : [root, ...(restore ? [] : [workspace.fixture])],
        env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
      const page = await app.firstWindow(); page.setDefaultTimeout(10000); return page;
    };
    let page = await launch(false);
    const file = name => page.locator('.file-row').filter({ has: page.getByText(name, { exact: true }) });
    await file('left.md').dblclick(); await page.locator('[data-pane-id="primary"] .cm-content').waitFor();
    await file('right.md').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '在右侧打开', exact: true }).click();
    await page.locator('[data-pane-id="secondary"] .cm-content').waitFor();
    await page.locator('.layout-tabs').getByRole('button', { name: '笔记', exact: true }).click();

    const panes = page.locator('.panes.note.dual-notes');
    await panes.waitFor();
    const separator = page.getByRole('separator', { name: '调整左右笔记宽度', exact: true });
    await separator.waitFor();
    const left = page.locator('[data-note-group="primary"]'), right = page.locator('[data-note-group="secondary"]');
    const widths = () => Promise.all([left, right].map(pane => pane.evaluate(element => element.getBoundingClientRect().width)));
    const [rootBox, handleBox, leftBox, rightBox] = await Promise.all([panes.boundingBox(), separator.boundingBox(), left.boundingBox(), right.boundingBox()]);
    assert.ok(rootBox && handleBox && leftBox && rightBox);
    assert.ok(Math.abs(handleBox.x + handleBox.width / 2 - (rootBox.x + leftBox.width)) < 2, 'separator is centered on the pane boundary');

    const [initialLeft, initialRight] = await widths();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 80);
    await page.mouse.down(); await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + 80, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(initial => {
      const groups = [...document.querySelectorAll('.panes.note.dual-notes > .note-group')];
      return groups[0]?.getBoundingClientRect().width > initial + 30 && groups[1]?.getBoundingClientRect().width < initial + 30;
    }, initialLeft);
    const [movedLeft, movedRight] = await widths();
    assert.ok(movedLeft > initialLeft + 30 && movedRight < initialRight - 30);
    assert.ok(await left.locator('.cm-content').innerText().then(text => text.includes('Left note body')));
    assert.ok(await right.locator('.cm-content').innerText().then(text => text.includes('Right note body')));

    await page.waitForFunction(() => !!document.querySelector('.panes')?.style.getPropertyValue('--split-at'));
    const sessionFile = path.join(workspace.userData, 'settings.json');
    await waitForFile(sessionFile, text => JSON.parse(text).session?.splitAt !== 52);
    const saved = JSON.parse(await fs.readFile(sessionFile, 'utf8')).session.splitAt;
    assert.ok(Math.abs(saved - parseFloat(await panes.getAttribute('style').then(style => style.match(/--split-at:\s*([\d.]+)%/)?.[1]))) < 1);

    const child = app.process();
    await app.close(); app = null;
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    page = await launch(true);
    await page.waitForFunction(expected => {
      const panes = document.querySelector('.panes.note.dual-notes');
      return panes && Math.abs(parseFloat(getComputedStyle(panes).getPropertyValue('--split-at')) - expected) < 1;
    }, saved);
    assert.equal(await page.getByRole('separator', { name: '调整左右笔记宽度', exact: true }).count(), 1);
  } finally {
    const child = app?.process();
    if (app) { try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {} }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
