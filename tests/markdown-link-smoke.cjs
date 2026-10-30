const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

const root = path.resolve(__dirname, '..');
test('Ctrl-click opens Markdown web and local links in both editor and reading preview', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('markdown-link'); let app;
  let outside;
  try {
    await fs.mkdir(path.join(workspace.fixture, '资料夹'), { recursive: true });
    const note = path.join(workspace.fixture, 'links.md');
    const linkedFile = path.join(workspace.fixture, 'linked.md');
    outside = path.join(path.dirname(workspace.fixture), 'outside.md');
    await fs.writeFile(note, [
      '# Links', '',
      '[网页](https://example.test/article)',
      '[本地文件](./linked.md)',
      '[本地文件夹](./资料夹)',
      '<https://example.test/autolink>',
      '[内部标题](#links)', '',
    ].join('\n'));
    await fs.writeFile(linkedFile, '# Linked'); await fs.writeFile(outside, '# Outside');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    const waitForOpenCalls = async (external, paths) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const audit = await app.evaluate(() => globalThis.__markdownLinkAudit);
        if (audit?.external.length === external && audit.paths.length === paths) return audit;
        await page.waitForTimeout(25);
      }
      throw new Error('Timed out waiting for main-process link open calls: ' + JSON.stringify(await app.evaluate(() => globalThis.__markdownLinkAudit)));
    };
    await page.evaluate(() => {
      window.__markdownClickTrace = [];
      window.addEventListener('mousedown', event => window.__markdownClickTrace.push({ type: 'down', ctrl: event.ctrlKey,
        target: event.target instanceof Element ? event.target.closest('[data-markdown-link]')?.getAttribute('data-markdown-link') : null }), true);
      window.addEventListener('click', event => window.__markdownClickTrace.push({ type: 'click', ctrl: event.ctrlKey,
        target: event.target instanceof Element ? event.target.closest('[data-markdown-link]')?.getAttribute('data-markdown-link') : null }), true);
    });
    await app.evaluate(({ ipcMain, shell }, source) => {
      const openExternal = shell.openExternal.bind(shell), openPath = shell.openPath.bind(shell);
      globalThis.__markdownLinkAudit = { external: [], paths: [] }; globalThis.__markdownSource = source;
      Object.defineProperty(shell, 'openExternal', { configurable: true, value: async url => { globalThis.__markdownLinkAudit.external.push(url); } });
      Object.defineProperty(shell, 'openPath', { configurable: true, value: async file => { globalThis.__markdownLinkAudit.paths.push(file); return ''; } });
      globalThis.__restoreMarkdownLinkShell = () => {
        Object.defineProperty(shell, 'openExternal', { configurable: true, value: openExternal });
        Object.defineProperty(shell, 'openPath', { configurable: true, value: openPath });
      };
      globalThis.__markdownLinkHandler = ipcMain._invokeHandlers.get('open-markdown-link');
    }, note);
    const row = page.locator('.file-row').filter({ hasText: 'links.md' }); await row.dblclick();
    const editor = page.locator('[data-note-group="primary"] .cm-content'); await editor.waitFor();
    const liveLink = label => editor.locator('[data-markdown-link]').filter({ hasText: label }).first();
    for (const label of ['网页', '本地文件', '本地文件夹', 'example.test/autolink']) await liveLink(label).waitFor();
    await liveLink('网页').click({ modifiers: ['Control'] });
    await liveLink('本地文件').click({ modifiers: ['Control'] });
    await liveLink('本地文件夹').click({ modifiers: ['Control'] });
    await liveLink('example.test/autolink').click({ modifiers: ['Control'] });
    const editorAudit = await waitForOpenCalls(2, 2);
    assert.deepEqual(editorAudit, {
      external: ['https://example.test/article', 'https://example.test/autolink'],
      paths: [linkedFile, path.join(workspace.fixture, '资料夹')],
    });

    await page.getByRole('button', { name: '切换到预览', exact: true }).click();
    const preview = page.locator('.markdown-preview');
    const previewLink = label => preview.locator('a').filter({ hasText: label }).first();
    await previewLink('网页').click({ modifiers: ['Control'] });
    await previewLink('本地文件夹').click({ modifiers: ['Control'] });
    const previewAudit = await waitForOpenCalls(3, 3);
    assert.deepEqual(previewAudit, {
      external: ['https://example.test/article', 'https://example.test/autolink', 'https://example.test/article'],
      paths: [linkedFile, path.join(workspace.fixture, '资料夹'), path.join(workspace.fixture, '资料夹')],
    });

    const results = await page.evaluate(async sourcePath => {
      let unsafe, unauthorized;
      try { await window.reader.openMarkdownLink({ sourcePath, href: 'javascript:alert(1)' }); } catch (error) { unsafe = error.message; }
      try { await window.reader.openMarkdownLink({ sourcePath, href: '../outside.md' }); } catch (error) { unauthorized = error.message; }
      return { unsafe, unauthorized };
    }, note);
    assert.match(results.unsafe, /只允许打开网页/);
    assert.match(results.unauthorized, /请先通过/);
    const audit = await app.evaluate(() => globalThis.__markdownLinkAudit);
    assert.equal(audit.external.length, 3); assert.equal(audit.paths.length, 3, 'rejected destinations never reach OS openers');
    assert.equal(await fs.readFile(note, 'utf8'), ['# Links', '', '[网页](https://example.test/article)', '[本地文件](./linked.md)', '[本地文件夹](./资料夹)', '<https://example.test/autolink>', '[内部标题](#links)', ''].join('\n'));
    await app.evaluate(() => globalThis.__restoreMarkdownLinkShell());
    await app.close(); app = undefined;
  } finally {
    const child = app?.process();
    if (app) { try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {} }
    if (child?.exitCode === null) require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
    await fs.rm(outside, { force: true });
  }
});
