const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const { FileStore } = require('../electron/storage.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const appRoot = path.resolve(__dirname, '..');
const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
const launchArgs = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE ? [] : [appRoot];

test('cold-start retained drafts and final close commit protect accepted input', { timeout: 90000 }, async t => {
  const workspace = await createSmokeWorkspace('wide-review'); let application;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    await fs.mkdir(workspace.userData, { recursive: true });
    const current = path.join(workspace.fixture, 'current.md');
    const oldDirectory = path.join(workspace.fixture, 'old');
    await fs.mkdir(oldDirectory);
    const old = path.join(oldDirectory, 'old.md');
    await fs.writeFile(current, '# Current\n'); await fs.writeFile(old, 'old baseline');
    const retainedId = randomUUID(), recoveryId = randomUUID(), tabId = randomUUID();
    const store = new FileStore(); await store.grantFile(old);
    await store.writeRecovery({ sourcePath: old, recoveryId: retainedId, paneHint: 'primary',
      baseHash: createHash('sha256').update('old baseline').digest('hex'),
      content: 'preserved old draft', encoding: { bom: false, eol: '\n' } });
    const tab = { id: tabId, path: current, mode: 'edit', preview: false,
      selection: { anchor: 0, head: 0 }, scroll: { edit: 0, preview: 0 } };
    const session = { version: 3, root: null, currentDirectory: null, layout: 'note', sidebar: false,
      splitAt: 52, activePdf: null, activeEpub: null, scrollMemory: [], noteTabs: [current],
      primaryNote: { path: current, mode: 'edit', recoveryId }, secondaryNote: null,
      noteGroups: { primary: { tabs: [tab], activeId: tabId }, secondary: { tabs: [], activeId: null } },
      activeNoteGroup: 'primary', noteDocuments: [{ path: current, recoveryId,
        retainedRecoveries: [{ sourcePath: old, recoveryId: retainedId }] }] };
    // No root or recent-file grant includes the retained source.
    await fs.writeFile(path.join(workspace.userData, 'settings.json'), JSON.stringify({ roots: [], recentFiles: [current], session }));
    application = await _electron.launch({ executablePath, args: launchArgs, env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    const page = await application.firstWindow(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const editor = page.locator('.cm-content'); await editor.waitFor();
    await t.test('retained source outside roots/recent files is readable after restart', async () => {
      const result = await page.evaluate(input => window.reader.checkRecovery(input), { sourcePath: old, recoveryId: retainedId });
      assert.equal(result.status, 'recoverable'); assert.equal(result.recovery.content, 'preserved old draft');
    });
    await t.test('failed settings commit blocks exit, releases input and keeps the accepted note', async () => {
      // Install a failing handler synchronously before the close request. It
      // affects only this isolated test application's session writes.
      await application.evaluate(({ ipcMain }) => {
        globalThis.__originalSaveSession = ipcMain._invokeHandlers.get('save-session');
        ipcMain.removeHandler('save-session');
        ipcMain.handle('save-session', () => { throw Error('injected final settings failure'); });
      });
      await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('BEFORE-FAILED-CLOSE');
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await page.waitForFunction(() => document.body.textContent.includes('injected final settings failure') && !document.querySelector('.app').inert);
      assert.equal(application.process().exitCode, null);
      await waitForFile(current, text => text.includes('BEFORE-FAILED-CLOSE'));
      await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('AFTER-FAILED-CLOSE');
      assert.match(await editor.innerText(), /AFTER-FAILED-CLOSE/);
      await application.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('save-session'); ipcMain.handle('save-session', globalThis.__originalSaveSession);
      });
    });
    await t.test('slow final settings write freezes new input until the actual window close', async () => {
      await waitForFile(current, text => text.includes('AFTER-FAILED-CLOSE'));
      await application.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('save-session');
        globalThis.__closeCommit = { pending: false, release: null, delayNext: true };
        ipcMain.removeHandler('save-session'); ipcMain.handle('save-session', async (event, input) => {
          if (globalThis.__closeCommit.delayNext) {
            globalThis.__closeCommit.delayNext = false; globalThis.__closeCommit.pending = true;
            await new Promise(resolve => globalThis.__closeCommit.release = resolve);
          }
          return original(event, input);
        });
      });
      // Focus remains in the editor before closing. No locator click is used
      // after inert, since Playwright correctly refuses to click an inert node.
      await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('FINAL-ACCEPTED');
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await application.evaluate(async () => {
        while (!globalThis.__closeCommit.pending) await new Promise(resolve => setTimeout(resolve, 10));
      });
      await page.waitForFunction(() => document.querySelector('.app').inert);
      assert.equal(await page.locator('.app').getAttribute('aria-busy'), 'true');
      await page.keyboard.press('Control+End'); await page.keyboard.insertText('LATE-REJECTED');
      assert.doesNotMatch(await editor.innerText(), /LATE-REJECTED/);
      const closed = application.waitForEvent('close', { timeout: 12000 });
      await application.evaluate(() => globalThis.__closeCommit.release()); await closed;
      const saved = await fs.readFile(current, 'utf8');
      for (const accepted of ['BEFORE-FAILED-CLOSE', 'AFTER-FAILED-CLOSE', 'FINAL-ACCEPTED']) assert.match(saved, new RegExp(accepted));
      assert.doesNotMatch(saved, /LATE-REJECTED/);
      const retained = await store.checkRecovery(old, retainedId);
      assert.equal(retained.status, 'recoverable'); assert.equal(retained.recovery.content, 'preserved old draft');
      application = undefined;
    });
    assert.deepEqual(errors, []);
  } finally {
    const child = application?.process();
    if (application) { try { await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {} }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});

test('slow startup restoration merges a sidebar open without duplicates or changing its layout', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('restore-race'); let application;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true }); await fs.mkdir(workspace.userData, { recursive: true });
    const a = path.join(workspace.fixture, 'a.md'), b = path.join(workspace.fixture, 'b.md');
    await fs.writeFile(a, '# A\n'); await fs.writeFile(b, '# B\n');
    const tabs = [a, b].map(file => ({ id: randomUUID(), path: file, mode: 'edit', preview: false,
      selection: { anchor: 0, head: 0 }, scroll: { edit: 0, preview: 0 } }));
    const docs = [a, b].map(file => ({ path: file, recoveryId: randomUUID(), retainedRecoveries: [] }));
    const session = { version: 3, root: workspace.fixture, currentDirectory: workspace.fixture, layout: 'read',
      sidebar: true, splitAt: 52, activePdf: null, activeEpub: null, scrollMemory: [], noteTabs: [a, b],
      primaryNote: { path: b, mode: 'edit', recoveryId: docs[1].recoveryId }, secondaryNote: null,
      noteGroups: { primary: { tabs, activeId: tabs[1].id }, secondary: { tabs: [], activeId: null } },
      activeNoteGroup: 'primary', noteDocuments: docs };
    await fs.writeFile(path.join(workspace.userData, 'settings.json'), JSON.stringify({ roots: [workspace.fixture], recentFiles: [], session }));
    application = await _electron.launch({ executablePath, args: launchArgs, env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    const page = await application.firstWindow(); page.setDefaultTimeout(12000);
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.layout === 'read');
    // Wait for the initial scene to be committed before injecting the next
    // startup's slow read, so no old renderer debounce can overwrite it.
    await waitForFile(path.join(workspace.userData, 'settings.json'), text => text.includes('"version": 3'));
    await application.evaluate(({ ipcMain }, slowPath) => {
      const original = ipcMain._invokeHandlers.get('read-note');
      globalThis.__restoreGate = { pending: false, release: null, delayNext: true };
      ipcMain.removeHandler('read-note'); ipcMain.handle('read-note', async (event, file) => {
        if (file === slowPath && globalThis.__restoreGate.delayNext) {
          globalThis.__restoreGate.delayNext = false; globalThis.__restoreGate.pending = true;
          await new Promise(resolve => globalThis.__restoreGate.release = resolve);
        }
        return original(event, file);
      });
    }, b);
    await page.reload();
    await application.evaluate(async () => { while (!globalThis.__restoreGate.pending) await new Promise(resolve => setTimeout(resolve, 10)); });
    await page.locator('.file-row').filter({ hasText: 'a.md' }).click();
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.layout === 'note');
    await page.locator('.cm-content').waitFor();
    await application.evaluate(() => globalThis.__restoreGate.release());
    await page.getByRole('tab', { name: 'b.md', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'a.md', exact: true }).count(), 1);
    assert.equal(await page.getByRole('tab', { name: 'a.md', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.app').getAttribute('data-layout'), 'note');
    const saved = JSON.parse(await waitForFile(path.join(workspace.userData, 'settings.json'), text => {
      const value = JSON.parse(text).session;
      return value?.layout === 'note' && value.noteGroups.primary.tabs.length === 2;
    })).session;
    assert.ok(require('../electron/session.cjs').validateSession(saved));
    assert.equal(saved.noteGroups.primary.tabs.find(tab => tab.id === saved.noteGroups.primary.activeId).path, a);
  } finally {
    const child = application?.process();
    if (application) { try { await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {} }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
