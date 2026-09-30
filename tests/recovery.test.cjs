const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore, digest, recoveryDraftHash } = require('../electron/storage.cjs');
const { validateSession } = require('../electron/session.cjs');

const recoveryId = '019c6e27-e55b-43d1-87d8-4e01f1f75043';
const uuid = () => recoveryId;

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhaoye-recovery-'));
  const notePath = path.join(root, '原笔记.md');
  await fs.writeFile(notePath, '# 原文\n', 'utf8');
  const store = new FileStore();
  await store.grantRoot(root);
  return { root, notePath, store };
}

test('recovery is stored beside its source, validates hashes, and can be restored', async () => {
  const { root, notePath, store } = await fixture();
  const note = await store.readNote(notePath);
  const recovery = await store.writeRecovery({
    sourcePath: notePath, paneHint: 'primary', recoveryId, baseHash: note.hash,
    content: '# 原文\n草稿', encoding: { bom: note.bom, eol: note.eol },
  });
  const recoveryPath = path.join(root, '.reader', 'recovery', `${recoveryId}.json`);
  assert.deepEqual(await fs.readdir(path.dirname(recoveryPath)), [`${recoveryId}.json`]);
  assert.equal(recovery.sourcePath, notePath);
  assert.equal(recovery.draftHash, recoveryDraftHash(recovery.content, recovery.encoding));
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(recoveryPath, 'utf8'))).sort(), [
    'baseHash', 'content', 'createdAt', 'draftHash', 'encoding', 'paneHint', 'recoveryId', 'sourcePath', 'updatedAt', 'version',
  ]);
  const checked = await store.checkRecovery(notePath, recoveryId);
  assert.equal(checked.status, 'recoverable');
  assert.equal(checked.recovery.content, '# 原文\n草稿');
  assert.equal(digest(Buffer.from('# 原文\n', 'utf8')), note.hash);
  const tampered = { ...recovery, content: '被篡改但哈希未变' };
  await fs.writeFile(recoveryPath, JSON.stringify(tampered), 'utf8');
  assert.equal((await store.checkRecovery(notePath, recoveryId)).status, 'corrupt');
});

test('recovery refuses unsafe ids, external paths, and damaged JSON', async () => {
  const { root, notePath, store } = await fixture();
  const note = await store.readNote(notePath);
  await assert.rejects(() => store.writeRecovery({ sourcePath: notePath, paneHint: 'primary', recoveryId: '../bad', baseHash: note.hash, content: 'x', encoding: { bom: false, eol: '\n' } }), /无效的恢复稿/);
  await assert.rejects(() => store.writeRecovery({ sourcePath: path.join(root, 'elsewhere.md'), paneHint: 'primary', recoveryId, baseHash: note.hash, content: 'x', encoding: { bom: false, eol: '\n' } }));
  const dir = path.join(root, '.reader', 'recovery');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${recoveryId}.json`), '{bad json', 'utf8');
  assert.equal((await store.checkRecovery(notePath, recoveryId)).status, 'corrupt');
});

test('conditional cleanup preserves a newer draft written before an older save finishes', async () => {
  const { notePath, store } = await fixture();
  const note = await store.readNote(notePath);
  const first = await store.writeRecovery({ sourcePath: notePath, paneHint: 'primary', recoveryId, baseHash: note.hash, content: '第一版', encoding: { bom: false, eol: '\n' } });
  const newer = await store.writeRecovery({ sourcePath: notePath, paneHint: 'primary', recoveryId, baseHash: note.hash, content: '后来输入的新稿', encoding: { bom: false, eol: '\n' } });
  assert.equal(await store.deleteRecoveryIfHash(notePath, recoveryId, first.draftHash), false);
  assert.equal((await store.readRecovery(notePath, recoveryId)).draftHash, newer.draftHash);
  assert.equal(await store.deleteRecoveryIfHash(notePath, recoveryId, newer.draftHash), true);
  assert.equal(await store.readRecovery(notePath, recoveryId), null);
});

test('changed source becomes a separate conflict and matching saved content is cleaned', async () => {
  const { notePath, store } = await fixture();
  const note = await store.readNote(notePath);
  const recovery = await store.writeRecovery({ sourcePath: notePath, paneHint: 'secondary', recoveryId, baseHash: note.hash, content: '我的草稿', encoding: { bom: false, eol: '\n' } });
  await fs.writeFile(notePath, '# 外部修改\n', 'utf8');
  const changed = await store.checkRecovery(notePath, recoveryId);
  assert.equal(changed.status, 'conflict');
  assert.equal(changed.recovery.content, '我的草稿');
  const saved = await store.saveNote({ path: notePath, content: recovery.content, hash: changed.note.hash, bom: false, eol: '\n' });
  assert.equal(await store.deleteRecoveryIfHash(notePath, recoveryId, saved.hash), true);
  assert.equal(await store.readRecovery(notePath, recoveryId), null);
});

test('session schema is versioned, exact, and rejects unknown or malformed state', () => {
  const session = {
    version: 1, root: 'C:\\work', currentDirectory: 'C:\\work\\notes', layout: 'split', sidebar: true, splitAt: 52,
    noteTabs: ['C:\\work\\notes\\a.md'],
    primaryNote: { path: 'C:\\work\\notes\\a.md', mode: 'edit', recoveryId: uuid() },
    secondaryNote: null, activePdf: { path: 'C:\\work\\paper.pdf', page: 3, scale: 1.3 }, activeEpub: null,
  };
  assert.deepEqual(validateSession(session), session);
  assert.equal(validateSession({ ...session, content: '不得写入正文' }), null);
  assert.equal(validateSession({ ...session, version: 2 }), null);
  assert.equal(validateSession({ ...session, splitAt: 99 }), null);
  assert.equal(validateSession({ ...session, primaryNote: { ...session.primaryNote, recoveryId: '../bad' } }), null);
});

test('session v2 persists bounded per-pane Markdown scroll memory and still reads v1', () => {
  const sessionV1 = {
    version: 1, root: 'C:\\work', currentDirectory: 'C:\\work\\notes', layout: 'split', sidebar: true, splitAt: 52,
    noteTabs: ['C:\\work\\notes\\a.md'], primaryNote: { path: 'C:\\work\\notes\\a.md', mode: 'edit', recoveryId: uuid() },
    secondaryNote: null, activePdf: null, activeEpub: null,
  };
  assert.deepEqual(validateSession(sessionV1), sessionV1);
  const sessionV2 = { ...sessionV1, version: 2, scrollMemory: [
    { pane: 'primary', path: 'C:\\work\\notes\\a.md', mode: 'edit', scrollTop: 480, ratio: 0.4 },
    { pane: 'primary', path: 'C:\\work\\notes\\a.md', mode: 'preview', scrollTop: 120, ratio: 0.2 },
    { pane: 'secondary', path: 'C:\\work\\notes\\a.md', mode: 'edit', scrollTop: 10, ratio: 0.01 },
  ] };
  assert.deepEqual(validateSession(sessionV2), sessionV2);
  assert.equal(validateSession({ ...sessionV2, extra: true }), null);
  assert.equal(validateSession({ ...sessionV2, scrollMemory: [{ ...sessionV2.scrollMemory[0], content: '正文不能进入设置' }] }), null);
  assert.equal(validateSession({ ...sessionV2, scrollMemory: Array(101).fill(sessionV2.scrollMemory[0]) }), null);
  assert.equal(validateSession({ ...sessionV2, scrollMemory: [{ ...sessionV2.scrollMemory[0], ratio: 1.1 }] }), null);
});
