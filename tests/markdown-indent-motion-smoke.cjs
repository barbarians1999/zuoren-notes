const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const root = path.resolve(__dirname, '..');

test('single-caret Tab and Shift-Tab animate mapped text without rewriting the editor selection', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('markdown-indent-motion'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const source = '- Parent\n  - First child\n  - Child motion\n';
    const note = path.join(workspace.fixture, 'indent-motion.md');
    const rapidNote = path.join(workspace.fixture, 'rapid-motion.md');
    await fs.writeFile(note, source, 'utf8');
    await fs.writeFile(rapidNote, source, 'utf8');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'full');
    const editor = page.locator('.cm-content'); await page.locator('.file-row').filter({ hasText: 'indent-motion.md' }).dblclick();
    await editor.waitFor(); await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      window.__indentMotions = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        const kind = this.matches?.('.cm-cursor-primary') ? 'caret' : this.matches?.('[data-md-motion-key]') ? 'text' : null;
        const animation = animate.call(this, frames, options);
        if (kind) window.__indentMotions.push({ kind, duration: options?.duration, key: this.getAttribute('data-md-motion-key'), animation });
        return animation;
      };
    });
    const clickText = async (needle, character = 0) => {
      const point = await page.evaluate(({ needle, character }) => {
        const root = document.querySelector('.cm-content'), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, offset = node.textContent.indexOf(needle); if (offset < 0) continue;
          const range = document.createRange(); range.setStart(node, offset + character); range.setEnd(node, offset + character + 1);
          const rect = range.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        return null;
      }, { needle, character });
      assert.ok(point, `source text ${needle} is visible`); await page.mouse.click(point.x, point.y);
    };
    const waitForDocument = expected => page.waitForFunction(text =>
      document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === text, expected);
    const finishMotion = () => page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running'
        && Number.isFinite(animation.effect?.getTiming().iterations))
        .map(animation => animation.finished.catch(() => {})));
    });
    const placeCollapsedCaret = () => page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Child motion') + 4 } });
      view.focus(); window.__indentMotions = [];
    });
    const tabAndInterruptBeforeMeasure = interruption => page.evaluate(interruption => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      const event = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
      if (interruption === 'reduced') document.querySelector('.app').dataset.motion = 'reduced';
      if (interruption === 'blur') window.dispatchEvent(new Event('blur'));
      if (interruption === 'scroll') view.scrollDOM.dispatchEvent(new Event('scroll'));
      return { doc: view.state.doc.toString(), handled: event.defaultPrevented };
    }, interruption);
    await clickText('Child motion', 4); await finishMotion();
    const beforeTab = await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view, selection = view.state.selection.main;
      window.__indentMotions = [];
      return { doc: view.state.doc.toString(), anchor: selection.anchor, head: selection.head };
    });
    assert.equal(beforeTab.doc, source); assert.equal(beforeTab.anchor, beforeTab.head);
    await page.keyboard.press('Tab');
    const indented = '- Parent\n  - First child\n\t  - Child motion\n';
    await waitForDocument(indented);
    const afterTab = await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view, selection = view.state.selection.main;
      return { doc: view.state.doc.toString(), anchor: selection.anchor, head: selection.head };
    });
    assert.equal(afterTab.doc, indented); assert.equal(afterTab.anchor, beforeTab.anchor + 1); assert.equal(afterTab.head, beforeTab.head + 1);
    await page.waitForFunction(() => window.__indentMotions.some(item => item.kind === 'text'));
    const tabMotions = await page.evaluate(() => window.__indentMotions.map(({ kind, duration, key }) => ({ kind, duration, key })));
    assert.ok(tabMotions.some(item => item.kind === 'text' && item.duration === 120), JSON.stringify(tabMotions));
    assert.ok(tabMotions.filter(item => item.kind === 'caret').every(item => item.duration === 120), JSON.stringify(tabMotions));
    await finishMotion();
    await page.evaluate(() => { window.__indentMotions = []; });
    await page.keyboard.press('Shift+Tab');
    await waitForDocument(source);
    const dedented = await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view, selection = view.state.selection.main;
      return { doc: view.state.doc.toString(), anchor: selection.anchor, head: selection.head };
    });
    assert.equal(dedented.doc, source); assert.equal(dedented.anchor, beforeTab.anchor); assert.equal(dedented.head, beforeTab.head);
    await page.waitForFunction(() => window.__indentMotions.some(item => item.kind === 'text'));
    await finishMotion();

    await page.keyboard.press('Control+z'); await waitForDocument(indented);
    await page.keyboard.press('Control+z'); await waitForDocument(source);
    await page.keyboard.press('Control+Shift+z'); await waitForDocument(indented);
    await page.keyboard.press('Control+Shift+z'); await waitForDocument(source);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.cm-cursor-primary').length), 1);

    // A run animation is an enhancement only: repeated indent operations must
    // settle to exact source/caret state even when the first measurement is
    // still pending or its animation is interrupted by the next key.
    await page.locator('.file-row').filter({ hasText: 'rapid-motion.md' }).dblclick();
    await editor.waitFor(); await page.evaluate(() => document.fonts.ready);
    await placeCollapsedCaret();
    // No sibling exists at the next depth, so the second Tab is a handled no-op.
    const rapidIndent = indented;
    await page.evaluate(() => { window.__indentMotions = []; });
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    await waitForDocument(rapidIndent);
    const afterRapidTabs = await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view, selection = view.state.selection.main;
      return { doc: view.state.doc.toString(), anchor: selection.anchor, head: selection.head };
    });
    assert.equal(afterRapidTabs.doc, rapidIndent);
    assert.equal(afterRapidTabs.anchor, beforeTab.anchor + 1); assert.equal(afterRapidTabs.head, beforeTab.head + 1);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.cm-line')].find(line => line.textContent.includes('Child motion'))?.querySelectorAll('.cm-md-list-marker').length), 1, 'repeated Tab retains one rendered list marker, not a literal continuation');
    await page.keyboard.press('End'); await page.keyboard.insertText('!');
    await waitForDocument(rapidIndent.replace(/\n$/, '!\n'));
    await page.keyboard.press('Control+z'); await waitForDocument(rapidIndent);
    await page.keyboard.press('Control+z'); await waitForDocument(source);
    await page.keyboard.press('Control+Shift+z'); await waitForDocument(indented);
    await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.playState === 'running'
      && Number.isFinite(animation.effect?.getTiming().iterations)).map(animation => animation.finished.catch(() => {}))));
    const rapidSettled = await page.evaluate(expectedCaret => ({ cursors: document.querySelectorAll('.cm-cursor-primary').length,
      activeCaret: document.querySelector('.cm-cursor-primary')?.getAnimations().filter(animation => animation.playState === 'running').length || 0,
      logicalCaret: document.querySelector('.cm-content').cmTile.root.view.state.selection.main.head, expectedCaret }), afterRapidTabs.head);
    assert.equal(rapidSettled.cursors, 1, 'rapid operations keep one real CodeMirror caret');
    assert.equal(rapidSettled.activeCaret, 0, 'rapid operations leave no queued caret animation');
    assert.equal(rapidSettled.logicalCaret, rapidSettled.expectedCaret, 'the logical caret remains at the mapped source position');

    await page.keyboard.press('Shift+Tab'); await waitForDocument(source);

    // A selected range is still mapped by CodeMirror, but is deliberately not
    // FLIP-animated because selection paint must stay attached to source text.
    await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view, start = view.state.doc.toString().indexOf('Child motion');
      view.dispatch({ selection: { anchor: start + 5, head: start } });
      window.__indentMotions = [];
    });
    const selectedBefore = await page.evaluate(() => {
      const selection = document.querySelector('.cm-content').cmTile.root.view.state.selection.main;
      return { anchor: selection.anchor, head: selection.head };
    });
    await page.keyboard.press('Tab'); await waitForDocument(indented);
    const selectedAfter = await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view, selection = view.state.selection.main;
      return { doc: view.state.doc.toString(), anchor: selection.anchor, head: selection.head,
        motions: window.__indentMotions.length };
    });
    assert.equal(selectedAfter.doc, indented);
    assert.equal(selectedAfter.anchor, selectedBefore.anchor + 1); assert.equal(selectedAfter.head, selectedBefore.head + 1);
    assert.equal(selectedAfter.motions, 0, 'nonempty selection indentation uses immediate layout');
    await page.keyboard.press('Shift+Tab'); await waitForDocument(source);

    // Mutations between the edit and its scheduled measurement must cancel the
    // candidate. These synthetic events exercise the controller hook order;
    // they do not replace the later Windows checks with native blur/scroll/IME.
    const interruptedIndent = indented;
    for (const interruption of ['reduced', 'blur', 'scroll']) {
      await placeCollapsedCaret();
      const result = await tabAndInterruptBeforeMeasure(interruption);
      assert.equal(result.handled, true, `the editor handles Tab before ${interruption}`);
      assert.equal(result.doc, interruptedIndent, `Tab source is committed before ${interruption}`);
      await waitForDocument(interruptedIndent);
      await page.waitForTimeout(160);
      const interruptionMotions = await page.evaluate(() => {
        const motion = window.__indentMotions.map(({ kind, duration, key, animation }) => ({ kind, duration, key, state: animation.playState }));
        return { motion, active: motion.filter(item => item.state === 'running'), preference: document.querySelector('.app').dataset.motion };
      });
      assert.equal(interruptionMotions.active.length, 0,
        `${interruption} before measurement leaves no stale caret/text animation: ${JSON.stringify(interruptionMotions)}`);
      await page.keyboard.press('Shift+Tab'); await waitForDocument(source);
      if (interruption === 'reduced') {
        await page.evaluate(() => { document.querySelector('.app').dataset.motion = 'full'; });
        await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'full');
      }
    }

    // Respect the system preference in the editor-specific motion controller.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'reduced');
    await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view, head = view.state.doc.toString().indexOf('Child motion') + 4;
      view.dispatch({ selection: { anchor: head } }); window.__indentMotions = [];
    });
    await page.keyboard.press('Tab'); await waitForDocument(indented);
    const reducedTab = await page.evaluate(() => ({ doc: document.querySelector('.cm-content').cmTile.root.view.state.doc.toString(),
      motions: window.__indentMotions.length }));
    assert.equal(reducedTab.doc, indented); assert.equal(reducedTab.motions, 0, 'reduced motion disables Tab FLIP');
    await page.keyboard.press('Shift+Tab'); await waitForDocument(source);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'full');
  } finally { if (app) await app.close(); await cleanupSmokeWorkspace(workspace); }
});
