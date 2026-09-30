const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const { _electron: electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

const appRoot = path.resolve(__dirname, '..');
let smokeWorkspace;
let fixtureRoot;
let userData;
const canary = 'FORCED_CRASH_RECOVERY_CANARY_7d9f';
const explicitCanary = 'EXPLICIT_RECOVERY_CANARY_4a61';

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]).finally(() => clearTimeout(timer));
}

async function makeFixture() {
  smokeWorkspace = await createSmokeWorkspace('recovery-smoke');
  fixtureRoot = smokeWorkspace.fixture; userData = smokeWorkspace.userData;
  const docs = path.join(fixtureRoot, '资料');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, '主笔记.md'), '# 主笔记\n\n原有正文。\n', 'utf8');
  await fs.writeFile(path.join(docs, '副笔记.md'), '# 副笔记\n\n第二栏。\n', 'utf8');
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]); pdf.addPage([595, 842]);
  await fs.writeFile(path.join(docs, '阅读.pdf'), await pdf.save());
}

after(async () => { if (smokeWorkspace) await cleanupSmokeWorkspace(smokeWorkspace); });

function launchArgs(executablePath, explicitPath) {
  if (process.env.ZHAOYE_EXE) return explicitPath ? [explicitPath] : [];
  return explicitPath ? [appRoot, explicitPath] : [appRoot];
}

