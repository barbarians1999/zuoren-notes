const { noteUI, focusNote, moreAction } = require('./noteUi.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const appRoot = path.resolve(__dirname, '..');
let application, workspace;

after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});
async function paste(editor, source) {
  await editor.evaluate((element, text) => {
    const data = new DataTransfer(); data.setData('text/markdown', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, source);
}
async function replace(page, editor, source) {
  await editor.click(); await page.keyboard.press('Control+a'); await paste(editor, source);
}
async function openNote(page, name, file) {
  await page.locator('.file-row').filter({ hasText: name }).click();
  await page.waitForFunction(file => document.querySelector('[data-pane-id="primary"] .markdown-source-editor')?.dataset.notePath === file, file);
  const mode = noteUI(page, 'primary').getByRole('button',{name:'切换到源码编辑',exact:true});
  if (await mode.count()) await mode.click();
  await page.locator('[data-pane-id="primary"] .cm-content').waitFor({ state: 'visible' });
}
const state = () => application.evaluate(() => ({
  saves: globalThis.__polish.saves, assets: globalThis.__polish.assets.map(item => item.file),
}));
const gate = value => application.evaluate((_electron, value) => { Object.assign(globalThis.__polish, value); }, value);
const releaseAssets = () => application.evaluate(() => {
  for (const item of globalThis.__polish.assets.splice(0)) item.release();
});
async function waitForAsset(name) {
  const deadline = Date.now() + 8000;
  do {
    if ((await state()).assets.some(file => file.endsWith(name))) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Preview did not request expected asset: ' + name);
}

test('manual save, smooth preview and deferred counts preserve document boundaries', { timeout: 120000 }, async t => {
  workspace = await createSmokeWorkspace('editor-polish');
  await fs.mkdir(workspace.fixture, { recursive: true });
  const first = path.join(workspace.fixture, 'first.md'), second = path.join(workspace.fixture, 'second.md');
  await fs.writeFile(first, '# First\n\noriginal\n');
  await fs.writeFile(second, '# Second\n\nother\n');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4uoAAAAASUVORK5CYII=', 'base64');
  for (const name of ['delayed-one.png', 'delayed-two.png', 'delayed-switch.png', 'delayed-timeout.png']) await fs.writeFile(path.join(workspace.fixture, name), image);
  const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
  application = await _electron.launch({
    executablePath: packaged || path.join(appRoot, 'node_modules/electron/dist/electron.exe'),
    args: packaged ? [workspace.fixture] : [appRoot, workspace.fixture],
    env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData },
  });
  assert.deepEqual(await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged })),
    { version: require('../package.json').version, packaged: !!packaged });
  // Instrument the actual loaded storage implementation, including in asar.
  // Do not replace IPC authorization, conflict detection or atomic writes.
  await application.evaluate(({ app }) => {
    const { createRequire } = process.mainModule.require('node:module');
    const load = createRequire(app.getAppPath() + '/package.json');
    const { FileStore } = load('./electron/storage.cjs');
    const originalSave = FileStore.prototype.saveNote, originalChecked = FileStore.prototype.checked;
    globalThis.__polish = { saves: [], assets: [], holdSaves: false, failNext: false, holdAssets: false };
    FileStore.prototype.saveNote = async function(input) {
      const audit = globalThis.__polish;
      audit.saves.push({ path: input.path, content: input.content });
      while (audit.holdSaves) await new Promise(resolve => setTimeout(resolve, 10));
      if (audit.failNext) { audit.failNext = false; throw new Error('injected manual-save failure'); }
      return originalSave.call(this, input);
    };
    FileStore.prototype.checked = async function(file, options) {
      if (options?.asset && globalThis.__polish.holdAssets && /delayed-/.test(file)) {
        await new Promise(release => globalThis.__polish.assets.push({ file, release }));
      }
      return originalChecked.call(this, file, options);
    };
  });
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.file-row').filter({ hasText: 'first.md' }).click();
  const primary = noteUI(page, 'primary'), editor = primary.locator('.cm-content');
  await editor.waitFor();

  await t.test('Ctrl+S uses the save queue, retries and preserves undo; IME is ignored', async () => {
    await page.evaluate(() => { window.__polishEditor = document.querySelector('[data-pane-id="primary"] .cm-editor'); });
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('manual-one');
    const before = (await state()).saves.length;
    const composingAllowed = await editor.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(composingAllowed, true, 'IME key must not be intercepted');
    assert.equal((await state()).saves.length, before);
    await gate({ holdSaves: true }); await page.keyboard.press('Control+s');
    await primary.locator('.markdown-save-state.state-保存中').waitFor();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+s');
    assert.equal((await state()).saves.length, before + 1, 'repeated shortcuts do not start parallel writes');
    await page.keyboard.insertText('-while-saving'); await gate({ holdSaves: false });
    await waitForFile(first, text => text.includes('manual-one-while-saving'));
    await primary.locator('.markdown-save-state.state-已保存').waitFor();
    assert.equal(await page.evaluate(() => window.__polishEditor === document.querySelector('[data-pane-id="primary"] .cm-editor')), true);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => !document.querySelector('[data-pane-id="primary"] .cm-content')?.textContent.includes('-while-saving'));
    await page.keyboard.press('Control+y'); await page.keyboard.press('Control+s');
    await waitForFile(first, text => text.includes('-while-saving'));
    await gate({ failNext: true }); await page.keyboard.insertText('-retry'); await page.keyboard.press('Control+s');
    await primary.locator('.markdown-save-state.state-保存失败').waitFor();
    assert.ok(!(await fs.readFile(first, 'utf8')).includes('-retry'));
    await primary.getByRole('button', { name: '立即保存', exact: true }).click();
    await waitForFile(first, text => text.includes('-retry'));
    await primary.locator('.markdown-save-state.state-已保存').waitFor();
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('-find-save');
    await page.keyboard.press('Control+f');
    await primary.getByRole('textbox', { name: '查找文本', exact: true }).press('Control+s');
    await waitForFile(first, text => text.includes('-find-save'));
    await primary.getByRole('textbox', { name: '查找文本', exact: true }).press('Escape');
  });

  await t.test('left/right and reading-mode shortcuts save only the focused document', async () => {
    await page.locator('.file-row').filter({hasText:'second.md'}).click({button:'right'});
    await page.getByRole('menuitem',{name:'在右侧打开',exact:true}).click();
    const secondary = noteUI(page, 'secondary'), rightEditor = secondary.locator('.cm-content');
    await rightEditor.waitFor();
    await rightEditor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('right-only');
    const before = (await state()).saves.length;
    await page.keyboard.press('Control+s'); await waitForFile(second, text => text.includes('right-only'));
    const saved = (await state()).saves.slice(before);
    assert.ok(saved.length > 0); assert.ok(saved.every(item => item.path === second));
    await rightEditor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('-reading');
    await secondary.getByRole('button', { name: '切换到预览', exact: true }).click();
    const preview = secondary.locator('.markdown-preview:not(.preview-loading)'); await preview.waitFor(); await preview.focus();
    const beforeRead = (await state()).saves.length;
    const allowed = await preview.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
    assert.equal(allowed, false, 'reading-mode Ctrl+S suppresses browser Save As');
    await waitForFile(second, text => text.includes('right-only-reading'));
    assert.ok((await state()).saves.slice(beforeRead).every(item => item.path === second));
    await moreAction(page, '关闭笔记分屏');
    // Switching documents must use the new callback rather than a stale closure.
    await openNote(page, 'second.md', second);
    if (await primary.getByRole('button',{name:'切换到源码编辑',exact:true}).count()) await primary.getByRole('button',{name:'切换到源码编辑',exact:true}).click();
    await primary.locator('.cm-content').waitFor(); await editor.click();
    await page.keyboard.press('Control+End'); await page.keyboard.insertText('-new-target'); await page.keyboard.press('Control+s');
    await waitForFile(second, text => text.includes('-new-target'));
    assert.ok(!(await fs.readFile(first, 'utf8')).includes('-new-target'));
    await openNote(page, 'first.md', first);
  });

  await t.test('manual save cannot bypass an unresolved external conflict', async () => {
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('-mine');
    await fs.writeFile(first, '# External\n\ndisk-only\n'); await page.keyboard.press('Control+s');
    await page.getByRole('button', { name: '使用磁盘内容', exact: true }).waitFor();
    assert.equal(await primary.getByRole('button', { name: '立即保存', exact: true }).isDisabled(), true);
    const before = (await state()).saves.length;
    await editor.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
    assert.equal((await state()).saves.length, before);
    assert.equal(await fs.readFile(first, 'utf8'), '# External\n\ndisk-only\n');
    await page.getByRole('button', { name: '使用磁盘内容', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-pane-id="primary"] .cm-content')?.textContent.includes('disk-only'));
  });

  await t.test('preview retains old content and scroll while updating, rejects stale work and times out safely', async () => {
    const body = '# Preview\n\n' + Array.from({ length: 90 }, (_, i) => 'paragraph ' + i + '\n\n').join('');
    await replace(page, editor, body + 'old-version\n'); await page.keyboard.press('Control+s');
    await waitForFile(first, text => text.includes('old-version'));
    await primary.getByRole('button', { name: '切换到预览', exact: true }).click();
    const preview = primary.locator('.markdown-preview:not(.preview-loading)'); await preview.waitFor();
    await preview.evaluate(element => { element.scrollTop = 700; window.__polishPreview = element; });
    await gate({ holdAssets: true });
    await fs.writeFile(first, body + 'new-version\n\n![image](delayed-one.png)\n');
    await waitForAsset('delayed-one.png');
    assert.ok((await state()).assets.some(file => file.endsWith('delayed-one.png')));
    assert.match(await preview.innerText(), /old-version/);
    assert.equal(await preview.evaluate(element => element.scrollTop), 700);
    assert.equal(await primary.locator('.preview-loading').count(), 0);
    await releaseAssets(); await page.waitForFunction(() => document.querySelector('[data-pane-id="primary"] .markdown-preview')?.textContent.includes('new-version'));
    assert.equal(await preview.evaluate(element => element.scrollTop), 700);
    assert.equal(await page.evaluate(() => window.__polishPreview === document.querySelector('[data-pane-id="primary"] .markdown-preview')), true);
    await fs.writeFile(first, body + 'late-version\n\n![image](delayed-two.png)\n');
    await waitForAsset('delayed-two.png');
    // Test a genuinely new view. An existing tab intentionally keeps its own
    // preview and model until the document's external-change poll settles.
    await page.getByRole('button',{name:'关闭 second.md',exact:true}).click();
    await page.getByRole('button',{name:'关闭 second.md',exact:true}).waitFor({state:'detached'});
    await fs.writeFile(second, '# New document\n\nother-document\n\n![image](delayed-switch.png)\n');
    await openNote(page, 'second.md', second);
    // openEntry selects editing mode, then the new reading surface starts empty.
    if (!await primary.locator('.markdown-preview').count()) await primary.getByRole('button', { name: '切换到预览', exact: true }).click();
    await waitForAsset('delayed-switch.png'); await primary.locator('.preview-loading').waitFor();
    assert.ok(!(await primary.locator('.markdown-preview').innerText()).includes('new-version'));
    await releaseAssets();
    await page.waitForFunction(() => document.querySelector('[data-pane-id="primary"] .markdown-preview')?.textContent.includes('other-document'));
    assert.ok(!(await primary.locator('.markdown-preview').innerText()).includes('late-version'));
    await fs.writeFile(second, '# Fallback\n\nfallback-safe\n\n![image](delayed-timeout.png)\n');
    await waitForAsset('delayed-timeout.png');
    await page.waitForFunction(() => document.querySelector('[data-pane-id="primary"] .markdown-preview')?.textContent.includes('fallback-safe'), null, { timeout: 8000 });
    assert.equal(await primary.locator('.preview-loading').count(), 0);
    await releaseAssets(); await gate({ holdAssets: false });
    await primary.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
  });

  await t.test('counts update after typing settles; new documents never show stale counts', async () => {
    await replace(page, editor, '\u4e2d'.repeat(60000));
    await page.waitForFunction(() => document.querySelector('[data-pane-id="primary"] .word-stats')?.textContent.includes('60,000'));
    await editor.click(); await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\u6587'); await page.keyboard.insertText('\u6587');
    await page.waitForFunction(() => document.querySelector('[data-pane-id="primary"] .word-stats')?.textContent.includes('60,002'));
    await page.keyboard.press('Control+s'); await waitForFile(second, text => text.length === 60002);
    // A file rename can be observed before renderer save acknowledgement.
    // Wait for the queue commit before asking the UI to switch documents.
    await primary.locator('.markdown-save-state.state-已保存').waitFor();
    await openNote(page, 'first.md', first);
    assert.ok(!(await primary.locator('.word-stats').innerText()).includes('60,002'));
    await page.waitForFunction(() => /\u5168\u6587 [\d,]+ \u5b57/.test(document.querySelector('[data-pane-id="primary"] .word-stats')?.textContent || ''));
    if (process.env.ZHAOYE_POLISH_SCREENSHOT) {
      await fs.mkdir(path.dirname(process.env.ZHAOYE_POLISH_SCREENSHOT), { recursive: true });
      if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
      await page.screenshot({ path: process.env.ZHAOYE_POLISH_SCREENSHOT });
    }
  });
  assert.deepEqual(errors, []);
});
