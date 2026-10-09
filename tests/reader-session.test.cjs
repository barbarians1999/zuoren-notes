const { test } = require('node:test');
const assert = require('node:assert/strict');
let ReaderSession;
test.before(async () => { ({ ReaderSession } = await import('../src/readers/readerSession.ts')); });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pdf = (path, id = path) => ({ path, data: new Uint8Array([path.length]), meta: { id, page: 1, annotations: [] } });
const epub = (path, id = path) => ({ path, data: new Uint8Array([path.length]), meta: { id, cfi: 'cfi-1', progress: 0, fontSize: 100, annotations: [] }, warnings: [] });
function harness(overrides = {}) {
  const saved = [];
  const adapter = {
    openPdf: async path => pdf(path), openEpub: async path => epub(path),
    savePdfMeta: async input => saved.push({ kind: 'pdf', ...input }),
    saveEpubMeta: async input => saved.push({ kind: 'epub', ...input }),
    ...overrides,
  };
  const session = new ReaderSession(adapter, () => {}, () => {});
  return { session, adapter, saved };
}

test('closing a reader keeps it on failed flush and clears it only after a successful retry', async () => {
  let fail = true;
  const { session } = harness({ saveEpubMeta: async () => { if (fail) throw new Error('disk busy'); } });
  await session.open('book.epub', 'epub');
  const expected = session.currentEpub();
  assert.equal(await session.updateEpub(meta => ({ ...meta, cfi: 'saved-position' })), false);
  assert.equal(await session.close(expected), false);
  assert.equal(session.currentEpub().path, 'book.epub');
  fail = false;
  assert.equal(await session.updateEpub(meta => ({ ...meta, cfi: 'saved-position' })), true);
  assert.equal(await session.close(expected), true);
  assert.equal(session.currentEpub(), null);
});

test('a slow close cannot clear a newer open, and repeated close has only one commit', async () => {
  const gate = deferred();
  const { session } = harness({ saveEpubMeta: async () => gate.promise });
  await session.open('first.epub', 'epub');
  const expected = session.currentEpub();
  const write = session.updateEpub(meta => ({ ...meta, cfi: 'new-position' }));
  const close = session.close(expected);
  const opened = session.open('second.epub', 'epub');
  gate.resolve(); await write;
  assert.equal(await close, false);
  assert.equal((await opened).status, 'opened');
  assert.equal(session.currentEpub().path, 'second.epub');
  assert.equal(await session.close(expected), false);
  const current = session.currentEpub();
  assert.deepEqual(await Promise.all([session.close(current), session.close(current)]), [false, true]);
});

test('a failed flush blocks switching and keeps the original reader until retry succeeds', async () => {
  let fail = true;
  const { session } = harness({ savePdfMeta: async () => { if (fail) throw new Error('disk busy'); } });
  assert.equal((await session.open('paper.pdf', 'pdf')).status, 'opened');
  assert.equal(await session.updatePdf(meta => ({ ...meta, annotations: [{ id: 'a' }] })), false);
  assert.equal((await session.open('book.epub', 'epub')).status, 'save-failed');
  assert.equal(session.currentPdf().path, 'paper.pdf');
  fail = false;
  assert.equal(await session.updatePdf(meta => ({ ...meta, annotations: [...meta.annotations, { id: 'b' }] })), true);
  assert.equal((await session.open('book.epub', 'epub')).status, 'opened');
  assert.equal(session.currentEpub().path, 'book.epub');
});

test('only the latest open request commits after a slow metadata write', async () => {
  const gate = deferred();
  const { session } = harness({ savePdfMeta: async () => gate.promise });
  await session.open('first.pdf', 'pdf');
  const write = session.updatePdf(meta => ({ ...meta, page: 8 }));
  const firstOpen = session.open('second.pdf', 'pdf');
  const latestOpen = session.open('third.epub', 'epub');
  gate.resolve();
  await write;
  assert.equal((await firstOpen).status, 'superseded');
  assert.equal((await latestOpen).status, 'opened');
  assert.equal(session.currentEpub().path, 'third.epub');
});

test('a late read cannot replace a newer open, and failed reads preserve the active document', async () => {
  const slow = deferred();
  const { session } = harness({
    openPdf: async path => path === 'slow.pdf' ? slow.promise : pdf(path),
    openEpub: async path => { if (path === 'bad.epub') throw new Error('unavailable'); return epub(path); },
  });
  await session.open('current.pdf', 'pdf');
  const pending = session.open('slow.pdf', 'pdf');
  const latest = session.open('new.epub', 'epub');
  assert.equal((await latest).status, 'opened');
  slow.resolve(pdf('slow.pdf'));
  assert.equal((await pending).status, 'superseded');
  await assert.rejects(session.open('bad.epub', 'epub'));
  assert.equal(session.currentEpub().path, 'new.epub');
});

