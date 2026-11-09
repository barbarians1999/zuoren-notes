const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

const root = path.resolve(__dirname, '..');

// Test-only observer. Copy measurements already made by the controller instead
// of requesting layout, dispatching transactions, or changing its measure queue.
// Requests queued before installation and the controller's private rejection
// guards are not visible here. A completed write is not proof it was accepted.
function installMotionDiagnostics() {
  const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
  if (!view) throw Error('Motion diagnostic could not locate the test editor');
  const originalRect = Element.prototype.getBoundingClientRect, originalAnimate = Element.prototype.animate;
  const originalMeasure = view.requestMeasure, originalUpdate = view.update;
  const events = [], listeners = [], requests = new WeakMap(), keys = new Map();
  let stage = 'installed', sequence = 0, requestSequence = 0, submission = 0, dropped = 0;
  const probe = window.__motionMeasureProbe = { rectReads: 0, textAnimations: [], caretAnimations: [] };
  const snapshot = () => ({ selection: view.state.selection.ranges.map(({ anchor, head, empty }) => ({ anchor, head, empty })),
    hasFocus: view.hasFocus, documentFocused: document.hasFocus(), composing: view.composing,
    scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft,
    motion: document.querySelector('.app')?.dataset.motion,
    reducedMedia: matchMedia('(prefers-reduced-motion: reduce)').matches,
    tokenCount: document.querySelectorAll('.cm-md-format-token').length,
    counts: { rectReads: probe.rectReads, textAnimations: probe.textAnimations.length, caretAnimations: probe.caretAnimations.length } });
  const safeSnapshot = () => { try { return snapshot(); } catch (error) { return { diagnosticError: error.message }; } };
  const record = (event, details = {}) => {
    try {
      events.push({ sequence: ++sequence, at: performance.now(), stage, event, ...details, state: safeSnapshot() });
      if (events.length > 160) { events.shift(); dropped++; }
    } catch { /* An observer must not interrupt editor work. */ }
  };
  const rect = value => value ? { left: value.left, top: value.top, width: value.width, height: value.height } : null;
  const runs = value => value ? { count: value.length, items: value.slice(0, 24).map(item => ({ key: item.key, rect: rect(item.rect) })) } : null;
  const summarize = value => {
    if (!value || typeof value !== 'object') return null;
    if ('formatChanged' in value && 'runsBefore' in value) return { kind: 'first', head: value.head, from: rect(value.from),
      formatChanged: value.formatChanged, runsBefore: runs(value.runsBefore), geometry: value.runsGeometry,
      scrollTop: value.scrollTop, scrollLeft: value.scrollLeft };
    if ('caretRelative' in value && 'runsGeometry' in value) return { kind: 'final', head: value.head,
      from: rect(value.from), to: rect(value.to), runs: runs(value.runs), geometry: value.runsGeometry,
      scrollTop: value.scrollTop, scrollLeft: value.scrollLeft };
    if ('geometry' in value && 'runs' in value && 'caret' in value) return { kind: 'baseline',
      runs: runs(value.runs), geometry: value.geometry, caret: rect(value.caret) };
    return null;
  };
  Element.prototype.getBoundingClientRect = function() {
    if (this.matches?.('[data-md-motion-key]')) probe.rectReads++;
    return originalRect.call(this);
  };
  Element.prototype.animate = function(frames, options) {
    const kind = this.matches?.('.cm-cursor-primary') ? 'caret' : this.matches?.('[data-md-motion-key]') ? 'text' : null;
    const animation = originalAnimate.call(this, frames, options);
    if (kind === 'text') probe.textAnimations.push({ duration: options?.duration, frames, key: this.getAttribute('data-md-motion-key') });
    if (kind === 'caret') probe.caretAnimations.push({ duration: options?.duration, frames, animation, element: this });
    if (kind) record('animation', { kind, duration: options?.duration, key: this.getAttribute('data-md-motion-key') });
    return animation;
  };
  const keyOf = key => {
    if (key == null) return null;
    if (!keys.has(key)) keys.set(key, keys.size + 1);
    return keys.get(key);
  };
  view.requestMeasure = function(request, ...rest) {
    if (!request) return Reflect.apply(originalMeasure, this, arguments);
    let entry = requests.get(request);
    if (!entry) {
      const id = ++requestSequence;
      entry = { id, wrapped: { ...request } }; requests.set(request, entry);
      entry.read = function(...args) {
        const value = Reflect.apply(request.read, request, args);
        try { record('measure-read', { id, key: keyOf(request.key), measure: summarize(value), empty: value == null }); } catch {}
        return value;
      };
      entry.write = function(...args) {
        record('measure-write-enter', { id, key: keyOf(request.key) });
        const value = Reflect.apply(request.write, request, args);
        record('measure-write-return', { id, key: keyOf(request.key) });
        return value;
      };
    }
    entry.wrapped.key = request.key; entry.wrapped.read = entry.read;
    if (request.write) entry.wrapped.write = entry.write; else delete entry.wrapped.write;
    record('measure-submit', { id: entry.id, key: keyOf(request.key), submission: ++submission });
    return Reflect.apply(originalMeasure, this, [entry.wrapped, ...rest]);
  };
  view.update = function(transactions, ...rest) {
    try { record('update-enter', { transactions: transactions.map(transaction => ({
      docChanged: transaction.docChanged, selection: !!transaction.selection, reconfigured: transaction.reconfigured,
      pointer: transaction.isUserEvent('select.pointer'),
    })) }); } catch {}
    const value = Reflect.apply(originalUpdate, this, [transactions, ...rest]);
    record('update-return'); return value;
  };
  const listen = (target, name) => {
    const listener = event => record(name, { x: event.clientX, y: event.clientY, button: event.button,
      target: { classes: typeof event.target?.className === 'string' ? event.target.className : null,
        key: event.target?.getAttribute?.('data-md-motion-key') ?? null } });
    target.addEventListener(name, listener, true);
    listeners.push(() => target.removeEventListener(name, listener, true));
  };
  for (const name of ['mousedown', 'mouseup', 'focusin', 'focusout']) listen(document, name);
  listen(view.scrollDOM, 'scroll'); listen(window, 'blur');
  window.__motionTrace = {
    mark(name, details) { stage = name; record('stage', details); },
    record,
    read: () => ({ schemaVersion: 1, observation: 'Installed after editor focus; pre-existing queued requests and private acceptance guards are not observed.',
      stage, dropped, current: safeSnapshot(), events: [...events] }),
    dispose() {
      view.requestMeasure = originalMeasure; view.update = originalUpdate;
      Element.prototype.getBoundingClientRect = originalRect; Element.prototype.animate = originalAnimate;
      for (const remove of listeners) remove();
    },
  };
  record('installed');
}

