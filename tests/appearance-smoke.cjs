const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

const appRoot = path.resolve(__dirname, '..');
let smokeWorkspace;
let fixtureRoot;
let userData;
let primaryPath;
let application;

async function stopApplication() {
  const active = application;
  application = undefined;
  if (!active) return;
  const appProcess = active.process();
  const pid = appProcess?.pid;
  try { await Promise.race([active.close(), new Promise(resolve => setTimeout(resolve, 8000))]); }
  catch { /* already closed */ }
  if (pid && appProcess?.exitCode === null) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function launchApplication() {
  const executablePath = process.env.ZHAOYE_EXE || path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const args = process.env.ZHAOYE_EXE ? [fixtureRoot] : [appRoot, fixtureRoot];
  application = await electron.launch({ executablePath, args, env: { ...process.env, ZHAOYE_TEST_USER_DATA: userData } });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector('.topbar');
  return page;
}

async function openPrimaryNote(page) {
  if (await page.locator('.note-pane[data-pane-id="primary"] .cm-content').count()) return;
  const primaryPane = page.locator('.note-pane[data-pane-id="primary"]');
  if (!await primaryPane.locator('.markdown-preview').count()) {
    await page.locator('.file-row').filter({ hasText: '甲笔记.md' }).click();
  }
  if (await primaryPane.locator('.markdown-preview').count()) {
    await primaryPane.locator('.note-toolbar button[aria-label="切换到源码编辑"]').click();
  }
  await primaryPane.locator('.cm-content').waitFor();
}

async function openSettings(page) {
  if (await page.locator('.settings-popover').count()) return;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.settings-popover').waitFor();
}

async function fontFamily(locator) {
  return locator.evaluate(element => getComputedStyle(element).fontFamily);
}

async function waitForFonts(page) {
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    const songti = ['SimSun', 'Songti SC', 'STSong'].find(name => document.fonts.check(`16px "${name}"`)) || null;
    return { bundled: document.fonts.check('16px "Zhaoye Reading"'), songti };
  });
  assert.equal(result.bundled, true, 'bundled FangSong face should load');
  process.stderr.write(`[appearance-smoke] Songti face: ${result.songti || 'generic serif fallback'}\n`);
  return result;
}

async function settingsColors(page) {
  return page.locator('.note-font-control').evaluate(element => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--text)';
    element.append(probe);
    const result = {
      expected: getComputedStyle(probe).color,
      label: getComputedStyle(element.querySelector(':scope > span')).color,
      select: getComputedStyle(element.querySelector('select')).color,
    };
    probe.remove();
    return result;
  });
}

async function menuAppearance(menu) {
  const item = menu.getByRole('menuitem').first();
  const base = await menu.evaluate(element => {
    const probe = document.createElement('span');
    probe.style.background = 'var(--surface)';
    element.append(probe);
    const result = {
      background: getComputedStyle(element).backgroundColor,
      surface: getComputedStyle(probe).backgroundColor,
      opacity: getComputedStyle(element).opacity,
      text: getComputedStyle(element.querySelector('[role="menuitem"]')).color,
    };
    probe.remove();
    return result;
  });
  await item.hover();
  const hover = await item.evaluate(element => getComputedStyle(element).backgroundColor);
  return { ...base, hover };
}

function assertOpaque(color) {
  assert.match(color, /^rgb(?:a)?\(/);
  const alpha = color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1];
  if (alpha !== undefined) assert.equal(Number(alpha), 1, `background must be opaque: ${color}`);
}

after(async () => {
  await stopApplication();
  if (smokeWorkspace) await cleanupSmokeWorkspace(smokeWorkspace);
});