test('PDF page and scale are session-owned and survive remapping into V3 fields', async () => {
  const { session } = harness();
  await session.open('folder/paper.pdf', 'pdf', { page: 4, scale: 1.4 });
  session.setPage(9.8); session.setScale(1.75);
  session.remapPath('folder', 'archive');
  assert.deepEqual(session.sessionFields(), { activePdf: { path: 'archive\\paper.pdf', page: 9, scale: 1.75 }, activeEpub: null });
  session.forgetPath('archive');
  assert.deepEqual(session.sessionFields(), { activePdf: null, activeEpub: null });
});

test('EPUB positions and metadata updates are scoped to the active document identity', async () => {
  const { session, saved } = harness();
  await session.open('first.epub', 'epub');
  const stale = session.currentEpub();
  await session.open('second.epub', 'epub');
  assert.equal(await session.updateEpub(meta => ({ ...meta, cfi: 'stale' }), stale), false);
  assert.equal(await session.updateEpub(meta => ({ ...meta, cfi: 'cfi-2', progress: 0.4 })), true);
  assert.equal(saved.at(-1).meta.cfi, 'cfi-2');
  session.remapPath('second.epub', 'renamed.epub');
  assert.equal(session.currentEpub().path, 'renamed.epub');
});

test('updates made while a new file is loading must commit successfully before the reader switches', async () => {
  const read = deferred(), started = deferred(), write = deferred();
  const { session } = harness({
    openPdf: async path => { if (path === 'next.pdf') { started.resolve(); return read.promise; } return pdf(path); },
    savePdfMeta: async () => { await write.promise; throw new Error('late write failed'); },
  });
  await session.open('current.pdf', 'pdf');
  const opening = session.open('next.pdf', 'pdf'); await started.promise;
  const updating = session.updatePdf(meta => ({ ...meta, page: 8 }));
  read.resolve(pdf('next.pdf'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.currentPdf().path, 'current.pdf');
  write.resolve(); assert.equal(await updating, false);
  assert.equal((await opening).status, 'save-failed');
  assert.equal(session.currentPdf().path, 'current.pdf');
});

test('final position capture is saved before commit and reopening the same file does not restore stale metadata', async () => {
  let session, armed = false, reopening = false;
  const saved = [];
  session = new ReaderSession({ openPdf: async path => { armed = reopening; return pdf(path); }, openEpub: async path => epub(path),
    savePdfMeta: async input => saved.push(input), saveEpubMeta: async () => {} }, () => {}, () => {
      if (armed) { armed = false; void session.updatePdf(meta => ({ ...meta, page: 6, annotations: [{ id: 'late-mark' }] })); }
    });
  await session.open('current.pdf', 'pdf');
  const previous = session.currentPdf();
  reopening = true;
  await session.open('current.pdf', 'pdf');
  assert.equal(session.currentPdf().meta.page, 6);
  assert.equal(session.currentPdf().meta.annotations[0].id, 'late-mark');
  assert.equal(session.isCurrentPdf(previous), false);
  assert.equal(saved.at(-1).meta.page, 6);
});

test('EPUB updates during file loading block a failed switch and allow a successful explicit retry', async () => {
  const read = deferred(), started = deferred(), write = deferred(); let fail = true;
  const { session } = harness({
    openEpub: async path => { if (path === 'next.epub') { started.resolve(); return read.promise; } return epub(path); },
    saveEpubMeta: async () => { await write.promise; if (fail) throw Error('late EPUB write failed'); },
  });
  await session.open('current.epub', 'epub');
  const opening = session.open('next.epub', 'epub'); await started.promise;
  const updating = session.updateEpub(meta => ({ ...meta, cfi: 'late-cfi' }));
  read.resolve(epub('next.epub')); write.resolve(); assert.equal(await updating, false);
  assert.equal((await opening).status, 'save-failed'); assert.equal(session.currentEpub().path, 'current.epub');
  fail = false; assert.equal(await session.updateEpub(meta => ({ ...meta, cfi: 'late-cfi' })), true);
  assert.equal((await session.open('next.epub', 'epub')).status, 'opened');
});
