const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

test('startup maximizes even with a saved small restore size and window controls still work', { timeout: 30000 }, async () => {
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
    const assertContinuousBorder = async (name, hover = false) => {
      await page.mouse.move(300, 250);
      if (hover) await page.getByRole('button', { name: '关闭窗口', exact: true }).hover();
      await page.waitForFunction(() => !document.querySelector('.window-close').getAnimations().length);
      const geometry = await page.locator('.topbar').evaluate(bar => {
        const rect = bar.getBoundingClientRect(), controls = bar.querySelector('.window-controls'), area = controls.getBoundingClientRect();
        return { width: rect.width, height: rect.height, expected: getComputedStyle(bar).borderBottomColor,
          border: getComputedStyle(controls).borderLeftWidth,
          bottoms: [...controls.querySelectorAll('button')].map(button => button.getBoundingClientRect().bottom - rect.top),
          samples: [5, area.left - rect.left - 2, area.left - rect.left + 2, ...[...controls.querySelectorAll('button')].map(button => { const box = button.getBoundingClientRect(); return (box.left + box.right) / 2 - rect.left; }), rect.width - 5] };
      });
      assert.equal(geometry.height, 48); assert.equal(geometry.border, '0px');
      for (const bottom of geometry.bottoms) assert.equal(bottom, 47, 'window buttons end above the one-pixel bottom separator');
      const image = await page.screenshot({ scale: 'css', clip: { x: 0, y: 0, width: geometry.width, height: geometry.height } });
      const pixels = await page.evaluate(async ({ encoded, geometry }) => {
        const buffer = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const result = geometry.samples.map(x => [...ctx.getImageData(Math.floor(x), canvas.height - 1, 1, 1).data]);
        ctx.fillStyle = geometry.expected; ctx.fillRect(0, 0, 1, 1);
        return { result, expected: [...ctx.getImageData(0, 0, 1, 1).data] };
      }, { encoded: image.toString('base64'), geometry });
      for (const pixel of pixels.result) assert.deepEqual(pixel, pixels.expected, 'bottom separator remains continuous across window controls, including hover');
      if (process.env.ZUOREN_SCREENSHOT_OUTPUT) {
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
    for (const name of ['浅色', '深色']) {
      await palette(name);
      await assertContinuousBorder('topbar-wide-' + name);
      await assertContinuousBorder('topbar-wide-hover-' + name, true);
    }
    await page.getByRole('button', { name: '还原窗口', exact: true }).click();
    await page.getByRole('button', { name: '最大化窗口', exact: true }).waitFor();
    const restore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.ok(Math.abs(restore.width - 1000) <= 2 && Math.abs(restore.height - 680) <= 2, 'saved dimensions are restore bounds, not startup bounds');
    for (const name of ['浅色', '深色']) {
      await palette(name);
      await assertContinuousBorder('topbar-narrow-' + name);
      await assertContinuousBorder('topbar-narrow-hover-' + name, true);
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
