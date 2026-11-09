const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const root = path.resolve(__dirname, '..');
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a82kAAAAASUVORK5CYII=', 'base64');

test('image-height reflow refreshes motion positions without changing source, selection or scroll', { timeout: 60000 }, async () => {
  const workspace = await createSmokeWorkspace('markdown-motion-reflow'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const source = '![fixture](height.png)\n\nPlain lead **bold target** and following words.\n';
    await fs.writeFile(path.join(workspace.fixture, 'reflow.md'), source);
    await fs.writeFile(path.join(workspace.fixture, 'height.png'), tinyPng);
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('.file-row').filter({ hasText: 'reflow.md' }).dblclick();
    await page.locator('.cm-content').waitFor();
    await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Plain lead') + 1 } }); view.focus();
    });
    await page.waitForFunction(() => document.querySelector('.cm-md-image')?.naturalWidth > 0);
    await page.evaluate(async () => {
      await document.fonts.ready;
      const image = document.querySelector('.cm-md-image'); image.style.width = '80px'; image.style.height = '20px';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running'
        && Number.isFinite(animation.effect.getTiming().iterations)).map(animation => animation.finished.catch(() => {})));
      const view = document.querySelector('.cm-content').cmTile.root.view;
      const originalRect = Element.prototype.getBoundingClientRect, originalAnimate = Element.prototype.animate;
      window.__reflowMotion = { reads: 0, animations: [], before: { width: view.contentDOM.clientWidth,
        source: view.state.doc.toString(), head: view.state.selection.main.head, scrollTop: view.scrollDOM.scrollTop } };
      Element.prototype.getBoundingClientRect = function() {
        if (this.matches?.('[data-md-motion-key]')) window.__reflowMotion.reads++;
        return originalRect.call(this);
      };
      Element.prototype.animate = function(frames, options) {
        if (this.matches?.('[data-md-motion-key]')) window.__reflowMotion.animations.push({ frames, duration: options?.duration });
        return originalAnimate.call(this, frames, options);
      };
      // Simulate a decoded image gaining height without a source transaction.
      // This is a real DOM geometry update, not a fabricated ViewUpdate.
      image.style.height = '180px';
    });
    await page.waitForFunction(() => window.__reflowMotion.reads > 0);
    const reflow = await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      return { before: window.__reflowMotion.before, after: { width: view.contentDOM.clientWidth,
        source: view.state.doc.toString(), head: view.state.selection.main.head, scrollTop: view.scrollDOM.scrollTop } };
    });
    assert.deepEqual(reflow.after, reflow.before, 'the independent image reflow preserves editor state and width');
    await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      window.__reflowMotion.animations = [];
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('bold target') + 2 } });
    });
    await page.waitForFunction(() => window.__reflowMotion.animations.length > 0);
    const motion = await page.evaluate(() => window.__reflowMotion.animations);
    assert.ok(motion.every(item => Math.abs(parseFloat(item.frames[0].top)) < 2), 'format motion does not reuse the old image height');
    assert.ok(motion.every(item => item.duration === 120));
    assert.equal(await fs.readFile(path.join(workspace.fixture, 'reflow.md'), 'utf8'), source);
    assert.deepEqual(errors, []);
  } finally {
    if (app) await app.close();
    await cleanupSmokeWorkspace(workspace);
  }
});
