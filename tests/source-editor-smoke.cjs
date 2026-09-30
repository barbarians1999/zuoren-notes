const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
let testRoot;
let fixtureRoot;
let userData;
let notePath;
let application;

after(async () => {
  const process = application?.process();
  const pid = process?.pid;
  try { await application?.close(); } catch { /* already closed */ }
  if (pid && process?.exitCode === null) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  if (testRoot) await fs.rm(testRoot, { recursive: true, force: true });
});

test('Markdown editing keeps continuous source text like Obsidian', { timeout: 90000 }, async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-source-editor-smoke-'));
  fixtureRoot = path.join(testRoot, 'fixture');
  userData = path.join(testRoot, 'user-data');
  notePath = path.join(fixtureRoot, '源码笔记.md');
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(notePath, '# 六级\n\n这是 **粗体**、==高亮== 和 ~~删除线~~。\n\n---\n\n- Markdown 列表\n- [ ] 待办事项\n- [x] 已完成\n- 缩进父项\n- 缩进子项\n- 空格父项\n- 空格子项\n> 引用预览第一行\n> 引用预览第二行\n3. > 干部用命令强制一律入食堂，收走社员炊具，甚至强行分开\n   > 家庭；男性干部再拿“解放妇女”的口号替妇女安排一切，\n   > 社会化生活就会变成对群体日常权利的侵犯。\n- 无序回车测试\n1. 有序回车测试\n> 引用回车测试\n1. 有序渲染测试\n1. 顺序项目\n\n| 名称 | 内容 |\n| --- | --- |\n| 单元格 | 可编辑 |\n\n[链接](https://example.com)\n', 'utf8');

  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const args = process.env.ZHAOYE_SMOKE_EXECUTABLE ? [fixtureRoot] : [appRoot, fixtureRoot];
  application = await electron.launch({ executablePath, args, env: { ...process.env, ZHAOYE_TEST_USER_DATA: userData } });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector('.topbar');
  await page.locator('.file-row').filter({ hasText: '源码笔记.md' }).click();

  const editor = page.locator('.markdown-source-editor .cm-content');
  await editor.waitFor();
  const initialEditorLayout = await editor.evaluate(element => {
    const scroller = element.closest('.cm-scroller');
    const content = element.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
    const clientLeft = viewport.left + scroller.clientLeft, clientRight = clientLeft + scroller.clientWidth;
    return { contentWidth: content.width, viewportWidth: scroller.clientWidth, centered: Math.abs((content.left - clientLeft) - (clientRight - content.right)) };
  });
  assert.ok(Math.abs(initialEditorLayout.contentWidth - Math.min(initialEditorLayout.viewportWidth, 880)) <= 2, `editor text column matches the preview width and fits its pane: ${JSON.stringify(initialEditorLayout)}`);
  assert.ok(initialEditorLayout.centered <= 2, `editor column is centered within its pane: ${JSON.stringify(initialEditorLayout)}`);
  const raw = await editor.innerText();
  assert.match(raw, /^# 六级/m);
  assert.match(raw, /粗体/);
  assert.match(raw, /高亮/);
  assert.equal(await page.locator('.cm-md-table').count(), 1);
  assert.equal(await page.locator('.markdown-source-editor .cm-md-horizontal-rule').count(), 1, 'thematic break renders in the source editor live preview');
  assert.match(raw, /•Markdown 列表/);
  assert.equal(await page.locator('.markdown-source-editor .cm-md-strong').count() > 0, true);
  assert.equal(await page.locator('.markdown-source-editor .cm-md-highlight').count() > 0, true);
  assert.equal(await page.locator('.markdown-source-editor .cm-md-strikethrough').count() > 0, true);
  assert.equal(await page.locator('.markdown-source-editor .cm-md-list').count() > 0, true);
  assert.equal(await page.locator('.markdown-source-editor .cm-md-task-checkbox').count(), 2);
  assert.equal(await page.locator('.markdown-source-editor .cm-md-list-marker').count() >= 2, true);
  assert.equal(await page.locator('.markdown-source-editor .cm-md-quote').count(), 6, 'standalone and list-nested quoted lines share live-preview styling');
  const nestedQuote = page.locator('.markdown-source-editor .cm-line').filter({ hasText: '干部用命令' });
  assert.equal(await nestedQuote.count(), 1, 'the ordered list item remains visible in the source editor');
  assert.equal(await page.locator('.markdown-source-editor .cm-line').filter({ hasText: '社会化生活' }).evaluate(el => el.classList.contains('cm-md-quote')), true, 'continuation lines inside a list quote keep the quote guide');
  const parentLine = page.locator('.markdown-source-editor .cm-line').filter({ hasText: '缩进父项' });
  const childLine = page.locator('.markdown-source-editor .cm-line').filter({ hasText: '缩进子项' });
  await childLine.click(); await page.keyboard.press('Home'); await page.keyboard.press('Tab');
  await page.waitForTimeout(1800);
  assert.match(await fs.readFile(notePath, 'utf8'), /- 缩进父项\n\t- 缩进子项/, 'Tab stores a tab character and Markdown parses it as four-column indentation');
  assert.equal(await page.locator('.cm-md-code-preview').count(), 0, 'nested list indentation must not become a code block');
  assert.equal(await page.locator('.markdown-source-editor .cm-md-indent-tab').count(), 1, 'tab indentation uses a distinct guide');
  await page.locator('.markdown-source-editor .cm-line').filter({ hasText: '这是' }).click();
  const parentMarker = await parentLine.locator('.cm-md-list-marker').boundingBox();
  const childMarker = await childLine.locator('.cm-md-list-marker').boundingBox();
  assert.ok(parentMarker && childMarker && childMarker.x > parentMarker.x, 'nested list marker is visibly indented');
  const spaceChild = page.locator('.markdown-source-editor .cm-line').filter({ hasText: '空格子项' });
  await spaceChild.click(); await page.keyboard.press('Home'); await page.keyboard.insertText('  ');
  await page.waitForTimeout(1800);
  assert.match(await fs.readFile(notePath, 'utf8'), /- 空格父项\n  - 空格子项/, 'typed spaces remain literal spaces');
  assert.equal(await page.locator('.markdown-source-editor .cm-md-indent-space').count(), 1, 'space indentation uses a distinct guide');
  assert.notEqual(await page.locator('.markdown-source-editor .cm-md-indent-space').evaluate(el => getComputedStyle(el).backgroundImage), 'none', 'space guide is visibly drawn');
  assert.notEqual(await page.locator('.markdown-source-editor .cm-md-indent-tab').evaluate(el => getComputedStyle(el).maskImage), 'none', 'tab guide uses a visually distinct dashed pattern');
  for (const item of [
    { text: '无序回车测试', continuationPreview: '•无序回车测试\n- ', exited: '- 无序回车测试\n\n' },
    { text: '有序回车测试', continuationPreview: '1.有序回车测试\n2. ', exited: '1. 有序回车测试\n\n' },
    { text: '引用回车测试', continuationPreview: '引用回车测试\n> ', exited: '> 引用回车测试\n\n' },
  ]) {
    const sourceLine = page.locator('.markdown-source-editor .cm-line').filter({ hasText: item.text });
    await sourceLine.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    assert.ok((await editor.innerText()).includes(item.continuationPreview), `first Enter continues the format for ${item.text}`);
    await page.keyboard.press('Enter'); await page.waitForTimeout(1800);
    const afterSecondEnter = await fs.readFile(notePath, 'utf8');
    assert.ok(afterSecondEnter.includes(item.exited), `second Enter exits the empty formatted line for ${item.text}: ${JSON.stringify(afterSecondEnter.slice(-180))}`);
  }
  const orderedLine = page.locator('.markdown-source-editor .cm-line').filter({ hasText: '有序渲染测试' });
  await orderedLine.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('有序列表第二项');
  await page.locator('.markdown-source-editor .cm-line').filter({ hasText: '这是' }).click();
  const orderedSecond = page.locator('.markdown-source-editor .cm-line').filter({ hasText: '有序列表第二项' });
  assert.equal((await orderedSecond.locator('.cm-md-list-marker').innerText()).trim(), '2.', 'continued ordered item renders its incremented number after editing');
  await page.locator('.markdown-source-editor .cm-md-task-checkbox').first().click();
  await page.waitForTimeout(1800);
  assert.match(await fs.readFile(notePath, 'utf8'), /- \[x\] 待办事项/);
  assert.equal(await page.locator('.markdown-source-editor .cm-line').count() >= 7, true);
  const table = page.locator('.cm-md-table');
  const tableCell = await table.locator('td').first().boundingBox();
  assert.ok(tableCell, 'rendered table has a pointer target');
  await page.mouse.move(tableCell.x + 3, tableCell.y + tableCell.height / 2);
  await page.mouse.down();
  await page.mouse.move(tableCell.x + Math.min(65, tableCell.width - 2), tableCell.y + tableCell.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal(await table.count(), 1, 'dragging across a rendered table does not select the entire source table');
  assert.equal(await page.getByRole('toolbar', { name: '选中文本格式' }).count(), 0);
  await table.locator('td').first().click();
  assert.equal(await table.count(), 0, 'a click, unlike a drag, enters table source editing');
  assert.match(await editor.innerText(), /单元格/);

  await editor.click();
  await page.evaluate(() => document.querySelector('.markdown-source-editor .cm-content')?.focus());
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('源码编辑不会拆成段落');
  await page.waitForTimeout(1800);
  await page.locator('.markdown-source-editor .cm-md-heading').first().waitFor();
  assert.match(await fs.readFile(notePath, 'utf8'), /源码编辑不会拆成段落/);

  await page.getByRole('button', { name: '切换到预览' }).click();
  const preview = page.locator('.markdown-preview');
  await preview.waitFor();
  await preview.getByRole('heading', { name: '六级' }).waitFor();
  assert.equal(await preview.locator('strong').getByText('粗体').count(), 1);
  assert.equal(await preview.locator('mark').getByText('高亮').count(), 1);
  assert.equal(await preview.locator('del').getByText('删除线').count(), 1);
  assert.equal(await preview.locator('input[type="checkbox"]').count(), 2);
  assert.equal(await preview.locator('ol[start="3"] blockquote').count(), 1, 'reading preview keeps a blockquote nested inside the ordered item');
  assert.equal(await preview.locator('ol li').getByText('顺序项目').count(), 1);
  assert.equal(await preview.locator('ol').filter({ hasText: '有序列表第二项' }).locator('li').count(), 3, 'continued ordered list remains one rendered list and renumbers its following item');

  await page.getByRole('button', { name: '切换到源码编辑' }).click();
  await editor.waitFor();
  assert.match(await editor.innerText(), /源码编辑不会拆成段落/);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const size = page.getByRole('slider', { name: '正文字体大小' });
  await size.fill('24');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.markdown-source-editor .cm-editor')).fontSize === '24px');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.markdown-source-editor .cm-content')).fontSize === '24px');
  assert.equal(await size.inputValue(), '24');
  await page.keyboard.press('Escape');
  const codeSource = '\n\n```text\n概念其实是理性知识\n# literal, not heading\n<script>window.__codeExecuted = true</script>\n```\n';
  await editor.click(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText(codeSource);
  await page.keyboard.press('Control+Home');
  const block = page.locator('.cm-md-code-preview');
  await block.waitFor();
  assert.equal(await block.locator('code').textContent(), '概念其实是理性知识\n# literal, not heading\n<script>window.__codeExecuted = true</script>');
  assert.equal(await block.locator('script,h1').count(), 0);
  assert.equal(await page.evaluate(() => window.__codeExecuted), undefined);
  const codeText = await block.locator('code').boundingBox();
  assert.ok(codeText, 'rendered code has a pointer target');
  await page.mouse.move(codeText.x + 5, codeText.y + Math.min(12, codeText.height / 2));
  await page.mouse.down();
  await page.mouse.move(codeText.x + Math.min(100, codeText.width - 2), codeText.y + Math.min(12, codeText.height / 2), { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal(await block.count(), 1, 'dragging across rendered code does not turn the whole source block into a selection');
  assert.equal(await page.getByRole('toolbar', { name: '选中文本格式' }).count(), 0, 'a native selection in a rendered code widget must not be mistaken for a Markdown source selection');
  const blockStyle = await block.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth }));
  assert.notEqual(blockStyle.background, 'rgba(0, 0, 0, 0)'); assert.equal(blockStyle.border, '1px');
  await page.waitForTimeout(1400);
  const codeSaved = await fs.readFile(notePath, 'utf8');
  assert.ok(codeSaved.endsWith(codeSource), 'decorations do not rewrite Markdown');
  await block.scrollIntoViewIfNeeded();
  await block.locator('code').click();
  assert.equal(await block.count(), 0, 'click enters continuous source editing');
  assert.match(await editor.innerText(), /```text/);
  assert.ok(await page.locator('.cm-md-code-line').count() >= 5);
  await page.keyboard.insertText('EDIT'); await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Home'); await block.waitFor();
  await page.waitForTimeout(1400);
  assert.equal(await fs.readFile(notePath, 'utf8'), codeSaved, 'code-block editing is undoable without serialization');
  await page.getByRole('button', { name: '切换到预览' }).click();
  await page.locator('.markdown-preview pre code').waitFor();
  assert.match(await page.locator('.markdown-preview pre code').textContent(), /概念其实是理性知识/);
  await page.getByRole('button', { name: '切换到源码编辑' }).click();
  await editor.waitFor(); await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Shift+ArrowLeft');
  const selectionToolbar = page.getByRole('toolbar', { name: '选中文本格式' });
  await selectionToolbar.waitFor({ state: 'visible' });
  await page.keyboard.press('ArrowRight');
  await selectionToolbar.waitFor({ state: 'hidden' });
});
