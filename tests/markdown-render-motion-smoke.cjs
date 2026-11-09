const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const root = path.resolve(__dirname, '..');

test('all heading levels disclose with one label and list IME never paints a second marker', { timeout: 90000 }, async t => {
  const workspace = await createSmokeWorkspace('markdown-render-motion'); let app;
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    await fs.writeFile(path.join(workspace.fixture, 'render-motion.md'), '正文');
    const packaged = process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [workspace.fixture] : [root, workspace.fixture], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.file-row').filter({ hasText: 'render-motion.md' }).dblclick();
    await page.locator('.cm-content').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'full');
    await page.evaluate(() => {
      window.__renderTextMotions = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.matches?.('[data-md-motion-key]')) window.__renderTextMotions.push({ key: this.dataset.mdMotionKey, frames, duration: options?.duration });
        return animate.call(this, frames, options);
      };
    });
    const settle = () => page.evaluate(async () => {
      for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
      await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running'
        && Number.isFinite(animation.effect?.getTiming().iterations)).map(animation => animation.finished.catch(() => {})));
    });
    const replaceSource = async source => {
      await page.evaluate(source => {
        const view = document.querySelector('.cm-content').cmTile.root.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, selection: { anchor: source.length } });
        view.focus();
      }, source);
      await settle();
    };
    for (const level of [1, 2, 3, 4, 5, 6]) await t.test(`heading ${level}: first entry, exit and end-caret entry`, async () => {
      const source = `${'#'.repeat(level)} 标题😀正文\n\n普通正文`, bodyFrom = level + 1, bodyTo = source.indexOf('\n');
      await replaceSource(source);
      for (const anchor of [bodyFrom + 1, source.length, bodyTo, source.length]) {
        await page.evaluate(anchor => {
          window.__renderTextMotions = [];
          document.querySelector('.cm-content').cmTile.root.view.dispatch({ selection: { anchor } });
        }, anchor);
        await page.waitForFunction(key => window.__renderTextMotions.some(motion => motion.key === key && motion.duration === 120), `${bodyFrom}:${bodyTo}`);
        await settle();
        const snapshot = await page.evaluate(() => {
          const content = document.querySelector('.cm-content'), labels = [...content.querySelectorAll('[data-md-heading-level]')];
          return { source: content.cmTile.root.view.state.doc.toString(), editors: document.querySelectorAll('.cm-editor').length,
            labels: labels.map(label => ({ level: label.dataset.mdHeadingLevel, text: getComputedStyle(label, '::before').content,
              pointerEvents: getComputedStyle(label, '::before').pointerEvents })) };
        });
        assert.equal(snapshot.source, source); assert.equal(snapshot.editors, 1);
        assert.deepEqual(snapshot.labels, [{ level: String(level), text: `"${level}"`, pointerEvents: 'none' }]);
      }
    });
    const cdp = await page.context().newCDPSession(page);
    for (const prefix of ['- ', '1. ', '- [ ] ']) await t.test(`IME prefix ${JSON.stringify(prefix)} has one visual representation`, async () => {
      await replaceSource(prefix);
      for (const text of ['w', '我们']) {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        await page.waitForFunction(expected => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === expected, prefix + text);
        const snapshot = await page.evaluate(() => {
          const content = document.querySelector('.cm-content'), line = content.querySelector('.cm-line'), copy = line.cloneNode(true);
          const markers = copy.querySelectorAll('.cm-md-list-marker, .cm-md-task-checkbox').length;
          copy.querySelectorAll('.cm-md-list-marker, .cm-md-task-checkbox, .cm-widgetBuffer').forEach(node => node.remove());
          return { markers, editableText: copy.textContent.replace(/[\u200b\ufeff]/g, ''), html: line.innerHTML,
            source: content.cmTile.root.view.state.doc.toString(), composing: content.cmTile.root.view.composing };
        });
        assert.equal(snapshot.source, prefix + text);
        assert.ok(!(snapshot.markers && snapshot.editableText.startsWith(prefix)), `widget and source prefix overlap: ${JSON.stringify(snapshot)}`);
      }
      await cdp.send('Input.insertText', { text: '我们' }); await settle();
      assert.equal(await page.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()), prefix + '我们');
    });
    await cdp.detach();
  } finally { if (app) await app.close(); await cleanupSmokeWorkspace(workspace); }
});