async function launch(executablePath, explicitPath) {
  console.log('SMOKE launch', explicitPath || '(session restore)');
  const instance = await electron.launch({
    executablePath,
    args: launchArgs(executablePath, explicitPath),
    env: { ...process.env, ZHAOYE_TEST_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 15000,
  });
  const page = await instance.firstWindow();
  await page.waitForSelector('.topbar', { timeout: 15000 });
  return { instance, page };
}

async function forceStop(instance) {
  const child = instance.process();
  const exited = new Promise(resolve => child.once('exit', resolve));
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await withTimeout(exited, 10000, 'forced app process did not exit');
  await new Promise(resolve => setTimeout(resolve, 750));
}

async function closeNormally(instance, page) {
  const child = instance.process();
  const exited = new Promise(resolve => child.once('exit', resolve));
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await withTimeout(exited, 15000, 'app did not complete its save-and-close flow');
}

test('packaged app restores session and crash draft without putting note text in userData', { timeout: 120000 }, async () => {
  await makeFixture();
  const executablePath = process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const notePath = path.join(fixtureRoot, '资料', '主笔记.md');
  const secondPath = path.join(fixtureRoot, '资料', '副笔记.md');
  let instance;

  try {
    ({ instance } = await launch(executablePath, fixtureRoot));
    console.log('SMOKE first window');
    let page = await instance.firstWindow();
    await page.locator('.file-row').filter({ hasText: /^资料$/ }).click();
    await page.locator('.file-row').filter({ hasText: '主笔记.md' }).click();
    await page.locator('.markdown-source-editor .cm-content').locator('.cm-line').filter({ hasText: '主笔记' }).waitFor();
    await page.getByRole('button', { name: '左右分屏笔记', exact: true }).click();
    await page.locator('.secondary-note .cm-content').locator('.cm-line').filter({ hasText: '副笔记' }).waitFor();
    await page.locator('.file-row').filter({ hasText: '阅读.pdf' }).click();
    console.log('SMOKE opened PDF');
    await page.waitForSelector('canvas');
    await page.waitForFunction(() => (document.querySelector('canvas')?.width || 0) > 100);
    await page.getByText('/ 2 页', { exact: true }).waitFor();
    await page.locator('.zoom-control button[aria-label="放大"]').click();
    const splitter = await page.locator('.splitter').boundingBox();
    assert.ok(splitter);
    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 50);
    await page.mouse.down(); await page.mouse.move(splitter.x + 30, splitter.y + 50); await page.mouse.up();
    await page.locator('.sidebar-toggle').click();
    console.log('SMOKE layout configured');
    const pageInput = page.locator('input[aria-label="当前页码"]');
    await page.getByText('/ 2 页', { exact: true }).waitFor();
    await pageInput.fill('2');
    await pageInput.press('Enter');
    await page.waitForFunction(() => document.querySelector('input[aria-label="当前页码"]')?.value === '2');
    let pageSession;
    for (let tries = 0; tries < 40; tries += 1) {
      pageSession = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).session;
      if (pageSession?.activePdf?.page === 2) break;
      await page.waitForTimeout(50);
    }
    assert.equal(pageSession?.activePdf?.page, 2);
    console.log('SMOKE PDF page set to 2');
    await page.waitForTimeout(500);
    await closeNormally(instance, page);
    console.log('SMOKE first close completed');
    instance = null;

    let savedSettings = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    assert.equal(savedSettings.session.root, fixtureRoot);
    assert.equal(savedSettings.session.currentDirectory, path.join(fixtureRoot, '资料'));
    assert.equal(savedSettings.session.layout, 'split');
    assert.equal(savedSettings.session.sidebar, false);
    assert.deepEqual(savedSettings.session.noteTabs.sort(), [notePath, secondPath].sort());
    assert.equal(savedSettings.session.primaryNote.path, notePath);
    assert.equal(savedSettings.session.secondaryNote.path, secondPath);
    assert.equal(savedSettings.session.activePdf.path, path.join(fixtureRoot, '资料', '阅读.pdf'));
    assert.equal(JSON.stringify(savedSettings).includes(canary), false);

    ({ instance, page } = await launch(executablePath));
    console.log('SMOKE restored window');
    await page.locator('.document-tab').filter({ hasText: '主笔记.md' }).waitFor();
    await page.getByRole('button', { name: '阅读', exact: true }).waitFor();
    assert.equal(await page.locator('.sidebar').count(), 0);
    assert.equal(await page.locator('.layout-tabs button[aria-pressed="true"]').textContent(), '对照');
    assert.equal(await page.locator('.secondary-note select').inputValue(), secondPath);
    await page.locator('.document-tab').filter({ hasText: '主笔记.md' }).waitFor();
    await page.locator('.document-tab').filter({ hasText: '副笔记.md' }).waitFor();
    await page.locator('input[aria-label="当前页码"]').waitFor();
    await page.waitForFunction(() => document.querySelector('input[aria-label="当前页码"]')?.value === '2');
    console.log('SMOKE session UI restored');

    // Restoring chrome/tabs is not enough: both untouched bodies must survive
    // the autosave and file-poll windows before the test starts editing.
    await page.waitForTimeout(3800);
    assert.equal(await fs.readFile(notePath, 'utf8'), '# 主笔记\n\n原有正文。\n');
    assert.equal(await fs.readFile(secondPath, 'utf8'), '# 副笔记\n\n第二栏。\n');
    assert.ok((await page.locator('.panes > .note-pane .cm-content').first().innerText()).includes('原有正文。'));

    const editor = page.locator('.panes > .note-pane .markdown-source-editor .cm-content').first();
    await editor.waitFor();
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText(canary);
    await page.locator('.note-toolbar .compact-save').filter({ hasText: '编辑中' }).waitFor();
    console.log('SMOKE recovery draft dirty');
    const recoveryFile = path.join(fixtureRoot, '资料', '.reader', 'recovery', `${savedSettings.session.primaryNote.recoveryId}.json`);
    for (let tries = 0; tries < 30; tries += 1) {
      try { await fs.access(recoveryFile); break; } catch { await page.waitForTimeout(50); }
    }
    assert.equal(await fs.readFile(notePath, 'utf8').then(text => text.includes(canary)), false);
    const recovery = JSON.parse(await fs.readFile(recoveryFile, 'utf8'));
    assert.ok(recovery.content.replaceAll('\\_', '_').includes(canary));
    savedSettings = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    assert.equal(JSON.stringify(savedSettings).includes(canary), false);

    await forceStop(instance); instance = null;
    console.log('SMOKE forced stop completed');
    ({ instance, page } = await launch(executablePath));
    console.log('SMOKE crash recovery launch');
    await page.locator('.panes > .note-pane .markdown-source-editor .cm-content').first().getByText(canary, { exact: false }).waitFor();
    await page.waitForTimeout(1400);
    console.log('SMOKE crash draft autosaved');
    assert.ok((await fs.readFile(notePath, 'utf8')).replaceAll('\\_', '_').includes(canary));
    await assert.rejects(() => fs.access(recoveryFile));
    savedSettings = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    assert.equal(JSON.stringify(savedSettings).includes(canary), false);
    await closeNormally(instance, page); instance = null;
    console.log('SMOKE recovery app closed');

    ({ instance, page } = await launch(executablePath));
    const explicitDraftEditor = page.locator('.panes > .note-pane .markdown-source-editor .cm-content').first();
    await explicitDraftEditor.waitFor();
    await explicitDraftEditor.click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText(explicitCanary);
    await page.locator('.note-toolbar .compact-save').filter({ hasText: '编辑中' }).waitFor();
    const currentSettings = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    const explicitRecoveryFile = path.join(fixtureRoot, '资料', '.reader', 'recovery', `${currentSettings.session.primaryNote.recoveryId}.json`);
    for (let tries = 0; tries < 30; tries += 1) {
      try { await fs.access(explicitRecoveryFile); break; } catch { await page.waitForTimeout(30); }
    }
    assert.ok(JSON.parse(await fs.readFile(explicitRecoveryFile, 'utf8')).content.replaceAll('\\_', '_').includes(explicitCanary));
    await forceStop(instance); instance = null;
    ({ instance, page } = await launch(executablePath, notePath));
    console.log('SMOKE explicit recovery launch');
    await page.locator('.panes > .note-pane .markdown-source-editor .cm-content').first().getByText(explicitCanary, { exact: false }).waitFor();
    assert.equal(await page.locator('.document-tab.active').innerText(), '主笔记.md');
    await page.waitForTimeout(1400);
    assert.ok((await fs.readFile(notePath, 'utf8')).replaceAll('\\_', '_').includes(explicitCanary));
    await assert.rejects(() => fs.access(explicitRecoveryFile));
    await closeNormally(instance, page); instance = null;
    console.log('SMOKE explicit recovery saved');

    ({ instance, page } = await launch(executablePath, secondPath));
    console.log('SMOKE explicit launch');
    await page.locator('.markdown-source-editor .cm-content').locator('.cm-line').filter({ hasText: '副笔记' }).waitFor();
    assert.equal(await page.locator('.document-tab.active').innerText(), '副笔记.md');
    await closeNormally(instance, page); instance = null;
  } finally {
    if (instance) {
      try { execFileSync('taskkill.exe', ['/PID', String(instance.process().pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      try { await instance.close(); } catch {}
    }
  }
});
