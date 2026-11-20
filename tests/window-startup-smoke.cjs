const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

test('startup maximizes even with a saved small restore size and window controls still work', { timeout: 60000 }, async t => {
  const workspace = await createSmokeWorkspace('window-startup'), root = path.resolve(__dirname, '..');
  let app;
  try {
    await fs.mkdir(workspace.userData, { recursive: true });
    await fs.writeFile(path.join(workspace.userData, 'settings.json'), JSON.stringify({ roots: [], recentFiles: [], session: null, window: { width: 1000, height: 680 } }));
    const packaged = process.env.ZHAOYE_EXE || process.env.ZHAOYE_SMOKE_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [] : [root], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    if (packaged) assert.equal(await app.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    await page.waitForFunction(async () => (await window.reader.getWindowState()).maximized);
    assert.deepEqual(await page.evaluate(() => window.reader.getWindowState()), { maximized: true, fullscreen: false });
    const minimumWidth = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const workWidth = screen.getDisplayMatching(window.getBounds()).workAreaSize.width;
      return { actual: window.getMinimumSize()[0], expected: Math.max(300, Math.min(380, Math.floor(workWidth / 4))), workWidth };
    });
    assert.equal(minimumWidth.actual, minimumWidth.expected, 'minimum width allows quarter-screen or narrower resizing');
    assert.ok(minimumWidth.actual <= Math.max(300, Math.floor(minimumWidth.workWidth / 4)), 'minimum width does not exceed a quarter of the work area or the 300px minimum floor');
    const assertContinuousBorder = async (name, hover = false) => {
      await page.mouse.move(300, 250);
      if (hover) await page.getByRole('button', { name: '关闭窗口', exact: true }).hover();
      await page.waitForFunction(() => !document.querySelector('.window-close').getAnimations().length);
      const geometry = await page.locator('.topbar').evaluate(bar => {
        const rect = bar.getBoundingClientRect(), controls = bar.querySelector('.window-controls'), area = controls.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          controlsHeight: area.height, controlsInside: area.top >= rect.top && area.bottom <= rect.bottom && area.right <= rect.right,
          border: getComputedStyle(bar).borderBottomWidth,
          buttonHeights: [...controls.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().height)) };
      });
      assert.equal(geometry.height, 54); assert.equal(geometry.border, '0px');
      assert.equal(Math.round(geometry.controlsHeight), 38);
      assert.equal(geometry.controlsInside, true, 'floating window controls capsule sits inside topbar bounds');
      for (const h of geometry.buttonHeights) assert.equal(h, 30, 'window buttons fit uniformly inside controls capsule');
      if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
        const image = await page.screenshot({ scale: 'css', clip: { x: geometry.left, y: geometry.top, width: geometry.width, height: geometry.height } });
        await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
        await fs.writeFile(path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, name + '.png'), image);
      }
    };
    const palette = async name => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name, exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.settings-popover'));
    };
    const assertWindowFeedback = async () => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const document = await cdp.send('DOM.getDocument');
      for (const [index, button] of (await page.locator('.window-controls > button').all()).entries()) {
        await app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus();
        });
        await page.mouse.move(300, 250);
        const before = await button.boundingBox();
        await button.hover();
        // This assertion checks CSS, not OS pointer ownership. Hold the pseudo
        // state while sampling so focus changes on a shared desktop cannot
        // invalidate the snapshot. Window clicks below still use real input.
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: `.window-controls > button:nth-child(${index + 1})` });
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
        // Hover can return before Chromium starts the color transition. Poll
        // the final visual state rather than sampling a transitional frame.
        const elementHandle = await button.elementHandle();
        const snapshot = await page.waitForFunction(element => {
          const app = element.closest('.app'), probe = document.createElement('span');
          probe.style.color = app.dataset.theme === 'constructivist' ? 'var(--hover-text)' : 'var(--topbar-hover)';
          element.append(probe); const expected = getComputedStyle(probe).color; probe.remove();
          const css = getComputedStyle(element), icon = getComputedStyle(element.querySelector('svg'));
          const offset = new DOMMatrixReadOnly(icon.transform).m42;
          if (css.color !== expected || icon.color !== expected || offset !== 0) return false;
          return { background: css.backgroundColor, color: css.color, iconColor: icon.color, expected, offset, motion: app.dataset.motion };
        }, elementHandle).catch(async error => {
          console.error('Window hover state:', await button.evaluate(element => ({
            label: element.getAttribute('aria-label') || element.title,
            theme: element.closest('.app').dataset.theme, motion: element.closest('.app').dataset.motion,
            hovered: element.matches(':hover'), active: element.matches(':active'),
            color: getComputedStyle(element).color, hover: getComputedStyle(element).getPropertyValue('--hover-text'),
            icon: getComputedStyle(element.querySelector('svg')).transform,
            animations: element.getAnimations({ subtree: true }).map(animation => ({ state: animation.playState, time: animation.currentTime })),
          })));
          throw error;
        });
        const feedback = await snapshot.jsonValue();
        await snapshot.dispose(); await elementHandle.dispose();
        assert.equal(feedback.background, 'rgba(0, 0, 0, 0)', 'all window actions use glyph-only feedback');
        assert.equal(feedback.color, feedback.expected);
        assert.equal(feedback.iconColor, feedback.color);
        assert.equal(feedback.offset, 0, 'hover keeps window glyphs still without layout shift');
        assert.deepEqual(await button.boundingBox(), before, 'hover must not move the click area');
        await button.focus();
        // :focus-visible is keyboard feedback, not a programmatic mouse focus.
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        assert.equal(await button.evaluate(element => element === document.activeElement), true);
        assert.equal(await button.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      }
      const motion = await page.locator('.app').getAttribute('data-motion');
      await page.locator('.app').evaluate(element => { element.dataset.motion = 'reduced'; });
      await page.getByRole('button', { name: '关闭窗口', exact: true }).hover();
      assert.equal(await page.locator('.window-close > svg').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42), 0);
      await page.locator('.app').evaluate((element, value) => { element.dataset.motion = value; }, motion);
      await page.mouse.move(300, 250);
      await cdp.detach();
    };
    // Theme resolution is independent of native hover assertions below.
    await page.emulateMedia({ colorScheme: 'light' }); await palette('跟随系统');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'constructivist');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'constructivist-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'constructivist');
    for (const name of ['温润宣纸', '极简纯白', '深墨夜读']) await t.test('wide window glyphs and separator: ' + name, async () => {
      await palette(name);
      await assertWindowFeedback();
      await assertContinuousBorder('topbar-wide-' + name);
      await assertContinuousBorder('topbar-wide-hover-' + name, true);
    });
    await page.getByRole('button', { name: '还原窗口', exact: true }).click();
    await page.getByRole('button', { name: '最大化窗口', exact: true }).waitFor();
    const restore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.ok(Math.abs(restore.width - 1000) <= 2 && Math.abs(restore.height - 680) <= 2, 'saved dimensions are restore bounds, not startup bounds');
    for (const name of ['温润宣纸', '极简纯白', '深墨夜读']) {
      await palette(name);
      await assertContinuousBorder('topbar-narrow-' + name);
      await assertContinuousBorder('topbar-narrow-hover-' + name, true);
    }
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const [minW, minH] = window.getMinimumSize();
      window.setBounds({ width: minW, height: Math.max(minH, 680) });
    });
    await page.waitForFunction(expectedWidth => Math.abs(window.innerWidth - expectedWidth) <= 4, minimumWidth.actual);
    const quarterLayout = await page.locator('.topbar').evaluate(bar => {
      const rect = bar.getBoundingClientRect();
      const controls = bar.querySelector('.window-controls').getBoundingClientRect();
      const modeCap = bar.querySelector('.topbar-mode-cap').getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        controlsInside: controls.left >= rect.left - 1 && controls.right <= rect.right + 1 && controls.bottom <= rect.bottom + 1,
        modeInside: modeCap.left >= rect.left - 1 && modeCap.right <= controls.left + 1,
      };
    });
    assert.equal(quarterLayout.overflowX, false, 'quarter-width window keeps zero horizontal document overflow');
    assert.equal(quarterLayout.controlsInside, true, 'window controls stay inside topbar at quarter width');
    assert.equal(quarterLayout.modeInside, true, 'mode capsule does not collide with window controls at quarter width');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.locator('.settings-popover[aria-hidden="false"]'); await settings.waitFor();
    await settings.evaluate(async element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const bodyFont = page.getByRole('combobox', { name: 'Markdown 正文字体' });
    assert.equal(await bodyFont.isVisible(), true, 'body font control remains visible at the native minimum width');
    const settingsBounds = await settings.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewportWidth: window.innerWidth };
    });
    assert.ok(settingsBounds.left >= 0 && settingsBounds.right <= settingsBounds.viewportWidth + 1,
      'settings popover stays inside the viewport at the native minimum width: ' + JSON.stringify(settingsBounds));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
      await fs.mkdir(process.env.ZUOREN_SCREENSHOT_OUTPUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ZUOREN_SCREENSHOT_OUTPUT, 'quarter-narrow.png') });
    }
    await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
    await page.getByRole('button', { name: '还原窗口', exact: true }).waitFor();
  } finally {
    const child = app?.process();
    if (app) { try { await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {} }
    if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await cleanupSmokeWorkspace(workspace);
  }
});
