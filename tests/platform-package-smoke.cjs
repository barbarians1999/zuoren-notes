const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const JSZip = require('jszip');
const { _electron } = require('playwright');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const { waitForFile } = require('./waitForFile.cjs');
const root = path.resolve(__dirname,'..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('native packaged app retains Markdown saves/undo, readers, Finder opening and restart state', {timeout:120000}, async () => {
  const executablePath = process.env.ZHAOYE_SMOKE_EXECUTABLE;
  assert.ok(executablePath,'Point the test at the actual packaged executable');
  const workspace = await createSmokeWorkspace('platform-package');
  const errors = [];
  let application;
  try {
    await fs.mkdir(workspace.fixture,{recursive:true});
    const note = path.join(workspace.fixture,'portability.md');
    const second = path.join(workspace.fixture,'finder.md');
    await fs.writeFile(note,'# Portability\n\nOriginal content.\n');
    await fs.writeFile(second,'# Finder file\n\nOpened through the native file event.\n');
    const pdf = await PDFDocument.create(); const font=await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([595,842]).drawText('Platform PDF sample',{x:40,y:750,font,size:20});
    const pdfBytes = Buffer.from(await pdf.save()); const pdfFile = path.join(workspace.fixture,'sample.pdf'); await fs.writeFile(pdfFile,pdfBytes);
    const zip = new JSZip();
    zip.file('mimetype','application/epub+zip',{compression:'STORE'});
    zip.file('META-INF/container.xml','<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('book.opf','<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">native-package</dc:identifier><dc:title>Native package</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-10T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>');
    zip.file('nav.xhtml','<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>');
    zip.file('chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>Platform EPUB sample</h1><p>Native packaged reader text.</p></body></html>');
    const epubBytes=await zip.generateAsync({type:'nodebuffer'}); const epubFile=path.join(workspace.fixture,'sample.epub'); await fs.writeFile(epubFile,epubBytes);
    const launch = async restore => {
      application=await _electron.launch({executablePath,args:restore?[]:[workspace.fixture],env:{...process.env,ZHAOYE_TEST_USER_DATA:workspace.userData}});
      assert.equal(await application.evaluate(({app})=>app.isPackaged),true);
      assert.equal(await application.evaluate(({app})=>app.getVersion()),require('../package.json').version);
      const page=await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror',e=>errors.push(e.message));
      await page.locator('.topbar').waitFor(); return page;
    };
    let page=await launch(false);
    const packageFiles=['electron/main.cjs','electron/preload.cjs','electron/session.cjs','src/sessionState.cjs','src/pathIdentity.cjs','dist/index.html','electron/assets/app-constructivist.png'];
    const expected=Object.fromEntries(await Promise.all(packageFiles.map(async file=>[file,hash(await fs.readFile(path.join(root,file)))])));
    const integrity=await application.evaluate(({app},files)=>{
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'); const base=app.getAppPath();
      const hashes=Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(base,file))).digest('hex')]));
      const ocrFiles=fs.readdirSync(path.join(base,'dist/ocr'));
      const ocrModule=require.resolve('tesseract.js',{paths:[base]});
      return {hashes,ocrFiles,ocrModule};
    },packageFiles);
    assert.deepEqual(integrity.hashes,expected);
    for(const name of ['eng.traineddata.gz','chi_sim.traineddata.gz','chi_tra.traineddata.gz']) assert.ok(integrity.ocrFiles.includes(name));
    assert.ok(integrity.ocrModule.includes('tesseract.js'));
    await page.locator('.file-row').filter({hasText:'portability.md'}).dblclick();
    const editor=page.locator('.cm-content'); await editor.waitFor(); await editor.click();
    await editor.press(process.platform==='darwin'?'Meta+ArrowDown':'Control+End'); await page.keyboard.insertText('\nNative package edit.'); await editor.press('ControlOrMeta+s');
    await waitForFile(note,text=>text.includes('Native package edit.'));
    await editor.press('ControlOrMeta+z'); await page.waitForFunction(()=>!document.querySelector('.cm-content')?.textContent.includes('Native package edit.'));
    await editor.press('ControlOrMeta+Shift+z'); await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('Native package edit.'));
    await waitForFile(note,text=>text.includes('Native package edit.'));
    await page.locator('.file-row').filter({hasText:'sample.pdf'}).click();
    await page.waitForFunction(()=>document.querySelector('[data-pdf-page="1"] canvas')?.width>0);
    await page.locator('.pdf-pane').click({position:{x:5,y:150}}); await page.keyboard.press('ControlOrMeta+f');
    await page.getByRole('textbox',{name:'PDF 查找文本',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'PDF 查找文本',exact:true}).fill('Platform');
    await page.waitForFunction(()=>document.querySelectorAll('.pdf-search-hit').length>0);
    await page.locator('.file-row').filter({hasText:'sample.epub'}).click();
    await page.frameLocator('.epub-viewer iframe').first().getByText('Native packaged reader text.',{exact:true}).waitFor();
    if(process.platform==='darwin') {
      await application.evaluate(({app},file)=>{app.emit('open-file',{preventDefault(){}},file);},second);
    } else await page.locator('.file-row').filter({hasText:'finder.md'}).dblclick();
    await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('Opened through the native file event.'));
    assert.equal(hash(await fs.readFile(pdfFile)),hash(pdfBytes)); assert.equal(hash(await fs.readFile(epubFile)),hash(epubBytes));
    await waitForFile(path.join(workspace.userData,'settings.json'),text=>{
      const session=JSON.parse(text).session; return session?.version===3 && session.noteDocuments.some(doc=>doc.path===second);
    });
    if(process.platform==='darwin') {
      const exited=new Promise(resolve=>application.process().once('exit',resolve));
      await page.keyboard.press('Meta+q');
      await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Cmd+Q did not pass the close/save gate')),15000))]);
      application=null;
    } else { await application.close(); application=null; }
    page=await launch(true);
    await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('Opened through the native file event.'));
    assert.ok((await fs.readFile(note,'utf8')).includes('Native package edit.'));
    assert.deepEqual(errors,[]);
    if(process.env.ZHAOYE_THEME_SCREENSHOTS) {await fs.mkdir(process.env.ZHAOYE_THEME_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.ZHAOYE_THEME_SCREENSHOTS,'native-package.png')});}
  } finally {
    if(application) {
      const child=application.process();
      try {await Promise.race([application.close(),new Promise(resolve=>setTimeout(resolve,3000))]);} catch {}
      if(child.exitCode===null) child.kill();
    }
    await cleanupSmokeWorkspace(workspace);
  }
});
