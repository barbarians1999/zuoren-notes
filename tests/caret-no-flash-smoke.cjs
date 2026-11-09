const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const root = path.resolve(__dirname, '..');

test('distant pointer click never paints the destination before caret motion', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('caret-no-flash'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const file = path.join(workspace.fixture, 'caret.md');
    await fs.writeFile(file, `ORIGINAL_ANCHOR ${'ordinary '.repeat(18)}TARGET_ANCHOR end\n${'scrollable line\n'.repeat(100)}`);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.file-row').filter({ hasText: 'caret.md' }).dblclick(); await page.locator('.cm-content').waitFor();
    const point = text => page.evaluate(text => {
      const walker = document.createTreeWalker(document.querySelector('.cm-content'), NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const node = walker.currentNode, offset = node.textContent.indexOf(text); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect(); return { x: rect.left + 1, y: rect.top + rect.height / 2 }; }
      throw Error('Missing target: ' + text);
    }, text);
    const origin = await point('ORIGINAL_ANCHOR'), target = await point('TARGET_ANCHOR');
    assert.ok(Math.hypot(target.x - origin.x, target.y - origin.y) > 88, 'fixture uses a distant visible click');
    await page.mouse.click(origin.x, origin.y);
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.querySelector('.cm-cursor-primary')?.getAnimations().filter(a => Number.isFinite(a.effect.getTiming().iterations)).map(a => a.finished.catch(() => {})) || []);
    });
    const recordClick = async (destination, held) => {
      await page.evaluate(() => {
      window.__caretFrames = []; window.__caretTracking = true; window.__released = false;
      document.addEventListener('mouseup', () => { window.__released = true; }, { capture: true, once: true });
      const sample = () => {
        if (!window.__caretTracking) return;
        const caret = document.querySelector('.cm-cursor-primary');
        if (caret) { const rect = caret.getBoundingClientRect(), style = getComputedStyle(caret), layer = caret.closest('.cm-cursorLayer');
          window.__caretFrames.push({ time: performance.now(), x: rect.left, y: rect.top, visibility: style.visibility,
            opacity: style.opacity, layerOpacity: layer ? getComputedStyle(layer).opacity : '', released: window.__released,
            animations: caret.getAnimations().filter(a => a.playState === 'running').map(a => a.effect.getTiming().duration) }); }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      });
      await page.mouse.move(destination.x, destination.y); await page.mouse.down();
      if (held) await page.waitForTimeout(120);
      await page.mouse.up(); await page.waitForTimeout(220);
      return page.evaluate(() => { window.__caretTracking = false; return window.__caretFrames; });
    };
    const verify = (frames, destination, label) => {
      const start = frames.findIndex(frame => frame.released && frame.animations.includes(80));
      assert.ok(start >= 0, `${label} starts the distant caret animation`);
      const premature = frames.slice(0, start).filter(frame => frame.visibility !== 'hidden' && frame.opacity !== '0' && frame.layerOpacity !== '0'
        && Math.hypot(frame.x - destination.x, frame.y - (destination.y - 11)) < 30);
      assert.equal(premature.length, 0, `${label} paints the destination before animation: ${JSON.stringify({ origin, target, frames })}`);
    };
    verify(await recordClick(target, true), target, 'held click');
    verify(await recordClick(origin, false), origin, 'quick click');
    await page.mouse.move(target.x, target.y); await page.mouse.down(); await page.waitForTimeout(120);
    await page.mouse.move(origin.x, origin.y, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.cm-proseSelectionBackground'));
    assert.equal(await page.evaluate(() => document.querySelector('.cm-cursor-primary')?.style.transform || ''), '',
      'starting a drag releases any temporary caret position');
    await page.mouse.click(origin.x, origin.y); await page.mouse.move(target.x, target.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.cm-cursor-primary')?.style.transform.includes('translate'));
    await page.locator('.cm-scroller').evaluate(element => { element.scrollTop = 120; });
    await page.waitForFunction(() => document.querySelector('.cm-scroller').scrollTop > 0 && !document.querySelector('.cm-cursor-primary')?.style.transform);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => document.querySelector('.cm-cursor-primary')?.style.transform || ''), '',
      'scrolling during a held click clears the temporary position');
    await page.locator('.cm-scroller').evaluate(element => { element.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('.cm-scroller').scrollTop === 0);
    await page.mouse.click(origin.x, origin.y);
    await page.waitForFunction(x => Math.abs((document.querySelector('.cm-cursor-primary')?.getBoundingClientRect().left ?? -1000) - x) < 4, origin.x);
    await page.mouse.move(target.x, target.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.cm-cursor-primary')?.style.transform.includes('translate'));
    await page.keyboard.insertText('X');
    await page.waitForFunction(() => !document.querySelector('.cm-cursor-primary')?.style.transform);
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('XTARGET_ANCHOR'));
    assert.equal(await page.evaluate(() => document.querySelector('.cm-cursor-primary')?.style.transform || ''), '',
      'typing during a held click cancels the temporary position');
  } finally { if (app) await app.close(); await cleanupSmokeWorkspace(workspace); }
});
