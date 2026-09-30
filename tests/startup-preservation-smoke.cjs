const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const appRoot = process.env.READER_APP_ROOT || path.resolve(__dirname, '..');
const localRequire = createRequire(path.join(appRoot, 'package.json'));
const { _electron: electron } = localRequire('playwright');
const { FileStore } = localRequire('./electron/storage.cjs');
const original = '# Startup preservation\n\nNever lose this body.\n\n- [ ] task\n';

for (const { scenario, pane } of [
  ...['none', 'already-saved', 'corrupt', 'read-error', 'conflict', 'recoverable', 'empty-draft'].map(scenario => ({ scenario, pane: 'primary' })),
  { scenario: 'conflict', pane: 'secondary' }, { scenario: 'recoverable', pane: 'secondary' },
]) {
  test('startup preserves disk and draft: ' + pane + ' ' + scenario, { timeout: 40000 }, async () => {
    const fixture = await fs.mkdtemp(path.join(process.env.READER_FIXTURE_ROOT || path.join(appRoot, 'work'), 'startup-preservation-'));
    const profile = path.join(fixture, 'profile'), note = path.join(fixture, 'note.md');
    const recoveryId = randomUUID(), recoveryDir = path.join(fixture, '.reader', 'recovery');
    const recoveryFile = path.join(recoveryDir, recoveryId + '.json');
    await fs.mkdir(profile);
    await fs.writeFile(note, original);
    const store = new FileStore(); await store.grantRoot(fixture);
    const loaded = await store.readNote(note);
    const draft = scenario === 'empty-draft' ? '' : original + '\nRecovered draft.\n';
    if (['already-saved', 'conflict', 'recoverable', 'empty-draft'].includes(scenario)) {
      await store.writeRecovery({ sourcePath: note, recoveryId, paneHint: pane, baseHash: loaded.hash,
        content: scenario === 'already-saved' ? original : draft, encoding: { bom: loaded.bom, eol: loaded.eol } });
    }
    if (scenario === 'corrupt' || scenario === 'read-error') {
      await fs.mkdir(recoveryDir, { recursive: true });
      if (scenario === 'corrupt') await fs.writeFile(recoveryFile, '{broken');
      else await fs.mkdir(recoveryFile);
    }
    const disk = scenario === 'conflict' ? original + '\nExternal change.\n' : original;
    if (scenario === 'conflict') await fs.writeFile(note, disk);
    await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ roots: [fixture], recentFiles: [note], session: {
      version: 2, root: fixture, currentDirectory: fixture, layout: 'note', sidebar: true, splitAt: 50,
      noteTabs: [note], primaryNote: pane === 'primary' ? { path: note, mode: 'edit', recoveryId } : null,
      secondaryNote: pane === 'secondary' ? { path: note, mode: 'edit', recoveryId } : null,
      activePdf: null, activeEpub: null, scrollMemory: [],
    } }));
    let app;
    try {
      app = await electron.launch({ executablePath: process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules/electron/dist/electron.exe'),
        args: process.env.ZHAOYE_EXE ? [] : [appRoot], env: { ...process.env, ZHAOYE_TEST_USER_DATA: profile }, timeout: 15000 });
      const page = await app.firstWindow(); page.setDefaultTimeout(10000);
      const editor = page.locator(`[data-pane-id=${pane}] .cm-content`).first();
      await editor.waitFor();
      // Exceed recovery (400 ms), autosave (900 ms), and disk polling (3 s).
      await page.waitForTimeout(3800);
      const expected = ['recoverable', 'empty-draft'].includes(scenario) ? draft : disk;
      assert.equal(await fs.readFile(note, 'utf8'), expected, 'startup must not silently replace disk with an uninitialized empty editor');
      const text = await editor.innerText();
      if (expected) assert.ok(text.includes('Never lose this body.'), 'the editor must display the loaded body');
      if (scenario === 'conflict') {
        assert.equal(JSON.parse(await fs.readFile(recoveryFile, 'utf8')).content, draft, 'keep conflicting recovery intact');
        await page.getByRole('button', { name: '保留我的内容', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '关闭冲突提示', exact: true }).count(), 0, 'an unresolved recovery requires an explicit content decision');
        if (pane === 'secondary') {
          await fs.writeFile(note, disk + '\npending-recovery-new-disk\n');
          await page.waitForTimeout(3300); // deliberately cross the 3-second poll gate
          assert.equal((await editor.innerText()).includes('pending-recovery-new-disk'), false, 'an unresolved recovery cannot silently reload the secondary editor');
          assert.equal(JSON.parse(await fs.readFile(recoveryFile, 'utf8')).content, draft);
        }
      } else {
        // A clean close must not turn an untouched, loaded document into an edit.
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await app.waitForEvent('close', { timeout: 12000 }); app = null;
        assert.equal(await fs.readFile(note, 'utf8'), expected);
      }
    } finally {
      if (app) {
        const child = app.process(), pid = child.pid;
        // Unresolved recovery must block normal close/save. Terminate only
        // this isolated fixture process after its preservation assertions.
        if (child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        try { await app.close(); } catch {}
      }
    }
  });
}
