const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const { _electron } = require('./electronHarness.cjs');
const { digest } = require('../electron/storage.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const appRoot = path.resolve(__dirname, '..');
let workspace, application;
after(async () => {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});

test('PDF native dragging, page geometry, safe text actions, copy and menu deletion', { timeout: 180000 }, async t => {
  workspace = await createSmokeWorkspace('pdf-selection');
  await fs.mkdir(workspace.fixture, { recursive: true });
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= 8; number++) {
    const sheet = pdf.addPage([440, 280]);
    if (number === 4) sheet.setRotation(degrees(90));
    ['Alpha selection first line', 'Bravo selection second line', 'Charlie selection third line'].forEach((text, i) => sheet.drawText(`${text} ${number}`, { font, size: 16, x: 30, y: 235 - i * 28 }));
  }
  const bytes = Buffer.from(await pdf.save()), id = digest(bytes), file = path.join(workspace.fixture, 'selection.pdf');
  await fs.writeFile(file, bytes);
  const other = await PDFDocument.create(); other.addPage([440, 280]).drawText('Other document', { font: await other.embedFont(StandardFonts.Helvetica), size: 16, x: 30, y: 235 });
  await fs.writeFile(path.join(workspace.fixture, 'other.pdf'), await other.save());
  const note = path.join(workspace.fixture, 'target.md'), original = '# Target\n\nOriginal text.\n';
  await fs.writeFile(note, original); await fs.writeFile(path.join(workspace.fixture, 'other.md'), '# Other\n');
  const auxiliary = path.join(workspace.fixture, '.reader'); await fs.mkdir(auxiliary);
  const old = { id: 'd1b98fd8-d1b2-4f71-bbc6-3ea89d353b27', type: 'highlight', anchor: { pdfId: id, page: 3, rotation: 0,
    rects: [{ x: .1, y: .4, w: .2, h: .04 }, { x: .1, y: .4, w: .2, h: .04 }], quote: 'legacy duplicate' }, createdAt: new Date().toISOString() };
  const sidecar = path.join(auxiliary, id + '.json');
  await fs.writeFile(sidecar, JSON.stringify({ version: 1, id, page: 1, annotations: [old] }));
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  application = await _electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE ? [workspace.fixture] : [appRoot, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => {
      window.__pdfCopiedText = String(text);
      await nativeWrite(text);
    } });
  });
  // Opening a directory automatically opens its first Markdown file.
  await page.locator('.cm-content').waitFor();
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+w');
  await page.locator('.cm-content').waitFor({ state: 'hidden' });
  await application.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1280, 950); BrowserWindow.getAllWindows()[0].focus();
    const save = ipcMain._invokeHandlers.get('save-pdf-meta'), anchor = ipcMain._invokeHandlers.get('make-anchor-path');
    globalThis.__pdfAudit = { writes: [], failSave: false, failInsert: false, delaySave: false, delayInsert: false, release: null, pending: false };
    const pause = () => new Promise(resolve => { globalThis.__pdfAudit.release = resolve; globalThis.__pdfAudit.pending = true; });
    ipcMain.removeHandler('save-pdf-meta'); ipcMain.handle('save-pdf-meta', async (event, input) => {
      const audit = globalThis.__pdfAudit; audit.writes.push(structuredClone(input.meta));
      if (audit.failSave) { audit.failSave = false; throw Error('injected selection save failure'); }
      if (audit.delaySave) { audit.delaySave = false; await pause(); }
      return save(event, input);
    });
    ipcMain.removeHandler('make-anchor-path'); ipcMain.handle('make-anchor-path', async (event, input) => {
      const audit = globalThis.__pdfAudit;
      if (audit.failInsert) { audit.failInsert = false; throw Error('injected excerpt failure'); }
      if (audit.delayInsert) { audit.delayInsert = false; await pause(); }
      return anchor(event, input);
    });
  });
  const open = async name => { await page.locator('.file-row').filter({ hasText: name }).click(); };
  const layout = name => page.locator('.layout-tabs').getByRole('button', { name, exact: true });
  await open('selection.pdf'); await layout('阅读').click();
  await page.bringToFront(); await page.evaluate(() => document.fonts.ready);
  const layer = number => page.locator(`[data-pdf-page="${number}"] .textLayer`);
  const ready = number => page.waitForFunction(n => document.querySelector(`[data-pdf-page="${n}"] .textLayer`)?.textContent?.includes('Charlie'), number);
  await ready(1); await ready(2);
  await page.evaluate(() => { window.addEventListener('copy', event => { window.__pdfCtrlCopiedText = event.clipboardData?.getData('text/plain') || ''; }); });
  const toolbar = page.locator('.pdf-text-actions');
  const jump = async number => {
    const input = page.getByRole('textbox', { name: '当前页码', exact: true }); await input.fill(String(number)); await input.press('Enter'); await ready(number);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const point = async (number, line, offset, end) => layer(number).evaluate((element, { line, offset, end }) => {
    const spans = [...element.querySelectorAll('span')].filter(item => item.firstChild?.nodeType === Node.TEXT_NODE);
    const node = spans[line].firstChild, index = Math.min(offset, node.length - 1), range = document.createRange();
    range.setStart(node, index); range.setEnd(node, index + 1);
    const rect = range.getBoundingClientRect();
    if (element.dataset.mainRotation === '90') return { x: rect.left + rect.width / 2, y: end ? rect.bottom - .5 : rect.top + .5 };
    if (element.dataset.mainRotation === '270') return { x: rect.left + rect.width / 2, y: end ? rect.top + .5 : rect.bottom - .5 };
    return { x: end ? rect.right - .5 : rect.left + .5, y: rect.top + rect.height / 2 };
  }, { line, offset, end });
  const drag = async (from = [1, 0, 0, false], to = [1, 2, 999, true]) => {
    const a = await point(...from), b = await point(...to);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    // Pace actual pointer events over browser frames, as a physical drag does.
    // Sending all 15 moves in one frame can coalesce before native selection.
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(a.x + (b.x - a.x) * step / 8, a.y + (b.y - a.y) * step / 8);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await page.mouse.up();
    try { await toolbar.waitFor(); } catch (error) {
      console.error('drag diagnostic', { from, to, a, b }, await page.evaluate(number => ({ selection: window.getSelection()?.toString(), tool: document.querySelector('.pdf-tools [aria-pressed="true"]')?.getAttribute('aria-label'), focus: document.activeElement?.className, viewport: document.querySelector('.pdf-canvas-wrap')?.getBoundingClientRect().toJSON(), holder: document.querySelector(`[data-pdf-page="${number}"] .canvas-holder`)?.getBoundingClientRect().toJSON(), layer: document.querySelector(`[data-pdf-page="${number}"] .textLayer`)?.outerHTML, html: document.querySelector('.pdf-text-actions')?.outerHTML }), from[0]));
      throw error;
    }
  };
  const cancel = async () => { await page.getByRole('button', { name: '取消 PDF 文字选区', exact: true }).click(); await toolbar.waitFor({ state: 'hidden' }); };
  const copy = async () => {
    await page.evaluate(() => { window.__pdfCopiedText = '__copy_pending__'; });
    await page.getByRole('button', { name: '复制 PDF 选中文字', exact: true }).click();
    await page.waitForFunction(() => window.__pdfCopiedText !== '__copy_pending__');
    return page.evaluate(() => window.__pdfCopiedText.replace(/\r\n/g, '\n'));
  };
  const readMeta = async count => JSON.parse(await waitForFile(sidecar, text => JSON.parse(text).annotations.length === count));
  let count = 1;

  await t.test('forward/reverse/partial native selection preserves lines and excludes BR rectangles', async () => {
    await drag();
    const quote = 'Alpha selection first line 1\nBravo selection second line 1\nCharlie selection third line 1';
    assert.equal(await page.locator('.pdf-text-selection').count(), 3);
    assert.equal(await page.locator('.selection-box').count(), 0);
    assert.equal(await toolbar.getByRole('button', { name: '摘录到当前笔记', exact: true }).isDisabled(), true);
    assert.ok(await toolbar.getByRole('button', { name: '摘录到当前笔记', exact: true }).getAttribute('title'));
    const styles = await layer(1).evaluate(el => ({ br: getComputedStyle(el.querySelector('br'), '::selection').backgroundColor, native: getComputedStyle(el.querySelector('span'), '::selection').backgroundColor, overlay: getComputedStyle(document.querySelector('.pdf-text-selection')).borderWidth }));
    assert.equal(styles.br, 'rgba(0, 0, 0, 0)'); assert.equal(styles.native, 'rgba(0, 0, 0, 0)'); assert.equal(styles.overlay, '0px');
    await page.evaluate(() => { window.__pdfCtrlCopiedText = '__copy_pending__'; });
    await page.keyboard.press('Control+c');
    await page.waitForFunction(() => window.__pdfCtrlCopiedText !== '__copy_pending__');
    assert.equal(await page.evaluate(() => window.__pdfCtrlCopiedText.replace(/\r\n/g, '\n')), quote);
    assert.equal(await copy(), quote);
    await cancel(); await drag([1, 2, 999, true], [1, 0, 0, false]); assert.equal(await copy(), quote);
    await page.keyboard.press('Escape'); await toolbar.waitFor({ state: 'hidden' });
    await drag([1, 0, 6, false], [1, 0, 14, true]); assert.equal(await copy(), 'selection');
    await cancel();
  });
  await t.test('starting a drag in the whitespace between PDF lines does not select the remainder of the page', async () => {
    const first = await point(1, 0, 0, false), second = await point(1, 1, 0, false);
    const start = { x: first.x + 2, y: (first.y + second.y) / 2 }, end = await point(1, 1, 999, true);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(start.x + (end.x - start.x) * step / 8, start.y + (end.y - start.y) * step / 8);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await page.mouse.up(); await toolbar.waitFor();
    const selected = await copy();
    assert.equal(selected, 'Bravo selection second line 1');
    assert.ok((await page.locator('.pdf-text-selection').count()) <= 2, 'a gap-start drag must stay near its intended line');
    await cancel();
  });
  await t.test('one highlighter action saves three non-overlapping rectangles; existing marks do not intercept dragging', async () => {
    await drag();
    await toolbar.getByRole('button', { name: '高亮', exact: true }).click(); await toolbar.waitFor({ state: 'hidden' });
    const meta = await readMeta(++count), mark = meta.annotations.at(-1);
    assert.equal(mark.anchor.rects.length, 3); assert.equal(mark.anchor.quote.split('\n').length, 3);
    await page.getByRole('status').filter({ hasText: '高亮已保存' }).waitFor();
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    for (let i = 1; i < 3; i++) assert.ok(mark.anchor.rects[i].y >= mark.anchor.rects[i - 1].y + mark.anchor.rects[i - 1].h);
    await drag(); assert.equal(await page.locator('.pdf-text-selection').count(), 3); assert.equal((await readMeta(count)).annotations.length, count); await cancel();
    const at = await point(1, 0, 5, false); await page.mouse.click(at.x, at.y);
    await page.locator('.pdf-annotation-menu').waitFor(); assert.equal(await page.locator('.inline-undo').count(), 0);
    await page.getByRole('button', { name: '删除 PDF 标记', exact: true }).click(); await readMeta(--count);
    await page.locator('.inline-undo').getByRole('button', { name: '撤销', exact: true }).click(); await readMeta(++count);
  });
  await t.test('cross-page selection creates one batch and one undoable excerpt with separate links', async () => {
    await open('target.md'); await layout('对照').click(); await jump(1);
    await page.getByRole('button', { name: '文字高亮', exact: true }).click();
    await drag([1, 1, 0, false], [2, 1, 999, true]);
    const quote = await copy(); assert.match(quote, /third line 1\n\nAlpha/);
    const before = await application.evaluate(() => globalThis.__pdfAudit.writes.length);
    await toolbar.getByRole('button', { name: '高亮并摘录', exact: true }).click(); await toolbar.waitFor({ state: 'hidden' });
    const meta = await readMeta(count += 2), newMarks = meta.annotations.slice(-2);
    assert.deepEqual(newMarks.map(item => item.anchor.page), [1, 2]);
    assert.equal(newMarks[0].anchor.quote, 'Bravo selection second line 1\nCharlie selection third line 1');
    assert.equal(newMarks[1].anchor.quote, 'Alpha selection first line 2\nBravo selection second line 2');
    assert.equal((await application.evaluate(() => globalThis.__pdfAudit.writes)).slice(before).filter(item => item.annotations.length === count).length, 1, 'cross-page annotations use one write');
    try { await waitForFile(note, text => (text.match(/回到原文/g) || []).length === 2); }
    catch (error) {
      console.error('cross-page persistence diagnostic', { saved: await fs.readFile(note, 'utf8'),
        renderer: await page.evaluate(() => ({ label: document.querySelector('.markdown-save-state')?.textContent, text: document.querySelector('.cm-content')?.textContent, message: document.querySelector('.toast')?.textContent })) });
      throw error;
    }
    const editor = page.locator('.cm-content'); await editor.click(); await page.keyboard.press('Control+z');
    await waitForFile(note, text => text === original); assert.equal(await fs.readFile(note, 'utf8'), original);
    // Copy inside the note must not use the PDF snapshot.
    await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift'); await page.keyboard.press('Control+c');
    assert.doesNotMatch(await application.evaluate(({ clipboard }) => clipboard.readText()), /Alpha selection/);
  });
  await t.test('failed save and partial success retry without duplicating marks, including repeated clicks', async () => {
    await layout('对照').click(); await jump(1); await drag();
    await application.evaluate(() => { globalThis.__pdfAudit.failSave = true; });
    await toolbar.getByRole('button', { name: '高亮', exact: true }).click(); await toolbar.getByRole('button', { name: '重试操作', exact: true }).waitFor();
    await readMeta(count); assert.equal(await page.locator('.pdf-text-selection').count(), 3);
    await toolbar.getByRole('button', { name: '重试操作', exact: true }).evaluate(button => { button.click(); button.click(); });
    await toolbar.waitFor({ state: 'hidden' }); await readMeta(++count);
    await drag(); await application.evaluate(() => { globalThis.__pdfAudit.failInsert = true; });
    await toolbar.getByRole('button', { name: '高亮并摘录', exact: true }).click();
    await toolbar.getByRole('button', { name: '重试摘录', exact: true }).waitFor(); await readMeta(++count);
    assert.equal(await fs.readFile(note, 'utf8'), original);
    await toolbar.getByRole('button', { name: '重试摘录', exact: true }).click(); await toolbar.waitFor({ state: 'hidden' });
    await waitForFile(note, text => text.includes('回到原文')); assert.equal((await readMeta(count)).annotations.length, count);
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+z'); await waitForFile(note, text => text === original);
  });
  await t.test('slow operations keep their captured target and late completion cannot clear a new selection', async () => {
    await jump(1); await drag();
    await application.evaluate(() => { globalThis.__pdfAudit.delayInsert = true; globalThis.__pdfAudit.pending = false; });
    await toolbar.getByRole('button', { name: '摘录到当前笔记', exact: true }).click();
    await application.evaluate(async () => { while (!globalThis.__pdfAudit.pending) await new Promise(resolve => setTimeout(resolve, 10)); });
    await open('other.md'); await layout('对照').click();
    await application.evaluate(() => { globalThis.__pdfAudit.release(); });
    await drag(); await toolbar.getByRole('button', { name: '摘录到当前笔记', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => ![...document.querySelectorAll('.pdf-text-actions button')].find(el => el.textContent === '摘录到当前笔记')?.disabled);
    await cancel();
    assert.equal(await fs.readFile(note, 'utf8'), original); assert.equal(await fs.readFile(path.join(workspace.fixture, 'other.md'), 'utf8'), '# Other\n');
    await open('target.md'); await layout('对照').click(); await jump(1); await drag();
    await application.evaluate(() => { globalThis.__pdfAudit.delaySave = true; globalThis.__pdfAudit.pending = false; });
    await toolbar.getByRole('button', { name: '高亮', exact: true }).click();
    await application.evaluate(async () => { while (!globalThis.__pdfAudit.pending) await new Promise(resolve => setTimeout(resolve, 10)); });
    await drag([1, 0, 6, false], [1, 0, 14, true]);
    await application.evaluate(() => { globalThis.__pdfAudit.release(); });
    await readMeta(++count); assert.equal(await copy(), 'selection'); await cancel();
    await drag(); await application.evaluate(() => { globalThis.__pdfAudit.delayInsert = true; globalThis.__pdfAudit.pending = false; });
    await toolbar.getByRole('button', { name: '摘录到当前笔记', exact: true }).click();
    await application.evaluate(async () => { while (!globalThis.__pdfAudit.pending) await new Promise(resolve => setTimeout(resolve, 10)); });
    await open('other.pdf'); await application.evaluate(() => { globalThis.__pdfAudit.release(); });
    await page.locator('.file-row.selected').filter({ hasText: 'other.pdf' }).waitFor();
    await toolbar.waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(note, 'utf8'), original);
    await open('selection.pdf'); await jump(1); await drag(); await cancel();
  });
  await t.test('page recycling retains a drag start, releases it after completion, and old sidecars are display-only cleaned', async () => {
    await jump(1); const start = await point(1, 0, 0, false); await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y, { steps: 3 });
    await page.locator('.pdf-canvas-wrap').evaluate(el => { el.scrollTop = el.scrollHeight; }); await ready(8);
    assert.equal(await layer(1).count(), 1, 'drag start text layer stays mounted');
    const end = await point(8, 1, 999, true); await page.mouse.move(end.x, end.y, { steps: 10 }); await page.mouse.up();
    await toolbar.waitFor();
    const recycledQuote = await copy();
    for (let number = 1; number <= 8; number++) assert.match(recycledQuote, new RegExp('Alpha selection first line ' + number), 'all intermediate pages included');
    await layer(1).waitFor({ state: 'detached' }); await cancel();
    await jump(3); assert.equal(await page.locator('[data-pdf-page="3"] [data-annotation-id="' + old.id + '"]').count(), 1);
    assert.deepEqual((await readMeta(count)).annotations.find(item => item.id === old.id), old, 'legacy coordinates never rewritten');
  });
  await t.test('fragmented Chinese text selection uses native dragging without inserted spaces or BR artifacts', async () => {
    // Emulate the individual Chinese glyph spans produced by PDF.js, keeping
    // this synthetic geometry fixture separate from real PDF page assertions.
    await jump(3); await layer(3).evaluate(el => {
      el.replaceChildren();
      ['剩', '余', '价', '值'].forEach((text, i) => { const span = document.createElement('span'); span.textContent = text; span.style.cssText = `left:${30 + i * 20}px;top:45px;font:20px SimSun;transform:none`; el.append(span); });
      el.append(document.createElement('br'));
      ['劳', '动'].forEach((text, i) => { const span = document.createElement('span'); span.textContent = text; span.style.cssText = `left:${30 + i * 20}px;top:80px;font:20px SimSun;transform:none`; el.append(span); });
      const helper = document.createElement('span'); helper.role = 'img'; helper.textContent = 'helper'; el.append(helper);
    });
    await drag([3, 0, 0, false], [3, 5, 0, true]); assert.equal(await copy(), '剩余价值\n劳动');
    assert.equal(await page.locator('.pdf-text-selection').count(), 2); await cancel();
  });
  await t.test('normalized overlays survive zoom; narrow and light/dark popovers stay inside the reading pane', async () => {
    if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
    await jump(1); await drag();
    assert.equal(await page.locator('[data-pdf-page="1"] .pdf-saved-highlight').count(), 0, 'temporary blue selection has no yellow layer underneath');
    const normalized = await page.locator('.pdf-text-selection').first().evaluate(el => [el.style.left, el.style.top, el.style.width, el.style.height]);
    const revision = await layer(1).getAttribute('data-text-revision');
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await page.waitForFunction(before => Number(document.querySelector('[data-pdf-page="1"] .textLayer')?.dataset.textRevision) > Number(before), revision);
    await page.waitForFunction(() => {
      const pop = document.querySelector('.pdf-text-actions')?.getBoundingClientRect();
      return pop && ![...document.querySelectorAll('.textLayer span')].some(span => { const rect = span.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.right > pop.left && rect.left < pop.right && rect.bottom > pop.top && rect.top < pop.bottom; });
    });
    assert.deepEqual(await page.locator('.pdf-text-selection').first().evaluate(el => [el.style.left, el.style.top, el.style.width, el.style.height]), normalized);
    const output = process.env.ZHAOYE_PDF_SELECTION_SCREENSHOTS || workspace.outputs; await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'pdf-selection-wide-light.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
    await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '深色', exact: true }).click(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await jump(1); await drag([1, 0, 0, false], [1, 1, 999, true]);
    await page.waitForFunction(() => {
      const pop = document.querySelector('.pdf-text-actions')?.getBoundingClientRect(), pane = document.querySelector('.pdf-canvas-wrap')?.getBoundingClientRect();
      return pop && pane && pop.left >= pane.left && pop.right <= pane.right && pop.top >= pane.top && pop.bottom <= pane.bottom;
    });
    assert.equal(await page.evaluate(() => {
      const pop = document.querySelector('.pdf-text-actions').getBoundingClientRect();
      return [...document.querySelectorAll('.textLayer span')].some(span => { const rect = span.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.right > pop.left && rect.left < pop.right && rect.bottom > pop.top && rect.top < pop.bottom; });
    }), false, 'floating actions never cover the neighboring unselected line');
    await page.screenshot({ path: path.join(output, 'pdf-selection-narrow-dark.png') });
    await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '浅色', exact: true }).click(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await jump(1); await drag([1, 0, 0, false], [1, 1, 999, true]); await page.screenshot({ path: path.join(output, 'pdf-selection-narrow-light.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 950));
    await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '深色', exact: true }).click(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await jump(1); await drag(); await page.screenshot({ path: path.join(output, 'pdf-selection-wide-dark.png') }); await cancel();
  });
  await t.test('a rotated PDF page retains its rotation and clipped selection geometry', async () => {
    await jump(4); await drag([4, 0, 0, false], [4, 2, 999, true]);
    assert.equal(await copy(), 'Alpha selection first line 4\nBravo selection second line 4\nCharlie selection third line 4');
    await toolbar.getByRole('button', { name: '高亮', exact: true }).click(); await toolbar.waitFor({ state: 'hidden' });
    const mark = (await readMeta(++count)).annotations.at(-1); assert.equal(mark.anchor.rotation, 90); assert.equal(mark.anchor.page, 4);
    for (const rect of mark.anchor.rects) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1 && rect.y + rect.h <= 1);
  });
  assert.equal(digest(await fs.readFile(file)), id, 'source PDF checksum is unchanged');
  assert.deepEqual((await readMeta(count)).annotations.find(item => item.id === old.id), old);
  assert.deepEqual(errors, []);
});
