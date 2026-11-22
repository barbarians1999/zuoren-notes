const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FileStore } = require('../electron/storage.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

let createPdfRangeTransport, ReaderSession;
test.before(async () => {
  ({ createPdfRangeTransport } = await import('../src/readers/pdfRangeTransport.ts'));
  ({ ReaderSession } = await import('../src/readers/readerSession.ts'));
});

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

test('openPdfDescriptor returns inline data for small PDFs and range descriptor for large PDFs', async () => {
  const workspace = await createSmokeWorkspace('pdf-descriptor');
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const smallFile = path.join(workspace.fixture, 'small.pdf');
    const largeFile = path.join(workspace.fixture, 'large.pdf');
    const smallBytes = Buffer.from('%PDF-1.4\nsmall-content\n%%EOF');
    const largeBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(128 * 1024, 0x41), Buffer.from('\n%%EOF')]);
    await fs.writeFile(smallFile, smallBytes);
    await fs.writeFile(largeFile, largeBytes);

    const store = new FileStore();
    await store.grantRoot(workspace.fixture);

    const smallDesc = await store.openPdfDescriptor(smallFile, { inlineThresholdBytes: 64 * 1024 });
    assert.equal(smallDesc.rangeMode, false);
    assert.equal(smallDesc.size, smallBytes.length);
    assert.ok(smallDesc.data instanceof Uint8Array);
    assert.equal(Buffer.from(smallDesc.data).equals(smallBytes), true);
    assert.equal(smallDesc.meta.id, sha256(smallBytes));

    const largeDesc = await store.openPdfDescriptor(largeFile, { inlineThresholdBytes: 64 * 1024 });
    assert.equal(largeDesc.rangeMode, true);
    assert.equal(largeDesc.size, largeBytes.length);
    assert.equal(largeDesc.data, undefined);
    assert.equal(largeDesc.meta.id, sha256(largeBytes));

    const fullLarge = await store.pdf(largeFile);
    assert.equal(largeDesc.meta.id, fullLarge.meta.id);

    await store.savePdf(largeFile, { ...largeDesc.meta, page: 12 });
    const reopened = await store.openPdfDescriptor(largeFile, { inlineThresholdBytes: 64 * 1024 });
    assert.equal(reopened.meta.page, 12);
    assert.equal(reopened.meta.id, sha256(largeBytes));
  } finally {
    await cleanupSmokeWorkspace(workspace);
  }
});

test('readPdfRange reads exact byte slices, clamps bounds, enforces grants, and releases file handle immediately', async () => {
  const workspace = await createSmokeWorkspace('pdf-range-read');
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const pdfFile = path.join(workspace.fixture, 'book.pdf');
    const noteFile = path.join(workspace.fixture, 'note.md');
    const outsideFile = path.join(workspace.userData, 'outside.pdf');
    await fs.mkdir(workspace.userData, { recursive: true });

    const content = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await fs.writeFile(pdfFile, content);
    await fs.writeFile(noteFile, '# not a pdf');
    await fs.writeFile(outsideFile, '%PDF-outside');

    const store = new FileStore();
    await store.grantRoot(workspace.fixture);

    const middle = await store.readPdfRange(pdfFile, 10, 20);
    assert.equal(Buffer.from(middle).toString('utf8'), 'ABCDEFGHIJ');

    const tail = await store.readPdfRange(pdfFile, 30, 999);
    assert.equal(Buffer.from(tail).toString('utf8'), 'UVWXYZ');

    const empty = await store.readPdfRange(pdfFile, 100, 200);
    assert.equal(empty.byteLength, 0);

    await assert.rejects(() => store.readPdfRange(noteFile, 0, 10), /PDF/);
    await assert.rejects(() => store.readPdfRange(outsideFile, 0, 10), /打开文件|打开文件夹/);

    // Verify no open file descriptor lingers on Windows before renaming.
    const renamed = path.join(workspace.fixture, 'renamed.pdf');
    await fs.rename(pdfFile, renamed);
    assert.equal(Buffer.from(await store.readPdfRange(renamed, 0, 4)).toString('utf8'), '0123');
  } finally {
    await cleanupSmokeWorkspace(workspace);
  }
});

