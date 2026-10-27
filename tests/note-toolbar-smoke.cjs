const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { noteUI, focusNote, moreAction } = require('./noteUi.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const appRoot = path.resolve(__dirname, '..');
let application, workspace;
async function assertQuietPaneChrome(page) {
  assert.equal(await page.locator('.note-workspace-bar').evaluate(bar => {
    const swatch = document.createElement('span'); swatch.style.color = 'var(--chrome)'; bar.append(swatch);
    const neutral = getComputedStyle(swatch).color; swatch.remove();
    return getComputedStyle(bar).backgroundColor === neutral && bar.getBoundingClientRect().height === 40;
  }), true, 'one neutral secondary toolbar, without a themed ribbon');
  assert.equal(await page.locator('.foreground-tab').evaluate(tab => getComputedStyle(tab).borderTopColor), 'rgba(0, 0, 0, 0)', 'selected tabs have no card outline');
  const chrome = await page.locator('.note-group:visible').evaluateAll(groups => groups.map((group, index) => {
    const css = getComputedStyle(group);
    const reference = document.createElement('span'); reference.style.borderLeft = '1px solid'; group.append(reference);
    const onePixel = getComputedStyle(reference).borderLeftWidth; reference.remove();
    return { index, edges: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth],
      onePixel, outline: css.outlineStyle, shadow: css.boxShadow };
  }));
  for (const pane of chrome) {
    assert.deepEqual(pane.edges, ['0px', '0px', '0px', pane.index ? pane.onePixel : '0px'], 'no themed frame around note content');
    assert.equal(pane.outline, 'none'); assert.equal(pane.shadow, 'none');
  }
  if (chrome.length > 1) assert.equal(await page.locator('.note-group:visible').last().evaluate(group => {
    const swatch = document.createElement('span'); swatch.style.color = 'var(--line-strong)'; group.append(swatch);
    const neutral = getComputedStyle(swatch).color; swatch.remove();
    return getComputedStyle(group).borderLeftColor === neutral;
  }), true, 'split divider uses the existing separator token, not the active accent');
  const activeGroup = await page.locator('.note-group.active-group:visible').getAttribute('data-note-group');
  assert.equal(await page.locator('.foreground-tab').count(), 1);
  assert.equal(await page.locator('.foreground-tab').evaluate(tab => tab.closest('[data-tabs-group]').dataset.tabsGroup), activeGroup, 'foreground tab still identifies the target pane');
}
after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});
test('single-row chrome routes to the focused view and stays usable across width and themes', { timeout: 90000 }, async t => {
  workspace = await createSmokeWorkspace('note-toolbar'); await fs.mkdir(workspace.fixture, { recursive: true });
  const a = path.join(workspace.fixture, 'a.md'), b = path.join(workspace.fixture, 'b.md');
  await fs.writeFile(a, '# Left\n\nleft body\n'); await fs.writeFile(b, '# Right\n\nright body\n');
  const extra = Array.from({ length: 8 }, (_, i) => `Long-note-title-${i}.md`);
  for (const file of extra) await fs.writeFile(path.join(workspace.fixture, file), '# Heading\n\nbody\n');
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  application = await _electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE ? [workspace.fixture] : [appRoot, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const row = name => page.locator('.file-row').filter({ has: page.getByText(name, { exact: true }) });
  const left = noteUI(page, 'primary'), right = noteUI(page, 'secondary');
  await row('a.md').dblclick(); await left.locator('.cm-content').waitFor();
  const out = process.env.ZUOREN_SCREENSHOT_OUTPUT || workspace.outputs; await fs.mkdir(out, { recursive: true });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await assertQuietPaneChrome(page);
  assert.equal(await page.locator('.sidebar-head').count(), 0, 'remove redundant library title and duplicate file count');
  const sidebarLayout = await page.locator('.sidebar').evaluate(sidebar => {
    const search = sidebar.querySelector('.search'), css = getComputedStyle(sidebar);
    return { first: sidebar.firstElementChild.className, gap: search.getBoundingClientRect().top - sidebar.getBoundingClientRect().top,
      inset: parseFloat(css.paddingTop) + parseFloat(css.borderTopWidth) };
  });
  assert.equal(sidebarLayout.first, 'search');
  assert.ok(Math.abs(sidebarLayout.gap - sidebarLayout.inset) < 1, 'search starts at the top sidebar padding, without a leftover header gap: ' + JSON.stringify(sidebarLayout));
  assert.match(await page.locator('.sidebar .section-title').first().innerText(), /当前文件夹/);
  await t.test('note mode and search hover brighten glyphs without a background tile', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const controls = page.locator('.note-controls-slot');
    const buttons = controls.locator('.workspace-mode-switch button, .workspace-icon-action[aria-label="查找"]');
    assert.equal(await buttons.count(), 3);
    for (const theme of ['浅色', '深色']) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: theme, exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      for (const button of await buttons.all()) {
        await page.mouse.move(1, 1);
        await button.hover();
        await button.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const state = await button.evaluate(async element => {
          await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
          const css = getComputedStyle(element), probe = document.createElement('span');
          probe.style.color = element.classList.contains('active') ? 'var(--accent)' : 'var(--hover-text)';
          element.append(probe);
          const expectedColor = getComputedStyle(probe).color; probe.remove();
          return { background: css.backgroundColor, color: css.color, icon: getComputedStyle(element.querySelector('svg')).color,
            expectedColor, offset: new DOMMatrixReadOnly(css.transform).m42 };
        });
        assert.equal(state.background, 'rgba(0, 0, 0, 0)', 'hover must not create a gray tile');
        assert.equal(state.color, state.expectedColor, 'hover uses the theme accent, preserving active-mode red');
        assert.equal(state.icon, state.color, 'icon and text brighten together');
        assert.equal(state.offset, -1, 'enabled motion gives a subtle one-pixel lift');
      }
    }
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const reduceMotion = page.getByRole('checkbox', { name: /减少动效/ });
    await reduceMotion.check();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await buttons.last().hover();
    assert.equal(await buttons.last().evaluate(element => getComputedStyle(element).transform), 'none', 'reduced motion disables hover movement');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await reduceMotion.uncheck();
    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.mouse.move(1, 1);
  });
  await page.screenshot({ path: path.join(out, 'editor-single-constructivist.png') });
  assert.equal(await page.getByRole('button', { name: '更多笔记操作', exact: true }).count(), 0);
  await left.getByRole('button', { name: '展开大纲', exact: true }).click();
  await left.locator('.note-outline').waitFor();
  await left.getByRole('button', { name: '收起大纲', exact: true }).click();
  await left.locator('.note-outline').waitFor({ state: 'hidden' });
  await t.test('split button returns to the original single view and keeps right-hand notes and undo', async () => {
    const toggle = page.getByRole('button', { name: '左右分屏笔记', exact: true });
    const source = '# Left\n\nleft body\n';
    const editor = left.locator('.cm-content');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await editor.evaluate(element => { window.__splitOriginalEditor = element; });
    await editor.press('Control+End'); await page.keyboard.insertText('split-toggle-edit');
    await toggle.click(); await right.locator('.cm-content').waitFor();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await toggle.getAttribute('title'), '恢复单栏（保留全部标签）');
    await toggle.click(); await page.locator('[data-note-group="secondary"]').waitFor({ state: 'hidden' });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await editor.evaluate(element => element === window.__splitOriginalEditor), true);
    assert.match(await left.locator('.cm-activeLine').innerText(), /split-toggle-edit/, 'the original left cursor is restored');
    await editor.press('Control+z'); await waitForFile(a, text => text === source);
    await toggle.click(); await right.locator('.cm-content').waitFor();
    await row('b.md').click({ button: 'right' }); await page.getByRole('menuitem', { name: '在右侧打开', exact: true }).click();
    await right.getByRole('tab', { name: 'b.md', exact: true }).waitFor();
    await toggle.click(); await page.locator('[data-note-group="secondary"]').waitFor({ state: 'hidden' });
    assert.equal(await left.getByRole('tab', { name: 'b.md', exact: true }).count(), 1, 'another right-hand note remains available as a tab');
    assert.equal(await left.getByRole('tab', { name: 'a.md', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await fs.readFile(a, 'utf8'), source);
    assert.equal(await fs.readFile(b, 'utf8'), '# Right\n\nright body\n');
  });
  await row('b.md').click({ button: 'right' }); await page.getByRole('menuitem', { name: '在右侧打开', exact: true }).click();
  await right.locator('.cm-content').waitFor();
  await t.test('one bar, independent modes, toolbar Find and keyboard target the exact pane', async () => {
    assert.equal(await page.locator('.note-workspace-bar').count(), 1);
    assert.equal(await page.locator('.markdown-breadcrumb, .note-group .note-toolbar').count(), 0);
    await left.locator('.cm-content').evaluate(el => { window.__chromeLeftEditor = el; });
    await focusNote(page, 'primary'); await left.getByRole('button', { name: '切换到预览', exact: true }).click();
    await left.locator('.markdown-preview').waitFor(); assert.equal(await right.locator('.markdown-preview').count(), 0);
    await focusNote(page, 'secondary'); await right.getByRole('button', { name: '切换到预览', exact: true }).click();
    await right.locator('.markdown-preview').waitFor();
    await focusNote(page, 'primary'); await left.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
    assert.equal(await left.locator('.cm-content').evaluate(el => el === window.__chromeLeftEditor), true);
    assert.equal(await right.locator('.markdown-preview').count(), 1);
    await focusNote(page, 'secondary'); await right.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
    await right.getByRole('button', { name: '源码编辑模式', exact: true }).focus(); await page.keyboard.press('Control+f');
    await right.getByRole('textbox', { name: '查找文本', exact: true }).fill('right');
    await right.getByText('1 / 2', { exact: true }).waitFor();
    assert.equal(await left.locator('.find-bar').count(), 0);
    await right.getByRole('button', { name: '关闭查找', exact: true }).click();
  });
  await t.test('save retry and direct outline toggle preserve focus, data and editor history', async () => {
    await application.evaluate(() => {
      const { createRequire } = process.mainModule.require('node:module');
      const load = createRequire(process.mainModule.require('electron').app.getAppPath() + '/package.json');
      const { FileStore } = load('./electron/storage.cjs'), original = FileStore.prototype.saveNote;
      FileStore.prototype.saveNote = async function() { FileStore.prototype.saveNote = original; throw Error('injected toolbar save failure'); };
    });
    await right.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('saved-from-toolbar');
    await right.getByRole('button', { name: '立即保存', exact: true }).focus(); await page.keyboard.press('Control+s');
    await right.locator('.state-保存失败').waitFor();
    assert.ok(!(await fs.readFile(b, 'utf8')).includes('saved-from-toolbar'));
    await right.getByRole('button', { name: '立即保存', exact: true }).click(); await waitForFile(b, text => text.includes('saved-from-toolbar'));
    assert.equal(await fs.readFile(a, 'utf8'), '# Left\n\nleft body\n');
    assert.equal(await page.getByRole('button', { name: '更多笔记操作', exact: true }).count(), 0);
    const outline = right.getByRole('button', { name: '展开大纲', exact: true });
    await outline.focus(); await page.keyboard.press('Enter');
    await right.locator('.note-outline').waitFor(); assert.equal(await left.locator('.note-outline').count(), 0);
    assert.equal(await right.getByRole('button', { name: '收起大纲', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Space'); await right.locator('.note-outline').waitFor({ state: 'hidden' });
    await moreAction(page, '展开大纲'); await right.locator('.note-outline').waitFor();
    await moreAction(page, '收起大纲');
    await right.locator('.cm-content').press('Control+z'); await waitForFile(b, text => !text.includes('saved-from-toolbar'));
    if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
  });
  await t.test('borderless content keeps active tabs, split dividers and keyboard focus across themes', async () => {
    for (const theme of ['浅色', '深色']) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: theme, exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      for (const group of ['primary', 'secondary']) { await focusNote(page, group); await assertQuietPaneChrome(page); }
      const outline = right.getByRole('button', { name: '展开大纲', exact: true });
      await outline.focus();
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      assert.equal(await outline.evaluate(button => getComputedStyle(button).outlineStyle), 'solid', 'keyboard button focus remains visible');
      await right.locator('.cm-content').focus();
      await page.screenshot({ path: path.join(out, `editor-split-${theme}.png`) });
    }
  });
  await t.test('overflow, active-tab reveal, fixed buttons and light/dark chrome at narrow widths', async () => {
    await focusNote(page, 'primary');
    for (const file of extra) { await row(file).dblclick(); await page.waitForFunction(name => document.querySelector('[data-pane-id="primary"] .markdown-source-editor')?.dataset.notePath.endsWith(name), file); }
    await page.screenshot({ path: path.join(out, 'toolbar-wide.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 620));
    await page.waitForTimeout(250);
    const bar = page.locator('.note-workspace-bar'), strip = bar.locator('.document-tab-strip');
    assert.equal(await bar.locator('.markdown-workspace-actions > button:last-child').getAttribute('aria-label'), '展开大纲');
    assert.equal(await strip.evaluate(el => el.scrollHeight <= el.clientHeight), true);
    const visible = await strip.boundingBox(), current = await page.locator('.foreground-tab').boundingBox();
    assert.ok(visible && current && current.x >= visible.x - 1 && current.x + current.width <= visible.x + visible.width + 1, 'current tab is not lost after resizing');
    for (const name of ['新建空白标签', '左右分屏笔记', '展开大纲']) {
      const rect = await page.getByRole('button', { name, exact: true }).boundingBox(), bounds = await bar.boundingBox();
      assert.ok(rect && bounds && rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width, name);
    }
    await page.screenshot({ path: path.join(out, 'toolbar-narrow.png') });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await assertQuietPaneChrome(page);
    await page.screenshot({ path: path.join(out, 'toolbar-dark.png') });
    assert.equal(await page.locator('.cm-content').count(), 2);
  });
  assert.deepEqual(errors, []);
});