// Importing the observer for its pure unit tests must not launch Electron.
module.exports = { installMotionDiagnostics };
if (require.main === module) test('plain arrows avoid text geometry reads while a distant bold entry still animates its layout', { timeout: 90000 }, async () => {
  const workspace = await createSmokeWorkspace('markdown-motion-perf-smoke'); let app, saveMotionTrace;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const tail = ' trailing words '.repeat(35);
    const source = `Plain lead in begins near this margin with several ordinary words before **bold target**${tail}`;
    await fs.writeFile(path.join(workspace.fixture, 'motion.md'), source);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [workspace.fixture] : [root, workspace.fixture],
      env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.file-row').filter({ hasText: 'motion.md' }).dblclick(); await page.locator('.cm-content').waitFor();
    await page.locator('.cm-content').focus();
    await page.evaluate(installMotionDiagnostics);
    saveMotionTrace = async (outcome, error) => {
      try {
        const diagnostic = await page.evaluate(() => window.__motionTrace.read());
        diagnostic.outcome = outcome;
        diagnostic.testSourceSha256 = require('node:crypto').createHash('sha256').update(await fs.readFile(__filename)).digest('hex');
        if (error) diagnostic.failure = { name: error.name, message: error.message, stack: error.stack };
        const directory = process.env.ZUOREN_UI_DIAGNOSTICS || path.join(root, 'logs', 'verification', 'ui-runs');
        await fs.mkdir(directory, { recursive: true });
        const filename = path.join(directory, `motion-perf-${Date.now()}-${process.pid}.json`);
        await fs.writeFile(filename, JSON.stringify(diagnostic, null, 2) + '\n');
        console.error('format motion trace: ' + filename);
      } catch (failure) { console.error('format motion trace unavailable: ' + failure.message); }
    };
    const textPoint = async (text, edge = 'center') => {
      const point = await page.evaluate(({ text, edge }) => {
        const root = document.querySelector('.cm-content'), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, offset = node.textContent.indexOf(text); if (offset < 0) continue;
          const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + text.length);
          const rect = range.getBoundingClientRect();
          const point = { x: edge === 'left' ? rect.left + 2 : rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          window.__motionTrace.record('click-target', { text, edge, point, range: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
          return point;
        }
        return null;
      }, { text, edge });
      assert.ok(point, `click target ${text} exists`); return point;
    };
    const clickText = async (text, edge = 'center') => {
      const point = await textPoint(text, edge); await page.mouse.click(point.x, point.y); return point;
    };

    await clickText('Plain lead in');
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().duration === 120 && animation.playState === 'running').map(animation => animation.finished.catch(() => {})));
      window.__motionMeasureProbe.rectReads = 0; window.__motionMeasureProbe.textAnimations = []; window.__motionMeasureProbe.caretAnimations = [];
      window.__motionTrace.mark('ordinary-arrow');
    });
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.__motionMeasureProbe.caretAnimations.length > 0);
    const arrowMotion = await page.evaluate(async () => {
      const record = window.__motionMeasureProbe.caretAnimations.at(-1);
      if (record) await record.animation.finished.catch(() => {});
      const rect = record?.element.getBoundingClientRect();
      return record ? { count: window.__motionMeasureProbe.caretAnimations.length, duration: record.duration, keyframes: record.frames,
        rect: rect ? { left: rect.left, top: rect.top } : null, cursorCount: document.querySelectorAll('.cm-cursor-primary').length } : null;
    });
    assert.ok(arrowMotion, 'ArrowRight starts a caret animation');
    assert.equal(arrowMotion.duration, 120); assert.match(arrowMotion.keyframes[0].transform, /translate\(/);
    assert.equal(arrowMotion.cursorCount, 1, 'the existing CodeMirror cursor remains the single caret while it animates');
    for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowRight');
    const ordinaryMove = await page.evaluate(() => ({ ...window.__motionMeasureProbe }));
    assert.equal(ordinaryMove.rectReads, 0, 'ordinary arrow movement performs no text-run rectangle reads');
    assert.equal(ordinaryMove.textAnimations.length, 0, 'ordinary arrow movement does not start text layout animations');

    await page.keyboard.press('Control+End');
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().duration === 120 && animation.playState === 'running').map(animation => animation.finished.catch(() => {})));
      window.__motionTrace.mark('first-end-settled');
    });
    const before = await page.locator('.cm-cursor-primary').boundingBox();
    await page.evaluate(() => { window.__motionMeasureProbe.rectReads = 0; window.__motionMeasureProbe.textAnimations = []; window.__motionMeasureProbe.caretAnimations = []; window.__motionTrace.mark('distant-home'); });
    await page.keyboard.press('Control+Home');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__motionMeasureProbe.caretAnimations.length), 0,
      'a distant keyboard jump remains direct');
    await page.keyboard.press('Control+End');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => { window.__motionTrace.mark('second-end-settled'); window.__motionMeasureProbe.caretAnimations = []; window.__motionTrace.mark('bold-click'); });
    await clickText('bold target', 'left');
    await page.waitForFunction(() => window.__motionMeasureProbe.caretAnimations.length > 0);
    const distantClick = await page.evaluate(async () => {
      const record = window.__motionMeasureProbe.caretAnimations.at(-1);
      if (record) await record.animation.finished.catch(() => {});
      const match = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(record?.frames[0]?.transform || '');
      return record ? { duration: record.duration, distance: match ? Math.hypot(Number(match[1]), Number(match[2])) : 0 } : null;
    });
    assert.ok(before && distantClick && distantClick.distance > 88, 'the mouse click crosses the animation travel limit');
    assert.equal(distantClick.duration, 80, 'a distant mouse click uses the short caret animation');
    try { await page.waitForFunction(() => window.__motionMeasureProbe.textAnimations.some(animation => animation.duration === 120)); }
    catch (error) {
      try { console.error('format motion diagnostic', await page.evaluate(() => ({ rectReads: window.__motionMeasureProbe.rectReads,
        textAnimations: window.__motionMeasureProbe.textAnimations.length, caretAnimations: window.__motionMeasureProbe.caretAnimations.length,
        scrollTop: document.querySelector('.cm-scroller')?.scrollTop, focused: document.querySelector('.cm-editor')?.classList.contains('cm-focused'),
        tokenCount: document.querySelectorAll('.cm-md-format-token').length }))); }
      catch (failure) { console.error('format motion diagnostic unavailable: ' + failure.message); }
      throw error;
    }
    await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().duration === 120 && animation.playState === 'running').map(animation => animation.finished.catch(() => {}))));
    const formatChange = await page.evaluate(() => ({ ...window.__motionMeasureProbe }));
    assert.ok(formatChange.rectReads > 0, 'format visibility change measures visible text runs');
    assert.ok(formatChange.textAnimations.some(animation => animation.duration === 120), 'bold entry animates neighboring text independently of caret travel distance');
    assert.ok(formatChange.textAnimations.every(animation => Math.hypot(parseFloat(animation.frames[0].left), parseFloat(animation.frames[0].top)) < 100),
      'format animation uses the current layout rather than a stale split-pane position');
    assert.equal(formatChange.caretAnimations.length, 1, 'the distant mouse click animates the caret');
    assert.equal(formatChange.textAnimations[0].duration, 120, 'format text keeps its independent motion duration');
    assert.ok(await page.locator('.cm-md-format-token').count() > 0, 'Markdown delimiters are visible while editing the bold span');

    const nearPoint = await textPoint('bold target', 'left');
    const centerPoint = await textPoint('bold target');
    await page.mouse.click(nearPoint.x, nearPoint.y);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => { window.__motionMeasureProbe.caretAnimations = []; });
    await page.mouse.click(centerPoint.x, centerPoint.y);
    await page.waitForFunction(() => window.__motionMeasureProbe.caretAnimations.length > 0);
    const nearClickDuration = await page.evaluate(() => window.__motionMeasureProbe.caretAnimations.at(-1)?.duration);
    assert.equal(nearClickDuration, 120, 'a near mouse click keeps the existing caret duration');
    await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.playState === 'running'
      && [80, 120].includes(animation.effect?.getTiming().duration)
      && Number.isFinite(animation.effect?.getTiming().iterations)).map(animation => animation.finished.catch(() => {}))));

    const dragStart = await textPoint('bold target');
    const dragEnd = await textPoint('Plain lead in', 'left');
    await page.evaluate(() => { window.__motionMeasureProbe.caretAnimations = []; });
    await page.mouse.move(dragStart.x, dragStart.y); await page.mouse.down();
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.cm-proseSelectionBackground')?.getClientRects().length > 0);
    assert.equal(await page.evaluate(() => window.__motionMeasureProbe.caretAnimations.length), 0,
      'drag selection does not start a caret travel animation');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { window.__motionMeasureProbe.caretAnimations = []; });
    await clickText('bold target');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__motionMeasureProbe.caretAnimations.length), 0,
      'reduced motion also suppresses a distant pointer click');
    await saveMotionTrace('passed');
  } catch (error) {
    await saveMotionTrace?.('failed', error);
    throw error;
  } finally {
    if (app) await app.close();
    await cleanupSmokeWorkspace(workspace);
  }
});
