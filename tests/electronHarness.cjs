const playwright = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { acquireUiLock, verifyUiLock } = require('../scripts/native-ui-lock.cjs');
let ownership;
async function ownDesktop() {
  if (!ownership) ownership = process.env.ZUOREN_UI_LOCK_TOKEN
    ? verifyUiLock(process.env.ZUOREN_UI_LOCK_TOKEN)
    : acquireUiLock({ timeout: 20000, onWait: () => console.error('[native-ui] another process owns desktop input') });
  await ownership;
}
async function diagnostics(app, pages, errors) {
  const directory = process.env.ZUOREN_UI_DIAGNOSTICS || path.join(__dirname, '..', 'logs', 'verification', 'ui-runs', `${Date.now()}-${process.pid}`);
  await fs.mkdir(directory, { recursive: true });
  for (const [index, page] of pages.entries()) {
    if (page.isClosed()) continue;
    const prefix = `${Date.now()}-${process.pid}-${index}`;
    try {
      const state = await page.evaluate(() => ({
        focused: document.hasFocus(), active: document.activeElement?.outerHTML.slice(0, 700),
        theme: document.documentElement.dataset.theme, themePreference: localStorage.getItem('zhaoye-theme'), systemDark: matchMedia('(prefers-color-scheme: dark)').matches,
        hovered: [...document.querySelectorAll(':hover')].slice(-5).map(el => ({ tag: el.tagName, classes: el.className, label: el.getAttribute('aria-label') })),
        viewport: { width: innerWidth, height: innerHeight },
        animations: document.getAnimations().map(item => ({ state: item.playState, time: item.currentTime })),
        readers: [...document.querySelectorAll('.pdf-pane,.epub-pane')].map(el => ({ classes: el.className, state: { ...el.dataset } })),
      }));
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ focused: win.isFocused(), bounds: win.getBounds(), fullscreen: win.isFullScreen() })));
      await fs.writeFile(path.join(directory, prefix + '.json'), JSON.stringify({ state, windows, errors }, null, 2));
      await page.screenshot({ path: path.join(directory, prefix + '.png'), timeout: 3000 });
    } catch (error) { await fs.writeFile(path.join(directory, prefix + '-diagnostic-error.txt'), error.message); }
  }
  console.error('[native-ui] diagnostic directory: ' + directory);
}
const electron = Object.create(playwright._electron);
electron.launch = async function (...args) {
  await ownDesktop();
  const app = await playwright._electron.launch(...args), pages = [], errors = [];
  const register = page => { if (!pages.includes(page)) { pages.push(page); page.on('pageerror', error => errors.push(error.message)); } };
  app.on('window', register);
  const page = await app.firstWindow(); register(page);
  // Use real OS focus, not Playwright's emulated document.hasFocus() result.
  if (process.platform === 'win32') {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await session.detach();
  }
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
  await page.bringToFront();
  const close = app.close.bind(app);
  app.close = async () => { await diagnostics(app, pages, errors); return close(); };
  return app;
};
async function settle(locator) {
  await locator.evaluate(async element => {
    await document.fonts.ready;
    const animations = [];
    for (let node = element; node; node = node.parentElement) animations.push(...node.getAnimations());
    await Promise.all(animations.map(item => item.finished.catch(() => {})));
  });
}
async function hoverReady(locator) {
  await locator.scrollIntoViewIfNeeded(); await settle(locator); await locator.hover();
  await locator.evaluate(element => { if (!element.matches(':hover')) throw Error('Native pointer is not over the target'); });
  await settle(locator);
}
async function readerReady(page, kind, number = 1) {
  if (kind === 'pdf') await page.waitForFunction(number => {
    const el = document.querySelector(`[data-pdf-page="${number}"]`);
    return el?.querySelector('canvas')?.width > 0 && el.querySelector('.textLayer span');
  }, number);
  else {
    await page.waitForFunction(() => !document.querySelector('.epub-loading') && document.querySelector('.epub-pane')?.dataset.reflowing !== 'true' && document.querySelector('.epub-viewer iframe')?.contentDocument?.body?.textContent.trim());
    for (const frame of page.frames().slice(1)) await frame.evaluate(() => document.fonts.ready.then(() => undefined));
  }
}
module.exports = { ...playwright, _electron: electron, hoverReady, settle, readerReady };
