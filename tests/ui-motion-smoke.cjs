const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const root = path.resolve(__dirname, '..');

test('short UI motion preserves editor history, panel focus, PDF page and reduced-motion preferences', { timeout: 90000 }, async () => {
  const workspace = await createSmokeWorkspace('ui-motion'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    await fs.writeFile(path.join(workspace.fixture, 'a.md'), '# Heading A\n\nStart **bold phrase** middle *italic phrase* and [linked phrase](https://example.test) and `inline code`\nBody A\n');
    await fs.writeFile(path.join(workspace.fixture, 'b.md'), '# Heading B\n\nBody B\n');
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++) pdf.addPage([595, 842]).drawText('Page ' + (i + 1), { font, size: 20, x: 72, y: 740 });
    await fs.writeFile(path.join(workspace.fixture, 'book.pdf'), await pdf.save());
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (packaged) assert.equal(await app.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const row = name => page.locator('.file-row').filter({ hasText: name });
    await row('a.md').dblclick(); await page.locator('.cm-content').waitFor();
    const noteMode = page.locator('.note-controls-slot .workspace-mode-switch');
    await noteMode.getByRole('button', { name: '切换到预览' }).click(); await page.locator('.markdown-preview').waitFor();
    const noteModeMotion = await page.evaluate(async () => {
      const button = document.querySelector('.workspace-mode-switch button.active');
      await new Promise(resolve => setTimeout(resolve, 45));
      const content = document.querySelector('.markdown-preview');
      return { background: getComputedStyle(button).backgroundColor, slideDuration: document.querySelector('.note-body').getAnimations()[0]?.effect.getTiming().duration,
        contentAnimated: content.getAnimations().length > 0 };
    });
    assert.equal(noteModeMotion.background, 'rgba(0, 0, 0, 0)');
    assert.equal(noteModeMotion.slideDuration, 160, 'edit/read content slides horizontally in 160ms');
    assert.equal(noteModeMotion.contentAnimated, false, 'reading and editing do not fade the document');
    const readingModeButton = noteMode.getByRole('button', { name: '阅读模式', exact: true }); await readingModeButton.hover();
    const controlMotion = await readingModeButton.evaluate(button => ({
      button: getComputedStyle(button).transform,
      icon: getComputedStyle(button.querySelector('svg')).transform,
      label: getComputedStyle(button.querySelector('span')).transform,
    }));
    assert.equal(controlMotion.button, 'none', 'the control hit area stays in place');
    assert.notEqual(controlMotion.icon, 'none'); assert.notEqual(controlMotion.label, 'none', 'only its icon and label lift');
    await noteMode.getByRole('button', { name: '切换到源码编辑' }).click(); await page.locator('.cm-content').waitFor();
    await page.locator('.cm-content').evaluate(el => { window.__layoutEditor = el; });
    const layoutTabs = page.locator('.layout-tabs');
    const originalLayout = await page.locator('.app').getAttribute('data-layout');
    const originalModeBackground = await layoutTabs.locator('button.active').evaluate(el => getComputedStyle(el).backgroundColor);
    const nextLayout = originalLayout === 'read' ? 'note' : 'read';
    const layoutLabel = (value) => ({ read: '阅读', note: '笔记', split: '对照' })[value];
    await layoutTabs.getByRole('button', { name: layoutLabel(nextLayout), exact: true }).click();
    await page.waitForFunction(value => document.querySelector('.app')?.getAttribute('data-layout') === value, nextLayout);
    const modeMotion = await page.evaluate(async () => {
      const button = document.querySelector('.layout-tabs button.active'), style = getComputedStyle(button);
      const properties = style.transitionProperty.split(',').map(value => value.trim()), durations = style.transitionDuration.split(',').map(value => value.trim());
      await new Promise(resolve => setTimeout(resolve, 45));
      const panes = document.querySelector('.panes'), animation = panes.getAnimations()[0];
      return { background: style.backgroundColor, backgroundDuration: durations[properties.indexOf('background-color')],
        slideDuration: animation?.effect.getTiming().duration, keyframes: animation?.effect.getKeyframes(),
        editorAnimated: document.querySelector('.cm-content').getAnimations().length > 0 };
    });
    assert.equal(modeMotion.background, originalModeBackground, 'the original selected mode surface remains unchanged');
    assert.equal(modeMotion.backgroundDuration, '0s', 'only the selected label animates, not its background block');
    assert.equal(modeMotion.slideDuration, 180, 'mode content slides horizontally in 180ms');
    assert.match(modeMotion.keyframes[0].transform, /translateX\(/);
    assert.equal(modeMotion.editorAnimated, false, 'layout changes do not animate editor content');
    await layoutTabs.getByRole('button', { name: layoutLabel(originalLayout), exact: true }).click();
    await page.waitForFunction(value => document.querySelector('.app')?.getAttribute('data-layout') === value, originalLayout);
    assert.equal(await page.locator('.cm-content').evaluate(el => el === window.__layoutEditor), true);

    // Hold real WAAPI motion mid-flight so interruption assertions don't depend
    // on catching one of the 180ms animation's frames on a busy test machine.
    const holdLayoutMotion = async label => {
      await page.evaluate(async label => {
        [...document.querySelectorAll('.layout-tabs button')].find(button => button.textContent.trim() === label).click();
        for (let frame = 0; frame < 20; frame++) {
          await new Promise(requestAnimationFrame);
          const surface = document.querySelector('.panes');
          const animation = surface.getAnimations()[0];
          if (!animation || animation === window.__heldLayoutAnimation) continue;
          animation.pause(); animation.currentTime = 65;
          window.__heldLayoutAnimation = animation;
          window.__heldLayoutTransform = getComputedStyle(surface).transform;
          return;
        }
        throw Error('The requested layout did not start its motion');
      }, label);
    };
    await page.waitForFunction(() => !document.querySelector('.panes')?.getAnimations().length);
    await holdLayoutMotion(layoutLabel(nextLayout));
    const rapidFrom = await page.evaluate(() => window.__heldLayoutTransform);
    await holdLayoutMotion(layoutLabel(originalLayout));
    assert.equal(await page.evaluate(() => window.__heldLayoutAnimation.effect.getKeyframes()[0].transform), rapidFrom,
      'rapid layout changes continue from the visible position instead of jumping to a new starting edge');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('.app').dataset.motion === 'reduced');
    assert.equal(await page.evaluate(() => window.__heldLayoutAnimation.playState), 'idle', 'system reduce-motion cancels an in-flight layout change');
    assert.equal(await page.locator('.panes').evaluate(el => el.getAnimations().length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.querySelector('.app').dataset.motion === 'full');
    assert.equal(await page.locator('.panes').evaluate(el => el.getAnimations().length), 0, 'restoring motion does not replay the layout');
    await holdLayoutMotion(layoutLabel(nextLayout));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.motion-preference input').check();
    await page.waitForFunction(() => document.querySelector('.app').dataset.motion === 'reduced');
    assert.equal(await page.evaluate(() => window.__heldLayoutAnimation.playState), 'idle', 'the app preference cancels an in-flight layout change too');
    await page.locator('.motion-preference input').uncheck();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await layoutTabs.getByRole('button', { name: layoutLabel(originalLayout), exact: true }).click();
    await page.waitForFunction(value => document.querySelector('.app')?.getAttribute('data-layout') === value, originalLayout);
    assert.equal(await page.locator('.cm-content').evaluate(el => el === window.__layoutEditor), true, 'interruptions preserve the editor instance');
    const disabledBack = page.getByRole('button', { name: '返回上一级文件夹', exact: true });
    assert.equal(await disabledBack.isDisabled(), true);
    await disabledBack.hover();
    assert.equal(await disabledBack.locator('svg').evaluate(el => getComputedStyle(el).transform), 'none', 'disabled navigation does not lift on hover');
    await page.mouse.down();
    assert.equal(await disabledBack.locator('svg').evaluate(el => getComputedStyle(el).transform), 'none', 'disabled navigation does not press down');
    await page.mouse.up();
    await page.locator('.cm-content').evaluate(el => { window.__motionEditor = el; });
    const markdownEditor = page.locator('.cm-content');
    await page.evaluate(() => {
      window.__markdownMotionRecords = [];
      const original = Element.prototype.animate;
      Element.prototype.animate = function(keyframes, options) {
        const isCaret = this.classList?.contains('cm-cursor-primary'), key = this.getAttribute?.('data-md-motion-key');
        if (!isCaret && !key) return original.call(this, keyframes, options);
        const rect = this.getBoundingClientRect(), frames = Array.isArray(keyframes) ? keyframes : [];
        const delta = value => { const match = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(value || ''); return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: Number.parseFloat(value) || 0, y: Number.parseFloat(value) || 0 }; };
        const start = isCaret ? delta(frames[0]?.transform) : { x: Number.parseFloat(frames[0]?.left) || 0, y: Number.parseFloat(frames[0]?.top) || 0 };
        const record = { kind: isCaret ? 'caret' : 'text', key, duration: options?.duration, baseRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          visualStart: { left: rect.left + start.x, top: rect.top + start.y }, keyframes: frames, activeLine: this.closest('.cm-line')?.innerText || '' };
        const animation = original.call(this, keyframes, options); record.animation = animation; record.startedAt = performance.now(); record.status = 'running';
        record.completion = new Promise(resolve => { record.resolveCompletion = resolve; });
        animation.addEventListener('finish', () => { record.status = 'finished'; record.finishedAt = performance.now(); const final = this.getBoundingClientRect();
          record.finalRect = { left: final.left, top: final.top, width: final.width, height: final.height };
          queueMicrotask(() => { const content = document.querySelector('.cm-content'); record.caretColorAtFinish = getComputedStyle(content).caretColor;
            record.inlineCaretColorAtFinish = content.style.getPropertyValue('caret-color'); record.inlineCaretPriorityAtFinish = content.style.getPropertyPriority('caret-color');
            record.cursorCountAtFinish = document.querySelectorAll('.cm-cursor-primary').length; record.resolveCompletion(); }); }, { once: true });
        animation.addEventListener('cancel', () => { if (record.status === 'running') { record.status = 'cancelled'; record.finishedAt = performance.now(); record.resolveCompletion(); } }, { once: true });
        window.__markdownMotionRecords.push(record); return animation;
      };
    });
    const motionRecordCount = () => page.evaluate(() => window.__markdownMotionRecords.length);
    const motionRecordsSince = async (start, waitForFinish = true) => {
      if (waitForFinish) await page.waitForFunction(index => window.__markdownMotionRecords.length > index, start);
      return page.evaluate(async ({ start, waitForFinish }) => {
      const records = window.__markdownMotionRecords.slice(start);
      if (waitForFinish) await Promise.all(records.map(record => record.completion));
      return records.map(({ animation, completion, resolveCompletion, ...record }) => ({ ...record, finalCaretColor: getComputedStyle(document.querySelector('.cm-content')).caretColor }));
      }, { start, waitForFinish });
    };
    await markdownEditor.click(); await page.keyboard.press('Control+Home');
    await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().duration === 120).map(animation => animation.finished.catch(() => {}))));
    const caretBaseline = await markdownEditor.evaluate(element => ({ color: getComputedStyle(element).caretColor,
      inline: element.style.getPropertyValue('caret-color'), priority: element.style.getPropertyPriority('caret-color'), cursorCount: element.closest('.cm-editor').querySelectorAll('.cm-cursor-primary').length }));
    await page.evaluate(() => { window.__markdownMotionRecords = []; });
    await page.keyboard.press('ArrowRight');
    const firstCaretMotion = await motionRecordsSince(0);
    const landedCaret = firstCaretMotion.find(record => record.kind === 'caret' && record.status === 'finished');
    assert.ok(landedCaret, 'keyboard caret travel animates the visible cursor');
    assert.match(landedCaret.keyframes[0].transform, /translate\(/);
    assert.ok(Math.hypot(landedCaret.finalRect.left - landedCaret.baseRect.left, landedCaret.finalRect.top - landedCaret.baseRect.top) < 1, 'the visual caret reaches the new source position');
    assert.equal(landedCaret.finalCaretColor, caretBaseline.color, 'the rendered CodeMirror caret keeps the baseline color after animation');
    assert.equal(landedCaret.inlineCaretColorAtFinish, caretBaseline.inline, 'motion preserves the inline caret color value');
    assert.equal(landedCaret.inlineCaretPriorityAtFinish, caretBaseline.priority, 'motion preserves the inline caret color priority');
    assert.equal(landedCaret.cursorCountAtFinish, caretBaseline.cursorCount, 'motion returns the existing cursor layer to its baseline element count');
    const sourceBeforeRapid = await markdownEditor.textContent();
    for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowRight');
    await page.keyboard.insertText('Q');
    const sourceAfterRapid = await markdownEditor.textContent();
    assert.ok(sourceAfterRapid.includes('# HeadQing A'), 'input lands at the latest position after rapid arrows');
    await page.keyboard.press('Control+z');
    assert.equal(await markdownEditor.textContent(), sourceBeforeRapid, 'undo restores the exact source after rapid movement');
    await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().duration === 120 && animation.playState === 'running').map(animation => animation.finished.catch(() => {}))));
    const rapidEnd = await page.evaluate(() => ({ cursorCount: document.querySelectorAll('.cm-cursor-primary').length,
      activeAnimations: document.querySelector('.cm-cursor-primary')?.getAnimations().filter(animation => animation.effect?.getTiming().duration === 120 && animation.playState === 'running').length || 0 }));
    assert.equal(rapidEnd.cursorCount, caretBaseline.cursorCount); assert.equal(rapidEnd.activeAnimations, 0,
      'rapid movement leaves one CodeMirror caret with no queued path or residual overlay');
    const clickText = async (text, edge = 'center') => {
      const point = await page.evaluate(({ target, edge }) => {
        const root = document.querySelector('.cm-content'), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, offset = node.textContent.indexOf(target);
          if (offset < 0) continue;
          const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + target.length);
          const box = range.getBoundingClientRect(); return { x: edge === 'left' ? box.left + 2 : box.left + box.width / 2, y: box.top + box.height / 2 };
        }
        return null;
      }, { target: text, edge });
      assert.ok(point, `text target ${text} is present in the live editor`);
      await page.mouse.click(point.x, point.y);
    };
    await clickText('Start');
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().duration === 120 && animation.playState === 'running').map(animation => animation.finished.catch(() => {})));
    });
    let motionStart = await motionRecordCount();
    await clickText('Body A');
    let clickMotion = await motionRecordsSince(motionStart);
    assert.equal(clickMotion.filter(record => record.kind === 'caret' && record.status === 'finished').length, 1, 'clicking on the following line smoothly positions the caret');
    motionStart = await motionRecordCount();
    await clickText('Start');
    clickMotion = await motionRecordsSince(motionStart);
    assert.equal(clickMotion.filter(record => record.kind === 'caret' && record.status === 'finished').length, 1, 'clicking text smoothly positions the caret');
    motionStart = await motionRecordCount();
    await clickText('bold phrase', 'left');
    const formatEnter = await motionRecordsSince(motionStart);
    assert.ok(formatEnter.some(record => record.kind === 'text' && record.status === 'finished' &&
      (Number.parseFloat(record.keyframes[0].left) !== 0 || Number.parseFloat(record.keyframes[0].top) !== 0)),
      'entering bold transitions the positions of adjacent source text runs');
    assert.ok(await page.locator('.cm-md-format-token').count() > 0, 'the source markers are visible while the caret is inside the format');
    motionStart = await motionRecordCount();
    await clickText('Start');
    const formatExit = await motionRecordsSince(motionStart);
    assert.ok(formatExit.some(record => record.kind === 'text' && record.status === 'finished'), 'leaving bold animates the adjacent source positions');
    assert.equal(await page.locator('.cm-md-format-token').count(), 0, 'leaving the format hides its source markers immediately');
    motionStart = await motionRecordCount();
    await clickText('italic phrase', 'left'); const italicEnter = await motionRecordsSince(motionStart);
    assert.ok(italicEnter.some(record => record.kind === 'text' && record.status === 'finished'), 'entering italic animates neighboring source positions');
    assert.ok(await page.locator('.cm-md-format-token').count() > 0, 'italic markers appear while the caret is inside italic text');
    motionStart = await motionRecordCount();
    await clickText('Start'); const italicExit = await motionRecordsSince(motionStart);
    assert.ok(italicExit.some(record => record.kind === 'text' && record.status === 'finished'), 'leaving italic animates neighboring source positions');
    assert.equal(await page.locator('.cm-md-format-token').count(), 0, 'italic markers hide as the caret leaves');
    motionStart = await motionRecordCount();
    await clickText('linked phrase', 'left'); const linkEnter = await motionRecordsSince(motionStart);
    assert.ok(linkEnter.some(record => record.kind === 'text' && record.status === 'finished'), 'entering a link animates its label and adjacent source positions');
    assert.match(await page.locator('.cm-md-link').filter({ hasText: 'linked phrase' }).innerText(), /\]\(/, 'the source link expands while editing its label');
    motionStart = await motionRecordCount();
    await clickText('Start'); const linkExit = await motionRecordsSince(motionStart);
    assert.ok(linkExit.some(record => record.kind === 'text' && record.status === 'finished'), 'leaving a link animates the restored layout');
    assert.doesNotMatch(await page.locator('.cm-md-link').filter({ hasText: 'linked phrase' }).innerText(), /\]\(/, 'the source link collapses after the caret leaves');
    const compositionCdp = await page.context().newCDPSession(page);
    await markdownEditor.click(); await page.keyboard.press('Control+End');
    const compositionMotionStart = await motionRecordCount();
    await compositionCdp.send('Input.imeSetComposition', { text: '中文组词', selectionStart: 4, selectionEnd: 4 });
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('中文组词'));
    assert.equal((await motionRecordsSince(compositionMotionStart, false)).filter(record => record.kind === 'caret').length, 0, 'IME composition does not start cursor travel animations');
    await compositionCdp.send('Input.insertText', { text: '中文组词' });
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.endsWith('中文组词'));
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+Shift+z');
    assert.ok((await markdownEditor.textContent()).endsWith('中文组词'), 'IME commit remains undoable and redoable');
    await page.keyboard.press('Control+z');
    assert.equal((await markdownEditor.textContent()).endsWith('中文组词'), false, 'undo removes the committed composition');
    const findTrigger = page.locator('.note-controls-slot button[aria-label="查找"]');
    await findTrigger.click();
    const findBar = page.locator('.find-bar'); await findBar.waitFor();
    await page.waitForFunction(() => document.querySelector('.find-bar')?.getAnimations().length > 0);
    assert.equal(await findBar.evaluate(el => el.getAnimations()[0]?.effect.getTiming().duration), 140, 'note find bar enters with the shared feedback timing');
    await findBar.locator('button[aria-label="关闭查找"]').click();
    await page.waitForFunction(() => document.querySelector('.find-bar')?.inert === true);
    const findExit = await findBar.evaluate(el => ({ duration: el.getAnimations()[0]?.effect.getTiming().duration,
      hidden: el.getAttribute('aria-hidden'), focused: document.activeElement === document.querySelector('.note-controls-slot button[aria-label="查找"]') }));
    assert.equal(findExit.duration, 110); assert.equal(findExit.hidden, 'true'); assert.equal(findExit.focused, true);
    await findBar.waitFor({ state: 'detached' });
    await findTrigger.click(); await findBar.waitFor();
    await findBar.locator('button[aria-label="关闭查找"]').click();
    await page.waitForFunction(() => document.querySelector('.find-bar')?.inert === true);
    await findTrigger.click();
    await page.waitForFunction(() => document.querySelector('.find-bar')?.getAttribute('aria-hidden') === 'false');
    assert.deepEqual(await findBar.evaluate(el => ({ inert: el.inert, focused: el.querySelector('input') === document.activeElement })), { inert: false, focused: true }, 'reopening during exit cancels the old close and restores the find input');
    await findBar.locator('button[aria-label="关闭查找"]').click();
    await page.waitForFunction(() => document.querySelector('.find-bar')?.inert === true);
    assert.equal(await findTrigger.evaluate(el => el === document.activeElement), true, 'closing from inside restores focus to the trigger');
    await findBar.waitFor({ state: 'detached' });
    const anchorPulse = await page.evaluate(() => {
      const marker = document.createElement('span'); marker.className = 'annotation highlight flash'; document.body.append(marker);
      const animation = marker.getAnimations()[0], frames = animation?.effect.getKeyframes() || [];
      const result = { duration: animation?.effect.getTiming().duration, frames };
      marker.remove(); return result;
    });
    assert.equal(anchorPulse.duration, 280, 'PDF anchor feedback is one short pulse');
    assert.equal(anchorPulse.frames.some(frame => 'boxShadow' in frame || 'background' in frame), false, 'anchor feedback does not flash a background block');
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('UNDO-MOTION');
    const outline = page.locator('[data-outline-toggle]');
    const exercise = async (toggleSelector, panelSelector, duration) => {
      const result = await page.evaluate(async ({ toggleSelector, panelSelector }) => {
        document.querySelector(toggleSelector).click();
        await new Promise(requestAnimationFrame);
        const panel = document.querySelector(panelSelector), content = document.querySelector('.cm-editor');
        const width = content.clientWidth, animations = panel.getAnimations();
        await new Promise(resolve => setTimeout(resolve, 65));
        return { duration: animations[0]?.effect.getTiming().duration, stableWidth: content.clientWidth === width };
      }, { toggleSelector, panelSelector });
      assert.equal(result.duration, duration); assert.equal(result.stableWidth, true, 'content geometry is not interpolated');
      await page.waitForFunction(selector => !document.querySelector(selector)?.getAnimations().length, panelSelector);
      const focusResult = await page.evaluate(async ({ toggleSelector, panelSelector }) => {
        const panel = document.querySelector(panelSelector); panel.querySelector('button, input')?.focus();
        document.querySelector(toggleSelector).click(); await new Promise(requestAnimationFrame);
        const closing = panel.getAnimations()[0];
        const inert = panel.inert, focused = document.activeElement === document.querySelector(toggleSelector), hidden = panel.getAttribute('aria-hidden');
        closing.pause(); closing.currentTime = Number(closing.effect.getTiming().duration) / 2;
        const css = getComputedStyle(panel), opacity = Number(css.opacity), distance = Math.abs(new DOMMatrix(css.transform).m41) / panel.offsetWidth;
        closing.play(); await closing.finished;
        const terminal = { connected: panel.isConnected, opacity: getComputedStyle(panel).opacity };
        return { inert, focused, hidden, opacity, distance, terminal };
      }, { toggleSelector, panelSelector });
      assert.equal(focusResult.inert, true); assert.equal(focusResult.focused, true); assert.equal(focusResult.hidden, 'true');
      assert.ok(focusResult.opacity > .65, 'closing panel remains clearly visible halfway through exit');
      assert.ok(focusResult.distance > .4 && focusResult.distance < .6, 'exit displacement is distributed across the animation');
      assert.ok(!focusResult.terminal.connected || Number(focusResult.terminal.opacity) === 0, 'final invisible frame survives until removal without flashing back');
      await page.locator(panelSelector).waitFor({ state: 'detached' });
      await page.evaluate(async selector => { const button = document.querySelector(selector); button.click(); await new Promise(requestAnimationFrame); button.click(); await new Promise(requestAnimationFrame); button.click(); }, toggleSelector);
      await page.locator(panelSelector).waitFor();
      await page.waitForFunction(selector => { const el = document.querySelector(selector); return el && !el.inert && !el.getAnimations().length && getComputedStyle(el).opacity === '1'; }, panelSelector);
    };
    await exercise('[data-outline-toggle]', '.note-outline', 200);
    await outline.click(); await page.locator('.note-outline').waitFor({ state: 'detached' });
    await page.locator('.sidebar-toggle').click(); await page.locator('.sidebar').waitFor({ state: 'detached' });
    await exercise('.sidebar-toggle', '.sidebar', 200);
    assert.equal(await page.locator('.cm-content').evaluate(el => el === window.__motionEditor), true);
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+z');
    assert.ok(!(await page.locator('.cm-content').innerText()).includes('UNDO-MOTION'));
    await row('b.md').dblclick(); await page.locator('.cm-content').filter({ hasText: 'Body B' }).waitFor();
    const tabAnimation = await page.evaluate(async () => {
      [...document.querySelectorAll('.document-tab')].find(el => el.textContent.includes('a.md')).querySelector('[role="tab"]').click();
      await new Promise(resolve => setTimeout(resolve, 45));
      return document.querySelector('.tab-motion-line').getAnimations()[0]?.effect.getTiming().duration;
    });
    assert.equal(tabAnimation, 140, 'resize notifications do not cancel the moving underline');
    await page.locator('.cm-content').filter({ hasText: 'Body A' }).waitFor();
    assert.equal(await page.locator('.cm-content').evaluate(el => el === window.__motionEditor), true, 'switching notes keeps the same editor view');
    assert.equal(await page.locator('.cm-content').evaluate(el => el.getAnimations().length), 0, 'switching notes does not animate or flash the document');
    assert.equal(await page.locator('[data-note-group="primary"] .note-body').evaluate(el => el.getAnimations()[0]?.effect.getTiming().duration), 160, 'switching notes slides the content in at 160ms');
    await page.waitForFunction(() => !document.querySelector('.tab-motion-line').getAnimations().length);
    const alignment = await page.evaluate(() => { const line = document.querySelector('.tab-motion-line').getBoundingClientRect(), tab = document.querySelector('.foreground-tab').getBoundingClientRect(); return Math.abs(line.left - tab.left) < 1 && Math.abs(line.width - tab.width) < 1 && Math.abs(line.bottom - tab.bottom) < 1; });
    assert.equal(alignment, true, 'activity line matches the active tab');
    const activeTab = page.locator('.foreground-tab > button[role="tab"]'); await activeTab.hover();
    await page.waitForFunction(() => {
      const label = document.querySelector('.foreground-tab [role="tab"] .tab-file-name');
      return label && getComputedStyle(label).transform !== 'none';
    });
    const tabHover = await page.evaluate(() => {
      const tab = document.querySelector('.foreground-tab'), button = tab.querySelector('[role="tab"]'), label = button.querySelector('.tab-file-name');
      return { tabBackground: getComputedStyle(tab).backgroundColor, buttonBackground: getComputedStyle(button).backgroundColor,
        buttonTransform: getComputedStyle(button).transform, labelTransform: getComputedStyle(label).transform };
    });
    assert.notEqual(tabHover.tabBackground, 'rgba(0, 0, 0, 0)', 'the original foreground tab surface remains');
    assert.equal(tabHover.buttonBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(tabHover.buttonTransform, 'none'); assert.notEqual(tabHover.labelTransform, 'none', 'only the tab label moves on hover');
    const screenshot = async name => { if (process.env.ZUOREN_SCREENSHOT_OUTPUT) { await page.waitForFunction(() => !document.querySelector('.settings-popover')?.getAnimations().length); await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true }); await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, name + '.png') }); } };
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.settings-popover')?.getAnimations().length > 0);
    assert.equal(await page.locator('.settings-popover').evaluate(el => el.getAnimations()[0]?.effect.getTiming().duration), 150);
    await screenshot('motion-light-settings');
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await screenshot('motion-dark-settings');
    const reduce = page.locator('.motion-preference input');
    await reduce.check(); await page.waitForFunction(() => document.querySelector('.app').dataset.motion === 'reduced');
    assert.equal(await page.locator('.settings-popover').evaluate(el => el.getAnimations().length), 0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await clickText('bold phrase', 'left');
    await page.locator('.cm-md-format-token').first().waitFor();
    const reducedTokens = await page.locator('.cm-md-format-token').first().evaluate(element => ({
      animation: getComputedStyle(element).animationName, active: element.getAnimations().filter(item => item.playState === 'running').length,
    }));
    assert.deepEqual(reducedTokens, { animation: 'none', active: 0 }, 'application reduced motion also suppresses CSS-only Markdown token reveals');
    await clickText('Start'); await clickText('inline code', 'left'); await clickText('Start');
    const reducedCode = await page.locator('.cm-md-inline-code-text').first().evaluate(element => ({
      animation: getComputedStyle(element).animationName, active: element.getAnimations().filter(item => item.playState === 'running').length,
    }));
    assert.deepEqual(reducedCode, { animation: 'none', active: 0 }, 'application reduced motion suppresses inline-code reveal too');
    await markdownEditor.click(); await page.keyboard.press('Control+Home');
    const reducedMotionStart = await motionRecordCount(); await page.keyboard.press('ArrowRight');
    assert.equal((await motionRecordsSince(reducedMotionStart, false)).filter(record => record.kind === 'caret').length, 0, 'application reduced-motion preference disables cursor travel');
    assert.equal(await page.locator('.cm-cursor-primary').count(), caretBaseline.cursorCount, 'reduced motion keeps the existing CodeMirror cursor layer');
    await outline.click(); assert.equal(await page.locator('.note-outline').evaluate(el => el.getAnimations().length), 0);
    await outline.click(); await page.locator('.note-outline').waitFor({ state: 'detached' });
    await page.reload(); await page.locator('.cm-content').waitFor();
    assert.equal(await page.locator('.app').getAttribute('data-motion'), 'reduced');
    await page.getByRole('button', { name: '设置', exact: true }).click(); await reduce.uncheck();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('.app').dataset.motion === 'reduced');
    assert.equal(await reduce.isChecked(), true); assert.equal(await reduce.isDisabled(), true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.querySelector('.app').dataset.motion === 'full');
    assert.equal(await page.locator('.sidebar').evaluate(el => el.getAnimations().length), 0, 'changing motion preferences does not replay panel entrances');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await row('book.pdf').click(); await page.locator('.layout-tabs').getByRole('button', { name: '阅读', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-pdf-page="2"] canvas')?.width > 0);
    await page.waitForFunction(() => {
      const canvas = [...document.querySelectorAll('.canvas-holder canvas')].find(item => item.getAnimations().some(animation => animation.effect.getTiming().duration === 120));
      const animation = canvas?.getAnimations().find(item => item.effect.getTiming().duration === 120);
      const textLayer = canvas?.closest('.canvas-holder')?.querySelector('.textLayer');
      const textNode = textLayer?.querySelector('span');
      if (!canvas || !animation || !textLayer || !textNode) return false;
      animation.effect.updateTiming({ duration: 2000 }); animation.currentTime = 0; animation.play();
      window.__pdfMotionProbe = { canvas, textLayer, textNode, animation, text: textLayer.textContent };
      return true;
    });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.motion-preference input').check();
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'reduced');
    await page.waitForTimeout(200);
    assert.deepEqual(await page.evaluate(() => {
      const probe = window.__pdfMotionProbe, currentLayer = probe.canvas.closest('.canvas-holder')?.querySelector('.textLayer');
      return { sameCanvas: probe.canvas === document.querySelector(`[data-pdf-page="${probe.canvas.closest('[data-pdf-page]')?.getAttribute('data-pdf-page')}"] canvas`),
        sameTextLayer: probe.textLayer === currentLayer, sameTextNode: probe.textNode === currentLayer?.querySelector('span'),
        sameText: probe.text === currentLayer?.textContent, animationState: probe.animation.playState };
    }), { sameCanvas: true, sameTextLayer: true, sameTextNode: true, sameText: true, animationState: 'idle' }, 'reducing motion cancels the current page fade without rerendering its canvas or text');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.motion-preference input').uncheck();
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'full');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const input = page.getByRole('textbox', { name: '当前页码', exact: true }); await input.fill('2'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.page-control input')?.value === '2' && document.querySelector('.pdf-canvas-wrap').scrollTop > 400);
    const top = await page.locator('.pdf-canvas-wrap').evaluate(el => el.scrollTop);
    await page.getByRole('button', { name: '展开 PDF 大纲', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.pdf-outline')?.getAnimations().length);
    await screenshot('motion-pdf-outline');
    await page.getByRole('button', { name: '收起 PDF 大纲', exact: true }).click(); await page.locator('.pdf-outline').waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), '2');
    assert.equal(await page.locator('.pdf-canvas-wrap').evaluate(el => el.scrollTop), top);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(1000, 700); });
    await page.getByRole('button', { name: '设置', exact: true }).click(); await screenshot('motion-narrow-settings');
    assert.deepEqual(errors, []);
  } finally {
    const child = app?.process();
    if (app) { try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {} }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
