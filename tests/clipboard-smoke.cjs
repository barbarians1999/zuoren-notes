const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const appRoot = path.resolve(__dirname, '..');
let smokeWorkspace;
let application;
after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(r => setTimeout(r, 2500))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (smokeWorkspace) await cleanupSmokeWorkspace(smokeWorkspace);
});
test('clipboard source, HTML tasks/tables, styling, safe images and undo round-trip', { timeout: 90000 }, async () => {
  smokeWorkspace = await createSmokeWorkspace('clipboard-smoke');
  const root = smokeWorkspace.fixture;
  await fs.mkdir(root, { recursive: true });
  const note = path.join(root, 'clipboard.md');
  await fs.writeFile(note, '');
  await fs.writeFile(path.join(root, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a82kAAAAASUVORK5CYII=', 'base64'));
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  application = await electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE ? [root] : [appRoot, root], env: { ...process.env, ZHAOYE_TEST_USER_DATA: path.join(root, 'profile') } });
  const page = await application.firstWindow(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.locator('.file-row').filter({ hasText: 'clipboard.md' }).click();
  const editor = page.locator('.cm-content');
  async function paste(payload) {
    await editor.click(); await page.keyboard.press('Control+A');
    await editor.evaluate((el, data) => {
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, payload);
    await page.keyboard.press('Control+A');
    return editor.evaluate(el => {
      const transfer = new DataTransfer();
      el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }));
      return { plain: transfer.getData('text/plain'), md: transfer.getData('text/markdown') };
    });
  }
  for (const source of ['first\r\nsecond\n\nparagraph', '## Heading\n\n- [ ] task\n- [x] done\n\n~~strike~~\n', '<br /> literal \\ slash', 'const a = 1;\nconsole.log(a);']) {
    const copied = await paste({ 'text/plain': source });
    assert.equal(copied.md, source.replaceAll('\r\n', '\n'));
    assert.equal(copied.plain, copied.md);
  }
  const wrapped = await paste({ 'text/plain': '**bold**\n\n## Heading', 'text/html': '<p><span>**bold**</span></p><p>## Heading</p>' });
  assert.equal(wrapped.md, '**bold**\n\n## Heading', 'plain wrappers cannot escape Markdown');
  const rich = await paste({ 'text/html': '<div>first<br>second</div><p><span style="font-weight:700">bold</span> <span style="font-style:italic">italic</span></p><ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">todo</li></ul><ol start="3"><li>three</li></ol><table><tr><th>A</th><th>B</th></tr><tr><td>x</td><td>y</td></tr></table><p><a href="javascript:alert(1)">bad link</a></p><script>evil</script>' });
  for (const fragment of ['first\nsecond', '**bold**', '*italic*', '- [x] done', '- [ ] todo', '3. three', '| A | B |', '| --- | --- |', '| x | y |']) assert.ok(rich.md.includes(fragment), fragment + ': ' + rich.md);
  assert.doesNotMatch(rich.md, /javascript:|<script|evil/);
  const codeBody = 'first\n\n\nlast\n\n\n\nend';
  const code = await paste({ 'text/html': '<p>before</p><pre><code>' + codeBody + '</code></pre><p>after</p>' });
  assert.ok(code.md.includes('```\n' + codeBody + '\n```'), 'rich paste preserves all blank lines inside code');
  await waitForFile(note, value => value === code.md);
  await editor.focus(); await page.keyboard.press('Control+z');
  await waitForFile(note, value => value === rich.md);
  const vscode = await paste({ 'text/plain': '## raw\n**exact**', 'text/html': '<pre>different</pre>', 'vscode-editor-data': '{}' });
  assert.equal(vscode.md, '## raw\n**exact**');
  const preferred = await paste({ 'text/plain': 'fallback', 'text/markdown': '~~preferred~~', 'text/html': '<b>other</b>' });
  assert.equal(preferred.md, '~~preferred~~');
  const cut = await editor.evaluate(el => {
    const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: data })); return data.getData('text/markdown');
  });
  assert.equal(cut, '~~preferred~~'); assert.equal((await editor.innerText()).trim(), '');
  await page.keyboard.press('Control+z'); assert.match(await editor.innerText(), /preferred/);
  const source = '# Images\n\n![local](pixel.png)\n\n~~~md\n![literal](pixel.png)\n~~~\n';
  await paste({ 'text/markdown': source });
  await page.getByRole('button', { name: '切换到预览' }).click();
  const preview = page.locator('.markdown-preview');
  await preview.locator('img').waitFor();
  assert.equal(await preview.locator('img').count(), 1);
  await page.waitForFunction(() => document.querySelector('.markdown-preview img')?.naturalWidth === 1);
  assert.match(await preview.locator('pre').innerText(), /!\[literal\]\(pixel.png\)/, 'code examples must not be rewritten');
  await page.getByRole('button', { name: '切换到源码编辑' }).click();
  await waitForFile(note, text => text === source); assert.equal(await fs.readFile(note, 'utf8'), source);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await application.waitForEvent('close'); application = undefined;
  assert.deepEqual(errors, []);
});