test('note font setting persists without rebuilding editors and context menus stay opaque', { timeout: 120000 }, async () => {
  smokeWorkspace = await createSmokeWorkspace('appearance-smoke');
  fixtureRoot = smokeWorkspace.fixture; userData = smokeWorkspace.userData;
  primaryPath = path.join(fixtureRoot, '甲笔记.md');
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  const original = '# 一级\n\n正文不会因切换字体而变化，包含 `inline code`。\n\n- 列表正文\n\n> 引用正文\n\n| 列 | 值 |\n| --- | --- |\n| 表格 | 正文 |\n\n###### 六级\n\n```js\nconst font = "code";\n```\n';
  await fs.writeFile(primaryPath, original, 'utf8');
  await fs.writeFile(path.join(fixtureRoot, '乙笔记.md'), '# 右栏\n\n右栏也使用正文设置。\n', 'utf8');
  await fs.mkdir(path.join(fixtureRoot, '资料夹'));

  let page = await launchApplication();
  const rendererErrors = [];
  page.on('pageerror', error => rendererErrors.push(error.message));
  await openPrimaryNote(page);
  await waitForFonts(page);
  const primary = page.locator('.note-pane[data-pane-id="primary"] .cm-content');
  const primaryHeading = primary.locator('.cm-md-heading-6');
  const codeScroller = primary.locator('.cm-md-code-preview code, .cm-md-code-block').first();
  await primaryHeading.waitFor();
  await codeScroller.waitFor();
  await primary.click();
  await page.keyboard.press('Control+P');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.getByRole('button', { name: '打开命令面板' }).count(), 0);
  assert.equal(await page.getByRole('dialog', { name: '命令面板' }).count(), 0);
  await page.getByRole('button', { name: '展开大纲', exact: true }).click();
  await page.locator('.note-pane[data-pane-id="primary"] .note-outline').waitFor();
  await page.locator('.note-pane[data-pane-id="primary"]').getByRole('button', { name: '收起大纲' }).click();
  await openSettings(page);
  const fontSelect = page.getByRole('combobox', { name: 'Markdown 正文字体' });
  assert.equal(await fontSelect.inputValue(), 'fangsong');
  assert.match(await fontFamily(primary), /Zhaoye Reading/);
  assert.match(await fontFamily(primaryHeading), /Zhaoye Reading/);
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-note-font')), 'fangsong');

  const interfaceFont = await fontFamily(page.locator('.settings-popover'));
  const codeFont = await fontFamily(codeScroller);
  const inlineCodeFont = await fontFamily(primary.locator('.cm-md-inline-code').first());
  await primary.evaluate(element => { window.__appearanceEditor = element; });
  const beforeText = await primary.innerText();

  await page.evaluate(() => {
    window.__appearanceSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'zhaoye-note-font') throw new DOMException('test write fault', 'QuotaExceededError');
      return window.__appearanceSetItem.call(this, key, value);
    };
  });
  await fontSelect.selectOption('default');
  await page.getByText('正文字体已更改，但无法保存；下次启动时可能恢复原设置。', { exact: true }).waitFor();
  assert.equal(await fontSelect.inputValue(), 'default', 'write failure must retain the in-session selection');
  assert.equal(await page.evaluate(() => window.__appearanceSetItem.call(localStorage, 'zhaoye-note-font', 'fangsong')), undefined);
  await page.evaluate(() => { Storage.prototype.setItem = window.__appearanceSetItem; delete window.__appearanceSetItem; });

  await page.keyboard.press('Escape');
  await primary.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('临时撤销文本');
  await openSettings(page);
  await page.getByRole('combobox', { name: 'Markdown 正文字体' }).selectOption('songti');
  assert.equal(await page.evaluate(() => window.__appearanceEditor === document.querySelector('.note-pane[data-pane-id="primary"] .cm-content')), true);
  await page.keyboard.press('Escape');
  await primary.click();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.doesNotMatch(await primary.innerText(), /临时撤销文本/, 'undo history must survive a font change');
  await openSettings(page);
  await page.waitForTimeout(1200);
  const beforeDisk = await fs.readFile(primaryPath, 'utf8');
  const beforeStat = await fs.stat(primaryPath);

  await fontSelect.selectOption('default');
  assert.match(await fontFamily(primary), /Segoe UI/);
  assert.match(await fontFamily(primaryHeading), /Segoe UI/);
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-note-font')), 'default');
  assert.equal(await page.evaluate(() => window.__appearanceEditor === document.querySelector('.note-pane[data-pane-id="primary"] .cm-content')), true);

  await fontSelect.selectOption('fangsong');
  assert.match(await fontFamily(primary), /Zhaoye Reading/);
  await fontSelect.selectOption('songti');
  assert.match(await fontFamily(primary), /SimSun/);
  assert.match(await fontFamily(primaryHeading), /SimSun/);
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-note-font')), 'songti');
  assert.equal(await fontFamily(page.locator('.settings-popover')), interfaceFont);
  assert.equal(await fontFamily(codeScroller), codeFont);
  assert.equal(await fontFamily(primary.locator('.cm-md-inline-code').first()), inlineCodeFont);
  assert.match(beforeText, /正文不会因切换字体而变化/);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '左右分屏笔记', exact: true }).click();
  const secondary = page.locator('.note-pane[data-pane-id="secondary"] .cm-content');
  await secondary.waitFor();
  await secondary.click(); await page.keyboard.press('Control+P');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.getByRole('dialog', { name: '命令面板' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '打开命令面板' }).count(), 0);
  assert.match(await fontFamily(primary), /SimSun/);
  assert.match(await fontFamily(secondary), /SimSun/);
  await page.locator('.note-pane[data-pane-id="primary"] .note-toolbar button[aria-label="切换到预览"]').click();
  const preview = page.locator('.note-pane[data-pane-id="primary"] .markdown-preview');
  await preview.waitFor();
  await openSettings(page);
  for (const [value, pattern] of [['default', /Segoe UI/], ['fangsong', /Zhaoye Reading/], ['songti', /SimSun/]]) {
    await page.getByRole('combobox', { name: 'Markdown 正文字体' }).selectOption(value);
    assert.match(await fontFamily(preview), pattern);
    assert.match(await fontFamily(preview.getByRole('heading', { name: '六级' })), pattern);
    assert.match(await fontFamily(secondary), pattern);
  }
  assert.equal(await fontFamily(page.locator('.settings-popover')), interfaceFont);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  assert.equal(await fs.readFile(primaryPath, 'utf8'), beforeDisk);
  assert.equal((await fs.stat(primaryPath)).mtimeMs, beforeStat.mtimeMs);

  await openSettings(page);
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  const lightSettings = await settingsColors(page);
  assert.equal(lightSettings.label, lightSettings.expected);
  assert.equal(lightSettings.select, lightSettings.expected);
  await page.keyboard.press('Escape');
  const fileRow = page.locator('.file-row').filter({ hasText: '甲笔记.md' });
  await fileRow.click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.waitFor();
  const lightMenu = await menuAppearance(menu);
  assertOpaque(lightMenu.background);
  assert.equal(lightMenu.background, lightMenu.surface);
  assert.equal(lightMenu.opacity, '1');
  assert.notEqual(lightMenu.text, lightMenu.background);
  assert.notEqual(lightMenu.hover, lightMenu.background);
  await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0, 'Escape should dismiss the file menu');
  await openSettings(page);
  await page.getByRole('button', { name: '深色', exact: true }).click();
  const darkSettings = await settingsColors(page);
  assert.equal(darkSettings.label, darkSettings.expected);
  assert.equal(darkSettings.select, darkSettings.expected);
  await page.keyboard.press('Escape');
  await fileRow.click({ button: 'right' });
  await menu.waitFor();
  const darkMenu = await menuAppearance(menu);
  assertOpaque(darkMenu.background);
  assert.equal(darkMenu.background, darkMenu.surface);
  assert.equal(darkMenu.opacity, '1');
  assert.notEqual(darkMenu.text, darkMenu.background);
  assert.notEqual(darkMenu.hover, darkMenu.background);
  assert.notEqual(darkMenu.background, lightMenu.background);
  await page.keyboard.press('Escape');
  const folderRow = page.locator('.file-row').filter({ hasText: '资料夹' });
  await folderRow.click({ button: 'right' });
  await menu.waitFor();
  const folderMenu = await menuAppearance(menu);
  assert.equal(folderMenu.background, darkMenu.background);
  assert.equal(folderMenu.opacity, '1');
  await page.keyboard.press('Escape');

  for (const [value, pattern] of [['default', /Segoe UI/], ['fangsong', /Zhaoye Reading/], ['songti', /SimSun/]]) {
    await openSettings(page);
    await page.getByRole('combobox', { name: 'Markdown 正文字体' }).selectOption(value);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForSelector('.topbar');
    await openPrimaryNote(page);
    await openSettings(page);
    assert.equal(await page.getByRole('combobox', { name: 'Markdown 正文字体' }).inputValue(), value);
    assert.match(await fontFamily(page.locator('.note-pane[data-pane-id="primary"] .cm-content')), pattern);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(rendererErrors, [], 'font preference handling should not create renderer errors');

  await stopApplication();
  page = await launchApplication();
  await openPrimaryNote(page);
  await openSettings(page);
  assert.equal(await page.getByRole('combobox', { name: 'Markdown 正文字体' }).inputValue(), 'songti');
  assert.match(await fontFamily(page.locator('.note-pane[data-pane-id="primary"] .cm-content')), /SimSun/);

  await page.evaluate(() => localStorage.setItem('zhaoye-note-font', 'invalid-font'));
  await stopApplication();
  page = await launchApplication();
  await openPrimaryNote(page);
  await openSettings(page);
  assert.equal(await page.getByRole('combobox', { name: 'Markdown 正文字体' }).inputValue(), 'fangsong');
  assert.match(await fontFamily(page.locator('.note-pane[data-pane-id="primary"] .cm-content')), /Zhaoye Reading/);
  assert.equal(await page.evaluate(() => localStorage.getItem('zhaoye-note-font')), 'fangsong');

  await page.evaluate(() => localStorage.setItem('zhaoye-note-font', 'songti'));
  const readFaultErrors = [];
  page.on('pageerror', error => readFaultErrors.push(error.message));
  await page.addInitScript(() => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'zhaoye-note-font') throw new DOMException('test read fault', 'SecurityError');
      return originalGetItem.call(this, key);
    };
  });
  await page.reload();
  await page.waitForSelector('.topbar');
  await openPrimaryNote(page);
  await openSettings(page);
  assert.equal(await page.getByRole('combobox', { name: 'Markdown 正文字体' }).inputValue(), 'fangsong');
  assert.match(await fontFamily(page.locator('.note-pane[data-pane-id="primary"] .cm-content')), /Zhaoye Reading/);
  assert.deepEqual(readFaultErrors, [], 'storage read failure should be handled without an uncaught error');
});
