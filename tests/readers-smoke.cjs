const {test,after}=require('node:test');
const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {PDFDocument,PDFName,PDFString,StandardFonts,rgb}=require('pdf-lib');const JSZip=require('jszip');const {_electron:electron}=require('playwright');
const {createSmokeWorkspace,cleanupSmokeWorkspace}=require('./smokeWorkspace.cjs');
const {waitForFile}=require('./waitForFile.cjs');
const appRoot=path.resolve(__dirname,'..');let smokeWorkspace,fixtureRoot,userData,application;
async function makeFixture() {
  smokeWorkspace=await createSmokeWorkspace('readers-smoke');fixtureRoot=smokeWorkspace.fixture;userData=smokeWorkspace.userData;
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, '专题资料'));
  await fs.writeFile(path.join(fixtureRoot, '对照笔记.md'), '# 对照笔记\n\n独立编辑和保存。\n', 'utf8');
  await fs.writeFile(path.join(fixtureRoot, '专题资料', '下一级笔记.md'), '# 下一级笔记\n', 'utf8');
  const researchNote = '# 剩余价值\n\n1. 第一项正文\n2. 第二项正文即使内容很长并且在较窄的笔记区域内自动换行，编号也应当和第一行正文保持在同一行，后续各行继续沿正文起始位置排列。\n\n我的分析：测试原位保存。\n\n## 概念\n\n```text\n概念其实是理性知识\n```\n\n### 进一步分析\n';
  await fs.writeFile(path.join(fixtureRoot, '研究笔记.md'), researchNote.replaceAll('\n', '\r\n'), 'utf8');
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= 2; number += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`Research Reader - Page ${number}`, { x: 72, y: 750, size: 20, font, color: rgb(.12, .22, .17) });
    page.drawText('Select, annotate, excerpt, and return to the source.', { x: 72, y: 710, size: 12, font });
  }
  const outlines = document.context.obj({ Type: 'Outlines' });
  const outlinesRef = document.context.register(outlines);
  const first = document.context.obj({ Title: PDFString.of('Chapter one'), Parent: outlinesRef, Dest: [document.getPage(0).ref, PDFName.of('Fit')] });
  const second = document.context.obj({ Title: PDFString.of('Chapter two'), Parent: outlinesRef, Dest: [document.getPage(1).ref, PDFName.of('Fit')] });
  const firstRef = document.context.register(first), secondRef = document.context.register(second);
  first.set(PDFName.of('Next'), secondRef); second.set(PDFName.of('Prev'), firstRef);
  outlines.set(PDFName.of('First'), firstRef); outlines.set(PDFName.of('Last'), secondRef);
  document.catalog.set(PDFName.of('Outlines'), outlinesRef);
  await fs.writeFile(path.join(fixtureRoot, '研究资料.pdf'), await document.save());

  const epub = new JSZip();
  epub.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  epub.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  epub.file('OEBPS/content.opf', '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:zhaoye-test</dc:identifier><dc:title>研究读物</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-09-09T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  epub.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">第一章 开端</a></li><li><a href="chapter2.xhtml">第二章 继续阅读</a></li></ol></nav></body></html>');
  epub.file('OEBPS/chapter1.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章 开端</h1><p>这是一本保留在原磁盘位置的测试电子书。</p></body></html>');
  epub.file('OEBPS/chapter2.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章 继续阅读</h1><p>阅读位置和字号会自动记住。</p></body></html>');
  await fs.writeFile(path.join(fixtureRoot, '研究读物.epub'), await epub.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip', compression: 'DEFLATE' }));
}