test('persistent identity cache hits across FileStore instances and invalidates on file change', async () => {
  const workspace = await createSmokeWorkspace('pdf-id-cache');
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    await fs.mkdir(workspace.userData, { recursive: true });
    const pdfFile = path.join(workspace.fixture, 'cached.pdf');
    const cacheFile = path.join(workspace.userData, 'identity-cache.json');
    const firstBytes = Buffer.from('%PDF-1.4\nversion-one\n');
    await fs.writeFile(pdfFile, firstBytes);

    const store1 = new FileStore();
    await store1.loadIdentityCache(cacheFile);
    await store1.grantRoot(workspace.fixture);
    const id1 = await store1.contentIdentity(pdfFile);
    assert.equal(id1, sha256(firstBytes));
    await store1.flushIdentityCache();

    const cacheJson = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    assert.equal(cacheJson.version, 1);
    assert.ok(Object.values(cacheJson.entries).some(entry => entry.id === id1));

    const store2 = new FileStore();
    await store2.loadIdentityCache(cacheFile);
    await store2.grantRoot(workspace.fixture);
    const key = store2.queueKey(pdfFile);
    assert.equal(store2.identities.get(key)?.id, id1);
    assert.equal(await store2.contentIdentity(pdfFile), id1);

    const secondBytes = Buffer.from('%PDF-1.4\nversion-two-modified\n');
    await fs.writeFile(pdfFile, secondBytes);
    const id2 = await store2.contentIdentity(pdfFile);
    assert.equal(id2, sha256(secondBytes));
    assert.notEqual(id2, id1);
  } finally {
    await cleanupSmokeWorkspace(workspace);
  }
});

test('createPdfRangeTransport delivers chunks, ignores late chunks after abort, and reports errors once', async () => {
  class MockPDFDataRangeTransport {
    constructor(length, initialData) {
      this.length = length;
      this.initialData = initialData;
      this.delivered = [];
    }
    onDataRange(begin, chunk) {
      this.delivered.push({ begin, chunk });
    }
  }
  const mockPdfjs = { PDFDataRangeTransport: MockPDFDataRangeTransport };

  const transport = createPdfRangeTransport(mockPdfjs, {
    length: 100,
    readRange: async (begin, end) => new Uint8Array([begin, end]),
    onError: () => { throw new Error('unexpected error'); },
  });
  transport.requestDataRange(0, 16);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(transport.delivered.length, 1);
  assert.equal(transport.delivered[0].begin, 0);
  assert.deepEqual([...transport.delivered[0].chunk], [0, 16]);

  let resolveLate;
  const latePromise = new Promise(resolve => { resolveLate = resolve; });
  const abortedTransport = createPdfRangeTransport(mockPdfjs, {
    length: 100,
    readRange: () => latePromise,
    onError: () => { throw new Error('unexpected error after abort'); },
  });
  abortedTransport.requestDataRange(16, 32);
  abortedTransport.abort();
  resolveLate(new Uint8Array([1, 2, 3]));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(abortedTransport.delivered.length, 0);

  let errorCount = 0;
  const failingTransport = createPdfRangeTransport(mockPdfjs, {
    length: 100,
    readRange: async () => { throw new Error('read failed'); },
    onError: () => { errorCount += 1; },
  });
  failingTransport.requestDataRange(0, 16);
  failingTransport.requestDataRange(16, 32);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(errorCount, 1);
});

test('ReaderSession.open supports rangeMode descriptors without inline bytes and saves metadata', async () => {
  const saved = [];
  const docId = 'c'.repeat(64);
  const session = new ReaderSession({
    openPdf: async filePath => ({
      path: filePath,
      size: 4 * 1024 * 1024,
      rangeMode: true,
      meta: { version: 1, id: docId, page: 15, annotations: [] },
    }),
    openEpub: async () => { throw new Error('unused'); },
    savePdfMeta: async input => { saved.push(input); return true; },
    saveEpubMeta: async () => true,
  }, () => {}, () => {});

  const result = await session.open('big.pdf', 'pdf', { page: 15, scale: 1.25 });
  assert.equal(result.status, 'opened');
  const active = session.currentPdf();
  assert.ok(active);
  assert.equal(active.rangeMode, true);
  assert.equal(active.size, 4 * 1024 * 1024);
  assert.ok(active.data instanceof Uint8Array);
  assert.equal(active.data.byteLength, 0);
  assert.equal(session.getSnapshot().page, 15);
  assert.equal(session.getSnapshot().scale, 1.25);

  assert.equal(await session.updatePdf(meta => ({ ...meta, page: 20 })), true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].meta.page, 20);
});
