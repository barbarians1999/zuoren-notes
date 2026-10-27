const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { _electron: electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');

const appRoot = path.resolve(__dirname, '..');
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a82kAAAAASUVORK5CYII=', 'base64');

test('real clipboard image paste stays bound to its source note, retries safely and undoes only its reference', { timeout: 120000 }, async t => {
  const workspace = await createSmokeWorkspace('markdown-images-smoke');
  let application, clipboardSnapshot, clipboardChanged = false, restoreClipboard = async () => {};
  const note = path.join(workspace.fixture, 'images.md'), other = path.join(workspace.fixture, 'other.md');
  const originalNote = '# Images\n\n', originalOther = '# Other\n\n';
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    await fs.writeFile(note, originalNote); await fs.writeFile(other, originalOther);
    const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
    const packaged = !!(process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE);
    application = await electron.launch({ executablePath, args: packaged ? [workspace.fixture] : [appRoot, workspace.fixture],
      env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await application.firstWindow(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));

    clipboardSnapshot = await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      // Materialize the original formats before replacing the OS clipboard.
      // Their contents stay in the isolated main process, never in test logs.
      globalThis.__imageClipboardSnapshot = [];
      let items;
      try { items = await clipboard.read(); } catch { return false; }
      // An empty type list can mean another program has the clipboard open.
      // Do not replace data that Electron cannot prove it can restore.
      if (!items.length || items.some(item => !item.types.length)) return false;
      try {
        for (const item of items) {
          const payload = {};
          for (const type of item.types) payload[type] = await item.getType(type);
          globalThis.__imageClipboardSnapshot.push(new ClipboardItem(payload));
        }
      } catch { globalThis.__imageClipboardSnapshot = []; return false; }
      return true;
    });
    restoreClipboard = async () => {
      if (!clipboardChanged || !clipboardSnapshot) return;
      const restored = await application.evaluate(async ({ clipboard }) => {
        const before = globalThis.__imageClipboardSnapshot;
        if (before.length) await clipboard.write(before); else clipboard.clear();
        const after = await clipboard.read(), checks = [];
        for (const item of before) for (const type of item.types) {
          const actual = after.find(candidate => candidate.types.includes(type));
          if (!actual) { checks.push(false); continue; }
          const expected = await item.getType(type), value = await actual.getType(type);
          checks.push(type === 'electron application/bookmark' ? JSON.stringify(expected) === JSON.stringify(value)
            : Buffer.from(await expected.arrayBuffer()).equals(Buffer.from(await value.arrayBuffer())));
        }
        return checks;
      });
      assert.ok(restored.every(Boolean), 'the original clipboard formats are restored');
      clipboardChanged = false;
    };

    await application.evaluate(({ ipcMain }) => {
      const saveAttachment = ipcMain._invokeHandlers.get('save-attachment');
      globalThis.__imagePasteAudit = { saveAttachment, requests: [], saved: [], opened: [], holdNext: true, failNext: false,
        startedPromise: null, started: null, release: null, openedPromise: null, open: null };
      globalThis.__imagePasteAudit.startedPromise = new Promise(resolve => globalThis.__imagePasteAudit.started = resolve);
      globalThis.__imagePasteAudit.openedPromise = new Promise(resolve => globalThis.__imagePasteAudit.open = resolve);
      ipcMain.removeHandler('save-attachment');
      ipcMain.handle('save-attachment', async (event, input) => {
        const audit = globalThis.__imagePasteAudit;
        audit.requests.push({ sourcePath: input.sourcePath, purpose: input.purpose, extension: input.extension });
        if (audit.holdNext) {
          audit.holdNext = false; audit.started(); await new Promise(resolve => audit.release = resolve);
        }
        if (audit.failNext) { audit.failNext = false; throw Error('injected image attachment failure'); }
        const relativePath = await audit.saveAttachment(event, input);
        audit.saved.push(relativePath); return relativePath;
      });
      ipcMain.removeHandler('open-image');
      ipcMain.handle('open-image', (_event, file) => { const audit = globalThis.__imagePasteAudit; audit.opened.push(file); audit.open(file); });
    });

    const file = name => page.locator('.file-row').filter({ hasText: name });
    await file('images.md').dblclick(); await file('other.md').dblclick();
    const tabA = page.getByRole('tab', { name: /images\.md/ }), tabB = page.getByRole('tab', { name: /other\.md/ });
    const editorA = page.locator('[data-note-group="primary"] .cm-content');
    const editorB = page.locator('[data-note-group="primary"] .cm-content');
    await tabA.click(); await editorA.click(); await page.keyboard.press('Control+End');

    let clipboardPng;
    if (clipboardSnapshot) {
      clipboardChanged = true;
      clipboardPng = await application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
        const png = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG();
        if (!png.length) throw Error('the test bitmap is empty');
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
        const items = await clipboard.read(), image = items.find(item => item.types.includes('image/png'));
        if (!image) throw Error('image/png was not available in the OS clipboard: ' + JSON.stringify(items.map(item => item.types)));
        return Buffer.from(await (await image.getType('image/png')).arrayBuffer()).toString('base64');
      });
    } else {
      clipboardPng = tinyPng.toString('base64');
      t.diagnostic('System clipboard cannot be safely snapshotted; testing an isolated image paste event instead. OS clipboard paste remains unverified.');
    }
    const clipboardHash = createHash('sha256').update(Buffer.from(clipboardPng, 'base64')).digest('hex');
    async function pasteImage() {
      if (clipboardSnapshot) return page.keyboard.press('Control+v');
      await editorA.evaluate((element, encoded) => {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      }, clipboardPng);
    }

    await t.test('Ctrl+V inserts into the captured note and maps the original cursor past later typing', async () => {
      await pasteImage();
      await application.evaluate(async () => await Promise.race([globalThis.__imagePasteAudit.startedPromise,
        new Promise((_, reject) => setTimeout(() => reject(Error('image paste never reached the attachment service')), 10000))]));
      await page.keyboard.insertText('LATE');
      await tabB.click(); await editorB.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('OTHER');
      await application.evaluate(() => globalThis.__imagePasteAudit.release());

      const saved = await waitForFile(note, text => /LATE!\[[^\]]*\]\([^\n)]+\)/.test(text));
      assert.equal((saved.match(/!\[/g) || []).length, 1);
      assert.equal(await waitForFile(other, text => text === originalOther + 'OTHER'), originalOther + 'OTHER');
      assert.equal((await application.evaluate(() => globalThis.__imagePasteAudit.requests)).length, 1);
      assert.deepEqual(await application.evaluate(() => globalThis.__imagePasteAudit.requests[0]), { sourcePath: note, purpose: 'note-image', extension: 'png' });

      const match = saved.match(/!\[[^\]]*\]\(([^\n)]+)\)/); assert.ok(match);
      const imagePath = path.resolve(workspace.fixture, decodeURIComponent(match[1]));
      assert.equal(createHash('sha256').update(await fs.readFile(imagePath)).digest('hex'), clipboardHash);
      const firstAttachment = (await application.evaluate(() => globalThis.__imagePasteAudit.saved))[0];
      assert.equal(path.resolve(workspace.fixture, firstAttachment), imagePath);

      await tabA.click(); await editorA.click(); await page.keyboard.press('Control+Home');
      const image = editorA.locator('img.cm-md-image'); await image.waitFor();
      await page.waitForFunction(() => document.querySelector('[data-note-group="primary"] .cm-content img.cm-md-image')?.naturalWidth > 0);
      assert.equal(await image.evaluate(element => element.naturalWidth), 1);
      await image.click();
      await page.waitForFunction(() => !document.querySelector('[data-note-group="primary"] .cm-content img.cm-md-image'));
      assert.match(await editorA.innerText(), /!\[图片\]/, 'ordinary click reveals the Markdown source');

      await page.keyboard.press('Control+Home');
      const reopenedImage = editorA.locator('img.cm-md-image'); await reopenedImage.waitFor();
      await reopenedImage.click({ modifiers: ['Control'] });
      await application.evaluate(async () => await Promise.race([globalThis.__imagePasteAudit.openedPromise,
        new Promise((_, reject) => setTimeout(() => reject(Error('Ctrl-click did not request opening the original image')), 10000))]));
      assert.deepEqual(await application.evaluate(() => globalThis.__imagePasteAudit.opened), [imagePath]);

      await editorA.click(); await page.keyboard.press('Control+z');
      assert.equal(await waitForFile(note, text => text === originalNote + 'LATE'), originalNote + 'LATE');
      assert.equal(await fs.access(imagePath).then(() => true), true, 'undo removes only the reference; the attachment remains');
      await editorA.click(); await page.keyboard.press('Control+z');
      assert.equal(await waitForFile(note, text => text === originalNote), originalNote);
      assert.equal(await fs.access(imagePath).then(() => true), true);

      await tabA.locator('..').getByRole('button', { name: '关闭 images.md' }).click();
      // Closing awaits the document save. Reopening before the old tab is
      // actually gone can race that asynchronous close.
      await tabA.waitFor({ state: 'detached' });
      await file('images.md').dblclick();
      await tabA.waitFor({ state: 'visible' });
      await page.waitForFunction(path => document.querySelector('[data-note-group="primary"] .markdown-source-editor')?.dataset.notePath === path, note);
      await waitForFile(note, text => text === originalNote);
      assert.equal(await fs.readFile(note, 'utf8'), originalNote, 'reopened note has the saved post-undo content');
    });

    await t.test('attachment failure remains visible and retry saves once without dropping text', async () => {
      await application.evaluate(() => { globalThis.__imagePasteAudit.failNext = true; });
      await tabA.click(); await editorA.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('SAFE');
      await pasteImage();
      const status = page.locator('.note-image-paste-status'); await status.waitFor();
      await status.getByRole('button', { name: '重试' }).waitFor();
      assert.equal((await application.evaluate(() => globalThis.__imagePasteAudit.saved)).length, 1);
      await status.getByRole('button', { name: '重试' }).click();
      const saved = await waitForFile(note, text => text.includes('SAFE') && (text.match(/!\[/g) || []).length === 1);
      assert.match(saved, /SAFE!\[[^\]]*\]\([^\n)]+\)/);
      assert.equal((await application.evaluate(() => globalThis.__imagePasteAudit.saved)).length, 2, 'the failed attempt creates no duplicate attachment');
      assert.equal((await application.evaluate(() => globalThis.__imagePasteAudit.requests[1])).sourcePath, note);
    });

    assert.deepEqual(errors, []);
    await restoreClipboard();
  } finally {
    if (application) {
      try {
        await restoreClipboard();
      } catch {}
      try { await application.close(); } catch {}
    }
    await cleanupSmokeWorkspace(workspace);
  }
});
