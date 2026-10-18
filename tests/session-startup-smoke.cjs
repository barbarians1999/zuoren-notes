const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const root = path.resolve(__dirname, '..');

for (const [layout, mode, fail] of [['note', 'edit'], ['note', 'preview'], ['read', 'edit'], ['split', 'edit'], ['note', 'edit', true]]) {
  test(`startup paints only settled ${layout}/${mode}${fail ? ' with a settings error' : ''}`, { timeout: 30000 }, async () => {
    const workspace = await createSmokeWorkspace('session-startup');
    let app;
    try {
      await fs.mkdir(workspace.fixture, { recursive: true });
      await fs.mkdir(workspace.userData, { recursive: true });
      const note = path.join(workspace.fixture, 'note.md'), content = '# Startup\n\nKeep this text.\n';
      await fs.writeFile(note, content);
      await fs.writeFile(path.join(workspace.userData, 'settings.json'), JSON.stringify({ roots: [workspace.fixture], recentFiles: [note], session: {
        version: 2, root: workspace.fixture, currentDirectory: workspace.fixture, layout, sidebar: false, splitAt: 52,
        noteTabs: [note], primaryNote: { path: note, mode, recoveryId: 'a9cd31b5-26c7-48f1-9d0e-b9fe39463af5' }, secondaryNote: null,
        activePdf: null, activeEpub: null, scrollMemory: [],
      } }));
      const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE || process.env.ZHAOYE_EXE;
      app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [] : [root], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
      const page = await app.firstWindow();
      await page.waitForFunction(layout => document.querySelector('.app')?.dataset.layout === layout && document.querySelector('.cm-content'), layout);
      await app.evaluate(({ ipcMain }, fail) => {
        const original = ipcMain._invokeHandlers.get('get-settings');
        ipcMain.removeHandler('get-settings');
        ipcMain.handle('get-settings', async (...args) => {
          globalThis.__startupWaiting = true;
          await new Promise(resolve => { globalThis.__releaseStartup = resolve; });
          if (fail) throw Error('Injected startup settings failure');
          return original(...args);
        });
        const read = ipcMain._invokeHandlers.get('read-note');
        ipcMain.removeHandler('read-note');
        ipcMain.handle('read-note', async (...args) => {
          globalThis.__startupReadWaiting = true;
          await new Promise(resolve => { globalThis.__releaseStartupRead = resolve; });
          return read(...args);
        });
      }, fail);
      await page.addInitScript(() => {
        window.__startupPaints = [];
        window.__startupSidebars = [];
        const frame = () => {
          const tabs = document.querySelector('.layout-tabs'), app = document.querySelector('.app');
          if (tabs && getComputedStyle(tabs).visibility === 'visible' && tabs.getBoundingClientRect().height) {
            window.__startupPaints.push(app.dataset.layout);
            window.__startupSidebars.push(document.querySelector('.body').classList.contains('sidebar-hidden'));
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await page.reload();
      await app.evaluate(async () => {
        while (!globalThis.__startupWaiting) await new Promise(resolve => setTimeout(resolve, 10));
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.deepEqual(await page.evaluate(() => window.__startupPaints), [], 'unrestored default layout must never be painted');
      await app.evaluate(() => globalThis.__releaseStartup());
      if (!fail) {
        await app.evaluate(async () => {
          while (!globalThis.__startupReadWaiting) await new Promise(resolve => setTimeout(resolve, 10));
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(await page.evaluate(() => window.__startupPaints), [], 'document restoration also completes before the first visible layout');
        await app.evaluate(() => globalThis.__releaseStartupRead());
      }
      const expectedLayout = fail ? 'split' : layout;
      await page.waitForFunction(layout => window.__startupPaints.includes(layout), expectedLayout);
      assert.deepEqual([...new Set(await page.evaluate(() => window.__startupPaints))], [expectedLayout]);
      if (!fail) assert.ok((await page.evaluate(() => window.__startupSidebars)).every(Boolean), 'saved collapsed sidebar is settled on the first visible frame');
      if (fail) await page.getByRole('status').filter({ hasText: 'Injected startup settings failure' }).waitFor();
      else if (layout === 'note') await page.locator(mode === 'preview' ? '.markdown-preview' : '.cm-content').waitFor();
      assert.equal(await fs.readFile(note, 'utf8'), content);
    } finally {
      if (app) { await app.evaluate(() => { globalThis.__releaseStartup?.(); globalThis.__releaseStartupRead?.(); }).catch(() => {}); await app.close(); }
      await cleanupSmokeWorkspace(workspace);
    }
  });
}
