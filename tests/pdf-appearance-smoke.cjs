const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const UPNG = createRequire(require.resolve('pdf-lib'))('@pdf-lib/upng').default;
const { _electron } = require('./electronHarness.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
let workspace, app;
after(async () => {
  const child = app?.process();
  try { await Promise.race([app?.close(), new Promise(resolve => setTimeout(resolve, 2500))]); } catch {}
  if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio:'ignore' });
  if (workspace) await cleanupSmokeWorkspace(workspace);
});
test('PDF night paper, color/scan images, theme/zoom/selection and original-color crop', {timeout:120000}, async t => {
  workspace = await createSmokeWorkspace('pdf-appearance');
  await fs.mkdir(workspace.fixture, {recursive:true});
  const rgba = new Uint8Array(20 * 20 * 4);
  for (let n=0;n<rgba.length;n+=4) rgba.set([240,80,40,255],n);
  const png = UPNG.encode([rgba.buffer],20,20,0);
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica), image = await doc.embedPng(png);
  const mixed = doc.addPage([440,280]);
  mixed.drawText('Night selection preserves text', {font,size:18,x:30,y:235});
  mixed.drawImage(image,{x:30,y:40,width:100,height:100});
  // Same image several times exercises PDF.js optimized image groups.
  mixed.drawImage(image,{x:160,y:40,width:100,height:100});
  mixed.drawImage(image,{x:290,y:40,width:100,height:100});
  const scan = doc.addPage([440,280]); scan.drawImage(image,{x:0,y:0,width:440,height:280});
  const rotated = doc.addPage([440,280]); rotated.setRotation(degrees(90));
  rotated.drawImage(image,{x:30,y:40,width:100,height:100});
  const file = path.join(workspace.fixture,'night.pdf'), bytes = Buffer.from(await doc.save());
  await fs.writeFile(file,bytes); await fs.writeFile(path.join(workspace.fixture,'target.md'),'# Target\n');
  const root = path.resolve(__dirname,'..'), packaged=process.env.ZHAOYE_SMOKE_EXECUTABLE;
  app = await _electron.launch({executablePath:packaged||path.join(root,'node_modules/electron/dist/electron.exe'),args:packaged?[workspace.fixture]:[root,workspace.fixture],env:{...process.env,ZHAOYE_TEST_USER_DATA:workspace.userData}});
  const page = await app.firstWindow(); page.setDefaultTimeout(12000);
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.locator('.topbar').waitFor();
  await page.locator('.file-row').filter({hasText:'target.md'}).click();
  await page.locator('.cm-content').waitFor();
  await app.evaluate(({BrowserWindow}) => { const w=BrowserWindow.getAllWindows()[0];w.unmaximize();w.setBounds({width:1280,height:900});w.focus(); });
  const theme = async dark => {
    // Keyboard theme changes avoid the intentional outside-pointer selection
    // dismissal, so this verifies the repaint itself leaves selection intact.
    const settings=page.getByRole('button',{name:'设置',exact:true});
    await settings.focus();await settings.press('Enter');
    const option=page.getByRole('button',{name:dark?'深色':'浅色',exact:true});
    await option.focus();await option.press('Enter');
    await settings.focus();await settings.press('Enter');
  };
  await theme(false);
  await page.locator('.file-row').filter({hasText:'night.pdf'}).click();
  const ready = async n => page.waitForFunction(n=>{
    const el=document.querySelector(`[data-pdf-page="${n}"] .canvas-holder`),c=el?.querySelector('canvas');
    return c?.width>0 && !el.querySelector('.loading') && c.getContext('2d').getImageData(0,0,1,1).data[3]===255;
  },n);
  await ready(1);
  const pixel = async (n,x,y) => page.locator(`[data-pdf-page="${n}"] canvas`).evaluate((c,[x,y])=>[...c.getContext('2d').getImageData(Math.floor(x*c.width),Math.floor(y*c.height),1,1).data],[x,y]);
  const jump = async n => {const input=page.getByRole('textbox',{name:'当前页码',exact:true});await input.fill(String(n));await input.press('Enter');await ready(n);};
  await t.test('black paper, light text, three warm-color images remain warm and dimmed',async()=>{
    assert.deepEqual(await pixel(1,.01,.01),[255,255,255,255]);
    await page.evaluate(()=>{window.__nightLayer=document.querySelector('[data-pdf-page="1"] .textLayer');window.__nightCanvas=document.querySelector('[data-pdf-page="1"] canvas');});
    await theme(true);
    assert.deepEqual(await pixel(1,.01,.01),[0,0,0,255]);
    for(const x of [80/440,210/440,340/440]) {
      const color=await pixel(1,x,190/280);
      assert.ok(Math.abs(color[0]-156)<=2 && Math.abs(color[1]-52)<=2 && Math.abs(color[2]-26)<=2,JSON.stringify(color));
    }
    assert.deepEqual(await pixel(1,145/440,190/280),[0,0,0,255],'space between images stays black');
    assert.equal(await page.evaluate(()=>window.__nightLayer===document.querySelector('[data-pdf-page="1"] .textLayer') && window.__nightCanvas===document.querySelector('[data-pdf-page="1"] canvas')),true);
    const bright=await page.locator('[data-pdf-page="1"] canvas').evaluate(c=>{const ctx=c.getContext('2d'),data=ctx.getImageData(0,0,c.width,c.height*.2).data;return data.some((v,i)=>i%4===0&&v>200)});
    assert.equal(bright,true,'text becomes light');
    if(process.env.ZHAOYE_PDF_SCREENSHOTS){await fs.mkdir(process.env.ZHAOYE_PDF_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.ZHAOYE_PDF_SCREENSHOTS,'night-pdf.png')});}
  });
  await t.test('scan page and rotated image are dimmed instead of inverted',async()=>{
    await jump(2); assert.deepEqual(await pixel(2,.5,.5),[156,52,26,255]);
    await jump(3); assert.deepEqual(await pixel(3,90/280,80/440),[156,52,26,255]);
    await jump(1);
  });
  await t.test('theme toggle retains native selection, page and text nodes; zoom repaints images',async()=>{
    const endpoints=await page.locator('[data-pdf-page="1"] .textLayer').evaluate(el=>{
      const node=el.querySelector('span').firstChild,range=document.createRange();
      range.setStart(node,0);range.setEnd(node,1);const a=range.getBoundingClientRect();
      range.setStart(node,4);range.setEnd(node,5);const b=range.getBoundingClientRect();
      return {x:a.left+.5,y:a.top+a.height/2,end:b.right-.5};
    });
    await page.mouse.move(endpoints.x,endpoints.y);await page.mouse.down();
    for(let i=1;i<=8;i++){await page.mouse.move(endpoints.x+(endpoints.end-endpoints.x)*i/8,endpoints.y);await page.evaluate(()=>new Promise(requestAnimationFrame));}
    await page.mouse.up();await page.locator('.pdf-text-actions').waitFor();
    const selected=await page.locator('.pdf-text-selection').count();assert.ok(selected>0);
    await theme(false);
    assert.deepEqual(await pixel(1,80/440,190/280),[240,80,40,255]);
    assert.equal(await page.getByRole('textbox',{name:'当前页码',exact:true}).inputValue(),'1');
    assert.equal(await page.evaluate(()=>window.__nightLayer===document.querySelector('[data-pdf-page="1"] .textLayer')),true);
    assert.equal(await page.locator('.pdf-text-selection').count(),selected);
    await theme(true);
    assert.equal(await page.locator('.pdf-text-selection').count(),selected);
    await page.locator('.pdf-text-actions').getByRole('button',{name:'高亮',exact:true}).click();
    await page.locator('.pdf-saved-highlight').waitFor();
    assert.equal(await page.locator('.pdf-saved-highlight').evaluate(el=>getComputedStyle(el).mixBlendMode),'screen');
    await page.getByRole('button',{name:'放大',exact:true}).click(); await ready(1);
    assert.deepEqual(await pixel(1,80/440,190/280),[156,52,26,255]);
  });
  await t.test('night search overlays remain visible without changing search results',async()=>{
    await page.getByRole('button',{name:'在 PDF 中查找',exact:true}).click();
    await page.getByRole('textbox',{name:'PDF 查找文本',exact:true}).fill('Night');
    await page.locator('.pdf-search-hit').waitFor();
    assert.equal(await page.locator('.pdf-search-hit').evaluate(el=>getComputedStyle(el).mixBlendMode),'screen');
    await page.getByRole('button',{name:'关闭 PDF 查找',exact:true}).click();
  });
  await t.test('image excerpt is original-color and source PDF is untouched',async()=>{
    await page.getByRole('button',{name:'框选',exact:true}).click();
    const box=await page.locator('[data-pdf-page="1"] .canvas-holder').boundingBox();
    await page.mouse.move(box.x+40/440*box.width,box.y+150/280*box.height);await page.mouse.down();
    await page.mouse.move(box.x+120/440*box.width,box.y+230/280*box.height,{steps:8});await page.mouse.up();
    await page.getByRole('button',{name:'保存图片摘录',exact:true}).click();
    await page.getByRole('button',{name:'保存图片摘录',exact:true}).waitFor({state:'hidden'});
    const files=await fs.readdir(path.join(workspace.fixture,'.reader'));
    const sidecar=files.find(name=>name.endsWith('.json'));
    const meta=JSON.parse(await fs.readFile(path.join(workspace.fixture,'.reader',sidecar),'utf8'));
    const region=meta.annotations.find(a=>a.type==='region');assert.ok(region?.attachment);
    const imagePath=path.resolve(path.dirname(file),region.attachment);
    const buffer=await fs.readFile(imagePath);
    const stored=UPNG.decode(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
    const pixels=new Uint8Array(UPNG.toRGBA8(stored)[0]);
    const i=(Math.floor(stored.height/2)*stored.width+Math.floor(stored.width/2))*4;
    assert.deepEqual([...pixels.slice(i,i+4)],[240,80,40,255]);
    assert.deepEqual(await fs.readFile(file),bytes);
  });
  assert.deepEqual(errors,[]);
});
