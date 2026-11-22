const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, PDFName, StandardFonts, rgb } = require('pdf-lib');
const { _electron: electron, readerReady } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

const appRoot = path.resolve(__dirname, '..');
let workspace, application;

after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});

async function createLargePdf(targetPath) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // Pad with a harmless embedded stream so the valid PDF comfortably exceeds
  // the 1 MiB inline threshold while keeping individual pages quick to render.
  const paddingRef = pdf.context.register(pdf.context.stream(Buffer.alloc(1400 * 1024, 0x20)));
  pdf.catalog.set(PDFName.of('ZuorenPadding'), paddingRef);
  for (let n = 1; n <= 15; n += 1) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`Range Page ${n}`, { x: 72, y: 760, size: 24, font, color: rgb(0.1, 0.15, 0.2) });
    page.drawText(`Target verification marker for page ${n}.`, { x: 72, y: 720, size: 12, font });
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  assert.ok(bytes.length > 1024 * 1024, `expected >1 MiB PDF, got ${bytes.length}`);
  await fs.writeFile(targetPath, bytes);
  return bytes.length;
}

test('large PDF cold-starts via range requests directly at saved page and warms identity cache', { timeout: 90000 }, async () => {
  workspace = await createSmokeWorkspace('pdf-range-smoke');
  await fs.mkdir(workspace.fixture, { recursive: true });
  await fs.mkdir(workspace.userData, { recursive: true });

  const pdfPath = path.join(workspace.fixture, 'large-book.pdf');
  const notePath = path.join(workspace.fixture, 'notes.md');
  await fs.writeFile(notePath, '# Notes\n\nKeep intact.\n', 'utf8');
  const totalSize = await createLargePdf(pdfPath);

  await fs.writeFile(path.join(workspace.userData, 'settings.json'), JSON.stringify({
    roots: [workspace.fixture],
    recentFiles: [pdfPath, notePath],
    session: {
      version: 2,
      root: workspace.fixture,
      currentDirectory: workspace.fixture,
      layout: 'read',
      sidebar: false,
      splitAt: 52,
      noteTabs: [notePath],
      primaryNote: { path: notePath, mode: 'edit', recoveryId: 'a9cd31b5-26c7-48f1-9d0e-b9fe39463af5' },
      secondaryNote: null,
      activePdf: { path: pdfPath, page: 10, scale: 1 },
      activeEpub: null,
      scrollMemory: [],
    },
  }));

  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  const launchArgs = process.env.ZHAOYE_SMOKE_EXECUTABLE ? [] : [appRoot];
  const launchEnv = { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData };

  application = await electron.launch({ executablePath, args: launchArgs, env: launchEnv });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await readerReady(page, 'pdf', 10);
  await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '10');
  const page10Text = await page.locator('[data-pdf-page="10"] .textLayer').textContent();
  assert.ok(page10Text.includes('Range Page 10'), `expected page 10 text, got: ${page10Text}`);

  const page1CanvasWidth = await page.evaluate(() => document.querySelector('[data-pdf-page="1"] canvas')?.width || 0);
  assert.equal(page1CanvasWidth, 0, 'opening at page 10 should not waste work rendering page 1 first');

  // Verify the range IPC path works and transfers partial slices rather than the whole file.
  const directCheck = await page.evaluate(async targetPath => {
    const desc = await window.reader.openPdf(targetPath);
    const chunk = await window.reader.readPdfRange({ path: targetPath, begin: 0, end: 1024 });
    return { rangeMode: desc.rangeMode, hasData: !!desc.data, size: desc.size, chunkLength: chunk.byteLength };
  }, pdfPath);
  assert.equal(directCheck.rangeMode, true);
  assert.equal(directCheck.hasData, false);
  assert.equal(directCheck.size, totalSize);
  assert.equal(directCheck.chunkLength, 1024);

  // Save a note annotation on page 10 and close cleanly.
  await page.getByRole('button', { name: '批注', exact: true }).click();
  await page.locator('[data-pdf-page="10"] .draw-layer.interactive').click({ position: { x: 160, y: 140 } });
  await page.getByPlaceholder('写下批注').fill('range mode note');
  await page.getByRole('button', { name: '保存批注', exact: true }).click();
  await page.getByPlaceholder('写下批注').waitFor({ state: 'hidden' });
  await page.locator('[data-pdf-page="10"] .annotation.note').waitFor();

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await application.waitForEvent('close', { timeout: 12000 });
  application = null;

  const cachePath = path.join(workspace.userData, 'content-identity-cache.json');
  const cacheData = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(cacheData.version, 1);
  assert.ok(Object.keys(cacheData.entries).length >= 1, 'identity cache should persist after clean close');

  // Relaunch and confirm saved annotation & page 10 cold-start with warmed identity cache.
  application = await electron.launch({ executablePath, args: launchArgs, env: launchEnv });
  const page2 = await application.firstWindow();
  page2.setDefaultTimeout(15000);
  page2.on('pageerror', error => errors.push(error.message));

  await readerReady(page2, 'pdf', 10);
  await page2.locator('[data-pdf-page="10"] .annotation.note').waitFor();
  assert.equal(await page2.getByRole('textbox', { name: '当前页码', exact: true }).inputValue(), '10');
  assert.deepEqual(errors, []);
});
