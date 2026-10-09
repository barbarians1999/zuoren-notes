const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore, digest } = require('../electron/storage.cjs');

test('reader identity cache reuses stable files and rejects stale PDF/EPUB metadata after replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-identity-'));
  try {
    const store = new FileStore(); await store.grantRoot(root);
    for (const extension of ['pdf', 'epub']) {
      const file = path.join(root, 'book.' + extension);
      await fs.writeFile(file, 'original bytes');
      const first = await store.contentIdentity(file);
      const entry = store.identities.get(store.queueKey(file));
      assert.equal(await store.contentIdentity(file), first);
      assert.equal(store.identities.get(store.queueKey(file)), entry, 'cache entry reused');
      const replacement = path.join(root, 'replacement');
      await fs.writeFile(replacement, 'changed bytes!');
      await fs.rename(replacement, file);
      assert.notEqual(await store.contentIdentity(file), first);
      if (extension === 'pdf') await assert.rejects(() => store.savePdf(file, { version: 1, id: first, page: 1, annotations: [] }), /内容已变化/);
      else await assert.rejects(() => store.saveEpub(file, { version: 2, id: first, cfi: '', progress: 0, fontSize: 100, annotations: [] }), /内容已变化/);
      await fs.unlink(file);
      await assert.rejects(() => store.contentIdentity(file), { code: 'ENOENT' });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhaoye-reader-'));
  await fs.mkdir(path.join(root, '子文件夹'));
  await fs.writeFile(path.join(root, '中文笔记.md'), Buffer.from('\ufeff标题\r\n第二行\r\n', 'utf8'));
  await fs.writeFile(path.join(root, '子文件夹', '下一级笔记.md'), '下一级内容', 'utf8');
  await fs.writeFile(path.join(root, '子文件夹', '忽略.txt'), '不显示', 'utf8');
  await fs.writeFile(path.join(root, '研究.pdf'), Buffer.from('%PDF-test-content'));
  await fs.writeFile(path.join(root, '电子书.epub'), Buffer.from('epub-test-content'));
  return root;
}

test('lists folders and supported files one directory level at a time', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const top = await store.listDirectory(root, root);
  assert.equal(top.parent, null);
  assert.equal(top.entries[0].kind, 'folder');
  assert.equal(top.entries[0].name, '子文件夹');
  assert.equal(top.entries.some(entry => entry.name === '下一级笔记.md'), false);
  const nested = await store.listDirectory(root, path.join(root, '子文件夹'));
  assert.equal(nested.parent, root);
  assert.deepEqual(nested.breadcrumbs.map(item => item.name).slice(-1), ['子文件夹']);
  assert.deepEqual(nested.entries.map(entry => entry.name), ['下一级笔记.md']);
});

test('rejects paths before a root or file is granted', async () => {
  const root = await fixture(); const store = new FileStore();
  await assert.rejects(() => store.readNote(path.join(root, '中文笔记.md')), /请先/);
});

test('reads and saves UTF-8 BOM and CRLF without overwriting external edits', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const file = path.join(root, '中文笔记.md'); const note = await store.readNote(file);
  assert.equal(note.bom, true); assert.equal(note.eol, '\r\n'); assert.match(note.content, /标题/);
  const saved = await store.saveNote({ path: file, content: '标题\n更新', hash: note.hash, bom: note.bom, eol: note.eol });
  assert.equal(saved.conflict, undefined); assert.equal((await store.readNote(file)).content, '标题\r\n更新');
  const current = await store.readNote(file); await fs.writeFile(file, '外部修改', 'utf8');
  const conflict = await store.saveNote({ path: file, content: '应用修改', hash: current.hash, bom: false, eol: '\n' });
  assert.equal(conflict.conflict, true); assert.equal((await fs.readFile(file, 'utf8')), '外部修改');
});

test('searches Chinese names and markdown body', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  assert.equal((await store.search(root, '中文')).length, 1);
  assert.equal((await store.search(root, '标题'))[0].line, 1);
});

