const { noteUI, focusNote, moreAction } = require('./noteUi.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const appRoot = path.resolve(__dirname, '..');
let application, workspace;
async function stop() {
  const child = application?.process();
  try { await Promise.race([application?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  application = undefined;
}
after(async () => { await stop(); if (workspace) await cleanupSmokeWorkspace(workspace); });
test('per-pane tabs keep history, shared saves, focus, drag, blanks and restart state', { timeout: 120000 }, async t => {
  workspace = await createSmokeWorkspace('note-tabs'); await fs.mkdir(workspace.fixture, { recursive: true });
  const a = path.join(workspace.fixture, 'a.md'), b = path.join(workspace.fixture, 'b.md'), c = path.join(workspace.fixture, 'c.md');
  await fs.writeFile(a, '# A\n\n- [ ] shared task\n\n' + Array.from({ length: 70 }, (_, i) => `A line ${i}`).join('\n'));
  await fs.writeFile(b, '# B\n\nbody B\n'); await fs.writeFile(c, '# C\n\nbody C\n');
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE || path.join(appRoot, 'node_modules/electron/dist/electron.exe');
  async function launch(restore = false) {
    application = await _electron.launch({ executablePath, args: process.env.ZHAOYE_SMOKE_EXECUTABLE ? (restore ? [] : [workspace.fixture]) : [appRoot, ...(restore ? [] : [workspace.fixture])], env: { ...process.env, ZHAOYE_TEST_USER_DATA: workspace.userData } });
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    const page = await application.firstWindow(); page.setDefaultTimeout(12000); await page.locator('.topbar').waitFor(); return page;
  }
  let page = await launch(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const group = id => noteUI(page, id);
  const contentGroup = id => page.locator(`[data-note-group="${id}"]`);
  const left = () => group('primary'), right = () => group('secondary');
  const file = name => page.locator('.file-row').filter({ has: page.getByText(name, { exact: true }) });
  const editor = pane => pane.locator('.cm-content');
  const tab = (pane, name) => pane.getByRole('tab', { name, exact: true });
  async function choose(name, pin = false) { await file(name)[pin ? 'dblclick' : 'click'](); await editor(left()).waitFor(); }
  async function openRight(name) { await file(name).click({ button: 'right' }); await page.getByRole('menuitem', { name: '在右侧打开', exact: true }).click(); await contentGroup('secondary').waitFor(); await tab(right(),name).waitFor(); }
  await t.test('temporary replacements and edited/permanent protection', async () => {
    await choose('a.md'); await choose('b.md'); assert.equal(await left().getByRole('tab').count(), 1);
    await choose('a.md', true); await choose('b.md'); assert.equal(await left().getByRole('tab').count(), 2);
    const before = await editor(left()).evaluate(el => (window.__tabEditor = el, true)); assert.equal(before, true);
    await editor(left()).click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('B-edit');
    await choose('c.md'); assert.equal(await left().getByRole('tab').count(), 3);
    await tab(left(), 'b.md').click(); assert.match(await editor(left()).innerText(), /B-edit/);
    assert.equal(await editor(left()).evaluate(el => el === window.__tabEditor), true, 'the active pane reuses its editor DOM');
    await page.keyboard.press('Control+z'); assert.doesNotMatch(await editor(left()).innerText(), /B-edit/);
    await page.keyboard.press('Control+y'); assert.match(await editor(left()).innerText(), /B-edit/);
    await waitForFile(b, text => text.includes('B-edit'));
    assert.equal(await page.getByRole('dialog').count(), 0, 'ordinary tab switches have no unsaved prompt');
  });
  await t.test('right click opens alongside without changing left; shared reading tasks undo from either side', async () => {
    await openRight('a.md'); assert.match(await editor(left()).innerText(), /B-edit/);
    await tab(left(), 'a.md').click();
    await focusNote(page, 'secondary'); await right().getByRole('button', { name: '切换到预览', exact: true }).click();
    const preview = right().locator('.markdown-preview:not(.preview-loading)'); await preview.waitFor();
    await editor(left()).click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('SHARED-');
    await page.waitForFunction(() => document.querySelector('[data-note-group="secondary"] .markdown-preview')?.textContent.includes('SHARED-'));
    await preview.locator('input[data-task-nonce]').click();
    await waitForFile(a, text => text.includes('SHARED-') && text.includes('- [x] shared task'));
    const submits = await page.evaluate(() => window.readerDiagnostics.snapshot().filter(e => e.operation === 'save.submit'));
    assert.equal(new Set(submits.filter(e => e.pane === 'primary').map(e => e.documentId)).size <= 2, true, 'shared views do not create another save owner');
    await preview.press('Control+z'); await waitForFile(a, text => text.includes('SHARED-') && text.includes('- [ ] shared task'));
    await preview.press('Control+z'); await waitForFile(a, text => !text.includes('SHARED-'));
    await editor(left()).press('Control+y'); // Explicitly focus the intended view before testing redo.
    try { await waitForFile(a, text => text.includes('SHARED-')); }
    catch (error) {
      console.error('[tab-redo-diagnostic]', await page.evaluate(() => ({
        focus: document.activeElement?.outerHTML.slice(0, 300),
        primary: document.querySelector('[data-note-group="primary"] .cm-content')?.textContent?.slice(0, 100),
        secondary: document.querySelector('[data-note-group="secondary"] .markdown-preview')?.textContent?.slice(0, 100),
        events: window.readerDiagnostics.snapshot().slice(-15),
      })));
      throw error;
    }
    assert.equal(await left().locator('.preview-tab').count(), 1, 'only the untouched temporary C tab remains temporary');
    await left().getByRole('button', { name: '收起资料栏', exact: true }).count();
  });
  await t.test('Ctrl+Tab, closing, drag merge, whole-group exchange and blank tabs', async () => {
    await editor(left()).click();
    const next = await left().getByRole('tab').evaluateAll(els => { const at=els.findIndex(e=>e.getAttribute('aria-selected')==='true');return els[(at+1)%els.length].textContent; });
    await page.keyboard.press('Control+Tab'); await left().locator('[role="tab"][aria-selected="true"]').filter({hasText:next}).waitFor();
    await page.keyboard.press('Control+Shift+Tab'); await left().locator('[role="tab"][aria-selected="true"]').filter({hasText:'a.md'}).waitFor();
    await right().locator('.markdown-preview').click(); await page.keyboard.press('Control+w'); await contentGroup('secondary').waitFor({ state: 'hidden' });
    await openRight('b.md'); const leftA = left().locator('.document-tab').filter({ hasText: 'a.md' });
    await leftA.dragTo(contentGroup('secondary').locator('.note-body')); await tab(right(),'a.md').waitFor(); assert.equal(await right().getByRole('tab').count(), 2); assert.equal(await left().getByRole('tab').count(), 2);
    await moreAction(page, '交换左右笔记'); assert.equal(await left().getByRole('tab').count(),2); assert.equal(await tab(left(),'a.md').count(),1);
    await moreAction(page, '关闭笔记分屏'); await contentGroup('secondary').waitFor({ state: 'hidden' }); assert.equal(await left().getByRole('tab').count(),3);
    await left().getByRole('button', { name: '新建空白标签', exact: true }).click(); await left().getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('textbox', { name: '新笔记名称', exact: true }).fill('new-tab.md'); await page.getByRole('textbox', { name: '新笔记名称', exact: true }).press('Enter');
    await tab(left(),'new-tab.md').waitFor(); assert.equal(await left().getByRole('tab', { name: '新标签', exact: true }).count(),0);
    assert.match(await fs.readFile(path.join(workspace.fixture,'new-tab.md'),'utf8'), /新笔记/);
  });
  await t.test('positions, modes and groups persist; only two editors remain mounted', async () => {
    await tab(left(),'a.md').click(); await editor(left()).click(); await page.keyboard.press('Control+End');
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(300);
    await openRight('a.md'); await right().getByRole('button',{name:'切换到预览',exact:true}).click(); await right().locator('.markdown-preview:not(.preview-loading)').waitFor();
    const out = process.env.ZUOREN_SCREENSHOT_OUTPUT || workspace.outputs; await fs.mkdir(out,{recursive:true});
    await page.screenshot({path:path.join(out,'tabs-wide.png')});
    await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(860,680)); await page.waitForTimeout(200);
    await page.screenshot({path:path.join(out,'tabs-narrow.png')});
    const bar = page.locator('.note-workspace-bar');
    const add = await page.getByRole('button', {name:'新建空白标签',exact:true}).boundingBox(), bounds = await bar.boundingBox();
    assert.ok(add && bounds && add.x>=bounds.x && add.x+add.width<=bounds.x+bounds.width, 'new-tab action remains inside the unified bar');
    assert.equal(await bar.locator('.document-tab-strip').evaluate(el=>el.scrollHeight<=el.clientHeight),true,'tabs never wrap into a second row');
    assert.equal(await page.locator('.markdown-breadcrumb').count(),0,'no duplicate path/title row');
    assert.equal(await page.locator('.note-group .note-toolbar').count(),0,'no pane-local second toolbar');
    assert.equal(await page.locator('.cm-content').count(),2,'background tabs do not mount editors');
    const exited = application.waitForEvent('close'); await page.getByRole('button',{name:'关闭窗口',exact:true}).click(); await exited; application=undefined;
    const settings=JSON.parse(await fs.readFile(path.join(workspace.userData,'settings.json'),'utf8'));
    assert.equal(settings.session.version,3); assert.equal(settings.session.noteDocuments.filter(d=>d.path===a).length,1); assert.equal(settings.session.noteGroups.secondary.tabs[0].mode,'preview');
    const savedA=settings.session.noteGroups.primary.tabs.find(t=>t.path===a); assert.ok(savedA.selection.head>0); assert.ok(savedA.scroll.edit>0);
    assert.equal(JSON.stringify(settings).includes('SHARED-'),false); page=await launch(true); await right().locator('.markdown-preview:not(.preview-loading)').waitFor();
    assert.equal(await left().getByRole('tab').count(),4); assert.equal(await right().getByRole('tab').count(),1);
    await page.waitForTimeout(3500); assert.match(await fs.readFile(a,'utf8'),/SHARED-/); assert.match(await fs.readFile(b,'utf8'),/B-edit/);
    assert.ok(await left().locator('.cm-scroller').evaluate(el=>el.scrollTop>0),'editor scroll restores independently of reading scroll');
    await editor(left()).click(); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+Home'); assert.match(await editor(left()).innerText(),/SHARED-/,'restart has no cross-restart undo promise');
  });
  await t.test('shared slow saves drain later input; failed final close keeps drafts; crash restores both views', async () => {
    await tab(left(),'a.md').click();
    await application.evaluate(() => {
      const {createRequire}=process.mainModule.require('node:module');
      const load=createRequire(process.mainModule.require('electron').app.getAppPath()+'/package.json');
      const {FileStore}=load('./electron/storage.cjs'), original=FileStore.prototype.saveNote;
      globalThis.__tabsGate={hold:true,fail:false,started:0,releases:[],original,FileStore};
      FileStore.prototype.saveNote=async function(input) {
        const gate=globalThis.__tabsGate; gate.started++;
        if(gate.hold) await new Promise(resolve=>gate.releases.push(resolve));
        if(gate.fail) throw Error('injected tab write failure');
        return original.call(this,input);
      };
    });
    await editor(left()).click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('SLOW-'); await page.keyboard.press('Control+s');
    await left().locator('.state-保存中').waitFor(); await page.keyboard.insertText('LATER-');
    await page.keyboard.press('Control+s'); assert.equal(await application.evaluate(()=>globalThis.__tabsGate.started),1,'two views and repeated saves share one in-flight write');
    await application.evaluate(()=>{const gate=globalThis.__tabsGate;gate.hold=false;gate.releases.splice(0).forEach(resolve=>resolve());});
    await waitForFile(a,text=>text.includes('SLOW-LATER-')); await left().locator('.state-已保存').waitFor();
    await right().locator('.markdown-preview').click(); await page.keyboard.press('Control+w'); await contentGroup('secondary').waitFor({state:'hidden'});
    await application.evaluate(()=>{globalThis.__tabsGate.fail=true;});
    await editor(left()).click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('KEEP-ON-FAILURE'); await page.keyboard.press('Control+w');
    await page.getByRole('dialog').waitFor(); assert.equal(await left().locator('.document-tab').filter({hasText:'a.md'}).count(),1,'failed final close retains the view');
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await application.evaluate(()=>{globalThis.__tabsGate.fail=false;}); await editor(left()).press('Control+s'); await waitForFile(a,text=>text.includes('KEEP-ON-FAILURE'));
    await tab(left(),'b.md').click(); await openRight('b.md');
    await application.evaluate(()=>{globalThis.__tabsGate.fail=true;});
    await editor(right()).click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('CRASH-DUAL-');
    const settingsFile=path.join(workspace.userData,'settings.json');
    await page.waitForTimeout(600);
    const settings=JSON.parse(await fs.readFile(settingsFile,'utf8'));
    const identity=settings.session.noteDocuments.find(doc=>doc.path===b);assert.ok(identity);
    const recoveryFile=path.join(workspace.fixture,'.reader','recovery',identity.recoveryId+'.json');
    await waitForFile(recoveryFile,text=>JSON.parse(text).content.includes('CRASH-DUAL-'));
    assert.equal(settings.session.noteDocuments.filter(doc=>doc.path===b).length,1);
    const child=application.process();spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});try{await application.close();}catch{} application=undefined;
    page=await launch(true); await waitForFile(b,text=>text.includes('CRASH-DUAL-'));
    await editor(right()).waitFor(); await editor(left()).waitFor();
    assert.match(await editor(left()).innerText(),/CRASH-DUAL-/);assert.match(await editor(right()).innerText(),/CRASH-DUAL-/);
  });
  assert.deepEqual(errors,[]);
});