after(async()=>{const child=application?.process();try{await Promise.race([application?.close(),new Promise(r=>setTimeout(r,2500))]);}catch{}if(child?.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});if(smokeWorkspace)await cleanupSmokeWorkspace(smokeWorkspace);});
test('PDF zoom, annotations and EPUB navigation survive module migration and close', {timeout:90000},async()=>{
 await makeFixture();
 const executablePath=process.env.ZHAOYE_SMOKE_EXECUTABLE||path.join(appRoot,'node_modules/electron/dist/electron.exe');
 application=await electron.launch({executablePath,args:process.env.ZHAOYE_SMOKE_EXECUTABLE?[fixtureRoot]:[appRoot,fixtureRoot],env:{...process.env,ZHAOYE_TEST_USER_DATA:userData}});
 const page=await application.firstWindow();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('.file-row').filter({hasText:'研究笔记.md'}).click();
 const editor=page.locator('.markdown-source-editor .cm-content');await editor.waitFor();
 await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('PRE-EXCERPT');
 await page.waitForTimeout(1500);
 await page.locator('.file-row').filter({hasText:'研究资料.pdf'}).click();
 await page.waitForFunction(()=>document.querySelector('.pdf-page-slot canvas')?.width>0);
 const number=page.getByRole('textbox',{name:'当前页码'});await number.fill('2');await number.press('Enter');await page.waitForTimeout(300);
 await page.getByRole('button',{name:'放大',exact:true}).click();await page.waitForTimeout(350);assert.equal(await number.inputValue(),'2');
 await page.locator('.pdf-canvas-wrap').hover();await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await page.waitForTimeout(350);assert.equal(await number.inputValue(),'2');
 await page.getByRole('button',{name:'批注',exact:true}).click();
 await page.locator('[data-pdf-page="2"] .draw-layer.interactive').click({position:{x:150,y:120}});
 await page.getByPlaceholder('写下批注').fill('saved annotation');
 await application.evaluate(() => {
   const io=process.getBuiltinModule('node:fs/promises'),original=io.rename;
   io.rename=async (from,to) => {
     if (/[\\/]\.reader[\\/][a-f0-9]{64}\.json$/i.test(String(to))) {
       io.rename=original;
       throw new Error('injected PDF metadata write failure');
     }
     return original(from,to);
   };
 });
 await page.getByRole('button',{name:'保存批注',exact:true}).click();
 await page.getByText('标记保存失败', {exact:false}).waitFor();
 assert.equal(await page.locator('[data-pdf-page="2"] .annotation.note').count(),0,'failed write must not display an annotation');
 await page.getByRole('button',{name:'保存批注',exact:true}).click();
 await page.getByPlaceholder('写下批注').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'框选',exact:true}).click();
 const region=await page.locator('[data-pdf-page="2"] .canvas-holder').boundingBox();
 const regionY=Math.max(350,region.y+160);
 await page.mouse.move(region.x+150,regionY);await page.mouse.down();await page.mouse.move(region.x+240,regionY+50);await page.mouse.up();
 await page.getByRole('button',{name:'保存图片摘录',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('回到原文'));
 await editor.click();await page.keyboard.press('Control+z');
 const notePath=path.join(fixtureRoot,'研究笔记.md');
 await page.waitForFunction(()=>!document.querySelector('.cm-content')?.textContent.includes('回到原文'));
 await waitForFile(notePath,text=>!text.includes('回到原文'));
 assert.doesNotMatch(await fs.readFile(notePath,'utf8'),/回到原文/,'first undo removes only the excerpt');
 assert.match(await fs.readFile(notePath,'utf8'),/PRE-EXCERPT/,'prior editing history survives the excerpt');
 await page.keyboard.press('Control+z');
 await page.waitForFunction(()=>!document.querySelector('.cm-content')?.textContent.includes('PRE-EXCERPT'));
 await waitForFile(notePath,text=>!text.includes('PRE-EXCERPT'));
 assert.doesNotMatch(await fs.readFile(notePath,'utf8'),/PRE-EXCERPT/,'second undo reaches prior typing');
 await page.locator('.file-row').filter({hasText:'研究读物.epub'}).click();
 await page.locator('.epub-viewer iframe').first().waitFor();
 const toc=page.getByRole('combobox',{name:'EPUB 目录'});
 await page.waitForFunction(()=>document.querySelector('[aria-label="EPUB 目录"]')?.options.length===3);
 await toc.selectOption({label:'第二章 继续阅读'});
 await page.waitForFunction(()=>document.querySelector('.epub-chapter')?.textContent?.includes('第二章'));
 await page.getByRole('button',{name:'增大字号'}).click();
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 await application.waitForEvent('close',{timeout:12000});application=undefined;
 const sidecar=path.join(fixtureRoot,'.reader'),names=await fs.readdir(sidecar);
 const pdfMeta=JSON.parse(await fs.readFile(path.join(sidecar,names.find(n=>/^[a-f0-9]{64}\.json$/.test(n))),'utf8'));
 assert.equal(pdfMeta.page,2);assert.equal(pdfMeta.annotations.length,2);assert.equal(pdfMeta.annotations[0].text,'saved annotation');
 const epubMeta=JSON.parse(await fs.readFile(path.join(sidecar,names.find(n=>n.endsWith('.epub.json'))),'utf8'));
 assert.equal(epubMeta.fontSize,110);assert.ok(epubMeta.cfi.startsWith('epubcfi('));assert.deepEqual(errors,[]);
});