test('creates Markdown notes and folders in the selected directory without overwriting', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const note = await store.createNoteAt(path.join(root, '子文件夹'), '新笔记', '# 新笔记\n');
  assert.equal(path.basename(note.path), '新笔记.md');
  assert.equal(await fs.readFile(note.path, 'utf8'), '# 新笔记\n');
  const folder = await store.createFolderAt(root, '新增资料');
  assert.equal(folder.name, '新增资料');
  assert.equal((await fs.stat(folder.path)).isDirectory(), true);
  await assert.rejects(() => store.createNoteAt(path.join(root, '子文件夹'), '新笔记.md'), /已经存在/);
  await assert.rejects(() => store.createFolderAt(root, '新增资料'), /已经存在/);
});

test('renames entries without changing file type or overwriting another entry', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const renamed = await store.renameEntry(path.join(root, '中文笔记.md'), '整理后的笔记');
  assert.equal(path.basename(renamed.path), '整理后的笔记.md');
  assert.match(await fs.readFile(renamed.path, 'utf8'), /标题/);
  await assert.rejects(() => store.renameEntry(renamed.path, '错误.pdf'), /不能更改文件类型/);
  await assert.rejects(() => store.renameEntry(renamed.path, '研究.pdf'), /不能更改文件类型|已经存在/);
  await store.createNoteAt(root, '另一份.md');
  await assert.rejects(() => store.renameEntry(renamed.path, '另一份.md'), /已经存在/);
});

test('renaming a Markdown file migrates valid recovery source identity but leaves damaged recovery bytes untouched', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const source = path.join(root, '中文笔记.md'), note = await store.readNote(source), recoveryId = '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e19';
  await store.writeRecovery({ sourcePath: source, recoveryId, paneHint: 'primary', baseHash: note.hash, content: '恢复中的正文', encoding: { bom: note.bom, eol: note.eol } });
  const damagedId = '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e20';
  const damagedFile = path.join(root, '.reader', 'recovery', `${damagedId}.json`); await fs.writeFile(damagedFile, Buffer.from('{broken recovery bytes\r\n'));
  const damagedBefore = await fs.readFile(damagedFile);
  const renamed = await store.renameEntry(source, '重命名笔记');
  assert.equal((await store.checkRecovery(renamed.path, recoveryId)).status, 'recoverable');
  assert.equal((await store.checkRecovery(renamed.path, damagedId)).status, 'corrupt');
  assert.deepEqual(await fs.readFile(damagedFile), damagedBefore);
});

test('renaming a folder migrates nested recovery source paths', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const folder = path.join(root, '子文件夹'), source = path.join(folder, '下一级笔记.md'), note = await store.readNote(source);
  const recoveryId = '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e21';
  await store.writeRecovery({ sourcePath: source, recoveryId, paneHint: 'secondary', baseHash: note.hash, content: '嵌套草稿', encoding: { bom: note.bom, eol: note.eol } });
  const damagedId = '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e23';
  const damagedFile = path.join(folder, '.reader', 'recovery', `${damagedId}.json`); await fs.mkdir(path.dirname(damagedFile), { recursive: true });
  await fs.writeFile(damagedFile, Buffer.from('damaged folder recovery')); const damagedBefore = await fs.readFile(damagedFile);
  const renamed = await store.renameEntry(folder, '已整理');
  const movedNote = path.join(renamed.path, path.basename(source));
  assert.equal((await store.checkRecovery(movedNote, recoveryId)).status, 'recoverable');
  assert.equal((await store.readRecovery(movedNote, recoveryId)).sourcePath, movedNote);
  const movedDamaged = path.join(renamed.path, '.reader', 'recovery', `${damagedId}.json`);
  assert.equal((await store.checkRecovery(movedNote, damagedId)).status, 'corrupt'); assert.deepEqual(await fs.readFile(movedDamaged), damagedBefore);
});

test('recovery metadata write failure rolls back both the filename and prior recovery bytes', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const source = path.join(root, '中文笔记.md'), note = await store.readNote(source), recoveryId = '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e22';
  await store.writeRecovery({ sourcePath: source, recoveryId, paneHint: 'primary', baseHash: note.hash, content: '待恢复', encoding: { bom: note.bom, eol: note.eol } });
  const recordFile = path.join(root, '.reader', 'recovery', `${recoveryId}.json`), before = await fs.readFile(recordFile);
  const write = store.writeRecoveryRecord.bind(store); let fail = true;
  store.writeRecoveryRecord = (file, data) => {
    if (fail && file === recordFile && JSON.parse(data.toString('utf8')).sourcePath !== source) { fail = false; return Promise.reject(new Error('simulated write failure')); }
    return write(file, data);
  };
  await assert.rejects(() => store.renameEntry(source, '应该回滚'), /恢复稿路径迁移失败/);
  assert.equal(await fs.readFile(source, 'utf8').then(() => true), true);
  await assert.rejects(() => fs.access(path.join(root, '应该回滚.md')));
  assert.deepEqual(await fs.readFile(recordFile), before);
  assert.equal((await store.checkRecovery(source, recoveryId)).status, 'recoverable');
});

