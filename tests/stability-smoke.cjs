const { noteUI, focusNote, moreAction } = require('./noteUi.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const corpus = require('./fixtures/markdown-contract.cjs');
const appRoot = path.resolve(__dirname, '..');
let application, workspace;
after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});
async function launch(args) {
  const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
  application = await electron.launch({ executablePath: packaged || path.join(appRoot, 'node_modules/electron/dist/electron.exe'),
    args: packaged ? args : [appRoot, ...args], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  return page;
}
async function wholeSource(page, editor) {
  await editor.click(); await page.keyboard.press('Control+a');
  const text = await editor.evaluate(element => {
    const data = new DataTransfer(); element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/markdown');
  });
  await page.keyboard.press('ArrowRight'); return text;
}
async function pasteSource(editor, text) {
  await editor.evaluate((element, source) => {
    const data = new DataTransfer(); data.setData('text/markdown', source);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}
test('shared Markdown corpus, real IME, continuous edits, undo, saved revision and cold reopen', { timeout: 90000 }, async () => {
  workspace = await createSmokeWorkspace('stability'); await fs.mkdir(workspace.fixture, { recursive: true });
  const note = path.join(workspace.fixture, 'continuous.md'), other = path.join(workspace.fixture, 'other.md');
  await fs.writeFile(note, 'cursor\n\n'); await fs.writeFile(other, 'other\n');
  const page = await launch([workspace.fixture]); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.file-row').filter({ hasText: 'continuous.md' }).click();
  const pane = noteUI(page, 'primary'), editor = pane.locator('.cm-content'); await editor.waitFor();
  for (const item of corpus) {
    await editor.click(); await page.keyboard.press('Control+a'); await pasteSource(editor, 'cursor\n\n' + item.source + '\n');
    await page.keyboard.press('Control+Home');
    await pane.locator(item.live).first().waitFor();
    if (item.count) assert.equal(await pane.locator(item.live).count(), item.count, item.name);
    if (item.text) assert.ok((await pane.locator(item.live).first().innerText()).includes(item.text), item.name);
    await pane.getByRole('button', { name: '切换到预览', exact: true }).click();
    const read = pane.locator('.markdown-preview'); await read.locator(item.read).first().waitFor();
    if (item.count) assert.equal(await read.locator(item.read).count(), item.count, item.name);
    if (item.text) assert.ok((await read.locator(item.read).first().innerText()).includes(item.text), item.name);
    await pane.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
    assert.equal(await wholeSource(page, editor), 'cursor\n\n' + item.source + '\n', 'rendering cannot rewrite source: ' + item.name);
  }
  // Establish a base, then run mixed operations without artificial flushes.
  const base = 'cursor\n\n' + corpus.map(item => item.source).join('\n\n') + '\n\nend';
  await editor.click(); await page.keyboard.press('Control+a'); await pasteSource(editor, base);
  const cdp = await page.context().newCDPSession(page); let expected = base;
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.keyboard.press('Control+End');
    const text = `中文输入${cycle}`;
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.insertText', { text });
    await page.keyboard.press('Enter'); await page.keyboard.insertText(`cycle-${cycle}`);
    expected += text + '\n' + `cycle-${cycle}`;
    await page.keyboard.down('Shift'); await page.keyboard.press('Home'); await page.keyboard.up('Shift');
    const cut = await editor.evaluate(element => {
      const data = new DataTransfer(); element.dispatchEvent(new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }));
      return data.getData('text/markdown');
    });
    assert.equal(cut, `cycle-${cycle}`); await pasteSource(editor, cut);
    await pane.getByRole('button', { name: '切换到预览', exact: true }).click();
    await pane.getByRole('button', { name: '切换到源码编辑', exact: true }).click();
    await page.keyboard.press('Control+End'); await page.keyboard.insertText('UNDO-ME'); await page.keyboard.press('Control+z');
    assert.equal(await wholeSource(page, editor), expected, 'continuous source equality cycle ' + cycle);
  }
  await pane.locator('.compact-save').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await fs.readFile(note, 'utf8'), expected, 'a displayed successful save must equal the authoritative model');
  // Ctrl+H must not schedule a competing delayed focus into Replace.
  for (let cycle = 0; cycle < 6; cycle++) {
    await editor.click(); await page.keyboard.press('Control+h');
    await pane.getByRole('textbox', { name: '查找文本' }).fill('中文输入');
    await pane.getByText('1 / 4', { exact: true }).waitFor();
    assert.equal(await pane.getByRole('textbox', { name: '替换为' }).inputValue(), '');
    await page.keyboard.press('Escape');
  }
  const trace = await page.evaluate(() => window.readerDiagnostics.snapshot());
  assert.ok(trace.some(event => event.operation === 'save.commit' && event.submittedRevision === event.committedRevision));
  assert.ok(trace.length <= 200); assert.equal(JSON.stringify(trace).includes('中文输入'), false);
  await page.locator('.file-row').filter({ hasText: 'other.md' }).click();
  await page.locator('.file-row').filter({ hasText: 'continuous.md' }).click();
  assert.equal(await wholeSource(page, editor), expected);
  await application.evaluate(() => {
    const { createRequire }=process.mainModule.require('node:module');
    const load=createRequire(process.mainModule.require('electron').app.getAppPath()+'/package.json');
    const { FileStore }=load('./electron/storage.cjs');
    const save=FileStore.prototype.saveNote;
    FileStore.prototype.saveNote=async function(input) { FileStore.prototype.saveNote=save; throw Error('injected close write failure'); };
  });
  await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('discard-canary');
  await page.getByRole('button', { name: '关闭 continuous.md', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByRole('button', { name: '关闭 continuous.md', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await fs.readFile(note, 'utf8'), expected, 'discarding on tab close cannot secretly save the discarded draft');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await application.waitForEvent('close', { timeout: 15000 }); application = undefined;
  const reopened = await launch([note]);
  assert.equal(await wholeSource(reopened, reopened.locator('[data-pane-id=primary] .cm-content')), expected);
  assert.deepEqual(errors, []);
});

test('delayed search and directory responses never overwrite the newer choice', { timeout: 45000 }, async () => {
  // Reuse the isolated fixture/profile after closing the cold-reopen instance.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await application.waitForEvent('close', { timeout: 15000 }); application = undefined;
  await fs.mkdir(path.join(workspace.fixture, 'A')); await fs.mkdir(path.join(workspace.fixture, 'B'));
  const page = await launch([workspace.fixture]);
  await page.locator('.file-row').filter({ hasText: /^A$/ }).waitFor();
  await application.evaluate(({ ipcMain }, root) => {
    globalThis.stabilityRequests = { directoryDone: [], searchDone: [] };
    ipcMain.removeHandler('list-directory'); ipcMain.handle('list-directory', async (_event, input) => {
      const name = input.directory.split(/[\\/]/).pop();
      await new Promise(resolve => setTimeout(resolve, name === 'A' ? 350 : 10));
      globalThis.stabilityRequests.directoryDone.push(name);
      return { directory: input.directory, parent: root, breadcrumbs: [{ name, path: input.directory }], entries: [] };
    });
    ipcMain.removeHandler('search'); ipcMain.handle('search', async (_event, input) => {
      await new Promise(resolve => setTimeout(resolve, input.query === 'old' ? 350 : 10));
      globalThis.stabilityRequests.searchDone.push(input.query);
      return [{ path: root + '/continuous.md', name: input.query + '-result.md', relative: '', type: 'md', snippet: input.query, line: 1 }];
    });
  }, workspace.fixture);
  await page.locator('.file-row').filter({ hasText: /^A$/ }).click();
  await page.locator('.file-row').filter({ hasText: /^B$/ }).click();
  await page.waitForFunction(() => document.querySelector('.folder-crumbs [aria-current]')?.textContent === 'B');
  // Wait for the main-process completion signal using bounded polling.
  for (let tries = 0; tries < 50; tries++) {
    if (await application.evaluate(() => globalThis.stabilityRequests.directoryDone.includes('A'))) break;
    await page.waitForTimeout(20);
  }
  assert.equal(await page.locator('.folder-crumbs [aria-current]').innerText(), 'B');
  assert.ok(await application.evaluate(() => globalThis.stabilityRequests.directoryDone.includes('A')), 'old directory request really completed');
  const search = page.getByRole('textbox', { name: '搜索文件名或笔记内容' });
  await search.fill('old'); await search.press('Enter'); await search.fill('new'); await search.press('Enter');
  await page.getByText('new-result.md', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  for (let tries = 0; tries < 50; tries++) {
    if (await application.evaluate(() => globalThis.stabilityRequests.searchDone.includes('old'))) break;
    await page.waitForTimeout(20);
  }
  assert.equal(await page.getByText('old-result.md', { exact: true }).count(), 0);
  assert.equal(await page.getByText('new-result.md', { exact: true }).count(), 0);
  assert.ok(await application.evaluate(() => globalThis.stabilityRequests.searchDone.includes('old')), 'old search request really completed');
});