test('rejects invalid Windows entry names for create and rename', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  for (const name of ['', '..', 'bad/name', 'CON', '结尾.']) {
    await assert.rejects(() => store.createFolderAt(root, name), /名称|请输入/);
  }
  await assert.rejects(() => store.createNoteAt(root, '.隐藏'), /名称/);
  await assert.rejects(() => store.renameEntry(path.join(root, '中文笔记.md'), '坏:名字'), /名称/);
});

test('stores PDF metadata beside the source and preserves PDF hash', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const file = path.join(root, '研究.pdf'); const opened = await store.pdf(file);
  const annotation = { id: 'a1', type: 'highlight', anchor: { pdfId: opened.meta.id, page: 1, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }], rotation: 0 }, createdAt: new Date().toISOString() };
  await store.savePdf(file, { ...opened.meta, annotations: [annotation] });
  const reopened = await store.pdf(file); assert.equal(reopened.meta.annotations[0].id, 'a1');
  assert.equal(digest(Buffer.from(reopened.data)), opened.meta.id);
});

test('stores EPUB progress beside the source and leaves the book unchanged', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const file = path.join(root, '电子书.epub'); const before = await fs.readFile(file); const opened = await store.epub(file);
  await store.saveEpub(file, { ...opened.meta, cfi: 'epubcfi(/6/4!/4/2)', progress: 0.42, fontSize: 120 });
  const reopened = await store.epub(file);
  assert.equal(reopened.meta.cfi, 'epubcfi(/6/4!/4/2)');
  assert.equal(reopened.meta.progress, 0.42);
  assert.equal(reopened.meta.fontSize, 120);
  assert.deepEqual(await fs.readFile(file), before);
});

test('migrates EPUB sidecar v1 in memory and strictly saves v2 annotations atomically beside the book', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const file = path.join(root, '电子书.epub'); const before = await fs.readFile(file); const opened = await store.epub(file);
  const sidecar = path.join(root, '.reader', `${opened.meta.id}.epub.json`);
  await fs.mkdir(path.dirname(sidecar), { recursive: true });
  await fs.writeFile(sidecar, JSON.stringify({ version: 1, id: opened.meta.id, cfi: 'epubcfi(/6/4!/4/2)', progress: 0.4, fontSize: 110 }));
  const migrated = await store.epub(file);
  assert.equal(migrated.meta.version, 2); assert.deepEqual(migrated.meta.annotations, []);
  const now = new Date().toISOString();
  const annotation = { id: '4179776c-8d4c-4df4-876f-a9d7cd7f437b', kind: 'highlight', cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', quote: '摘录内容', comment: '核对史料', chapterHref: 'OEBPS/chapter1.xhtml', chapterLabel: '第一章', createdAt: now, updatedAt: now };
  await store.saveEpub(file, { ...migrated.meta, annotations: [annotation], progress: 0.7, fontSize: 120 });
  const reread = await store.epub(file);
  assert.equal(reread.meta.annotations[0].quote, '摘录内容'); assert.equal(reread.meta.progress, 0.7); assert.equal(reread.meta.fontSize, 120);
  assert.equal(JSON.parse(await fs.readFile(sidecar, 'utf8')).version, 2);
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(() => store.saveEpub(file, { ...reread.meta, unexpected: true }), /未知字段|完整/);
  await assert.rejects(() => store.saveEpub(file, { ...reread.meta, annotations: [{ ...annotation, quote: 'x'.repeat(20001) }] }), /无效/);
});

test('skips a damaged individual EPUB annotation with warning and refuses future sidecars or hash mismatch', async () => {
  const root = await fixture(); const store = new FileStore(); await store.grantRoot(root);
  const file = path.join(root, '电子书.epub'); const opened = await store.epub(file);
  const sidecar = path.join(root, '.reader', `${opened.meta.id}.epub.json`);
  await fs.mkdir(path.dirname(sidecar), { recursive: true });
  const valid = { id: '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e19', kind: 'highlight', cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:4)', quote: '保留', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await fs.writeFile(sidecar, JSON.stringify({ ...opened.meta, annotations: [valid, { ...valid, id: '../bad' }] }));
  const reopened = await store.epub(file);
  assert.equal(reopened.meta.annotations.length, 1); assert.match(reopened.warnings[0], /跳过/);
  const before = await fs.readFile(sidecar);
  await fs.writeFile(sidecar, JSON.stringify({ version: 3, id: opened.meta.id, annotations: [valid] }));
  const future = await fs.readFile(sidecar);
  await assert.rejects(() => store.epub(file), /较新版本/);
  await assert.rejects(() => store.saveEpub(file, opened.meta), /较新版本/);
  assert.deepEqual(await fs.readFile(sidecar), future);
  assert.notDeepEqual(before, future);
  const current = await store.epub(file).catch(() => null);
  assert.equal(current, null);
  await fs.writeFile(sidecar, JSON.stringify({ ...opened.meta, annotations: [valid] }));
  const original = await fs.readFile(file); await fs.writeFile(file, Buffer.from('changed EPUB bytes'));
  await assert.rejects(() => store.saveEpub(file, opened.meta), /内容已变化/);
  assert.deepEqual(await fs.readFile(sidecar), Buffer.from(JSON.stringify({ ...opened.meta, annotations: [valid] })));
  assert.notDeepEqual(await fs.readFile(file), original);
});

test('EPUB progress and annotation writes round-trip skipped raw records without duplicating or erasing them', async () => {
  const root = await fixture(), store = new FileStore(); await store.grantRoot(root);
  const file = path.join(root, '电子书.epub'), opened = await store.epub(file), bookBytes = await fs.readFile(file);
  const sidecar = path.join(root, '.reader', `${opened.meta.id}.epub.json`); await fs.mkdir(path.dirname(sidecar), { recursive: true });
  const valid = { id: '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e19', kind: 'highlight', cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:4)', quote: 'valid', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const damaged = [{ ...valid, id: '../bad', extra: { recoverable: 'original opaque data' } }, null, { ...valid, cfiRange: 'broken' }];
  await fs.writeFile(sidecar, JSON.stringify({ ...opened.meta, annotations: [valid, ...damaged] }));
  const reading = await store.epub(file); assert.equal(reading.meta.annotations.length, 1);
  for (const progress of [.2, .4]) {
    await store.saveEpub(file, { ...reading.meta, progress, annotations: [] });
    const raw = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    assert.deepEqual(raw.annotations, damaged); assert.equal(raw.progress, progress);
  }
  assert.deepEqual(await fs.readFile(file), bookBytes);
  for (const annotations of [null, {}, 'not a list']) {
    const bytes = JSON.stringify({ ...opened.meta, annotations }); await fs.writeFile(sidecar, bytes);
    await assert.rejects(store.saveEpub(file, opened.meta), /禁止覆盖/); assert.equal(await fs.readFile(sidecar, 'utf8'), bytes);
  }
  const unknown = JSON.stringify({ ...opened.meta, newField: 'preserve externally changed sidecar' }); await fs.writeFile(sidecar, unknown);
  await assert.rejects(store.saveEpub(file, opened.meta), /未知字段/); assert.equal(await fs.readFile(sidecar, 'utf8'), unknown);
});

test('valid JSON with an invalid recovery shape never blocks unrelated Markdown renames', async () => {
  const root = await fixture(), store = new FileStore(); await store.grantRoot(root);
  const directory = path.join(root, '.reader', 'recovery'); await fs.mkdir(directory, { recursive: true });
  for (const [index, content] of ['null', '[]', '42', '"wrong shape"'].entries()) {
    const file = path.join(directory, `6a8d4aa2-cc3b-4dae-84c4-86b028ad7e${30 + index}.json`);
    await fs.writeFile(file, content);
  }
  const renamed = await store.renameEntry(path.join(root, '中文笔记.md'), 'shape-safe.md');
  assert.ok(await fs.stat(renamed.path));
  for (const [index, content] of ['null', '[]', '42', '"wrong shape"'].entries()) {
    assert.equal(await fs.readFile(path.join(directory, `6a8d4aa2-cc3b-4dae-84c4-86b028ad7e${30 + index}.json`), 'utf8'), content);
  }
});
