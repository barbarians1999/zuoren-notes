const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizePdfMeta, validPdfAnnotation } = require('../electron/pdf-meta.cjs');
const { FileStore } = require('../electron/storage.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');

const id = 'a'.repeat(64);
const annotation = { id: 'legacy-a1', type: 'note', anchor: { pdfId: id, page: 1, rects: [{ x: 0.2, y: 0.3, w: 0.025, h: 0.025 }], rotation: 0 }, text: 'keep me', createdAt: '2026-09-30T00:00:00Z' };
const meta = { version: 1, id, page: 1, annotations: [annotation] };

test('PDF metadata retains legacy IDs and validates complete nested annotation data', () => {
  assert.deepEqual(normalizePdfMeta(meta, id), meta);
  assert.ok(validPdfAnnotation(annotation, id));
  assert.ok(validPdfAnnotation({ ...annotation, text: undefined, anchor: { ...annotation.anchor, quote: undefined } }, id), 'renderer optional fields may be undefined before JSON serialization');
  assert.ok(validPdfAnnotation({ ...annotation, anchor: { ...annotation.anchor, rects: [{ x: -0.005, y: 0, w: 0.1, h: 0.1 }] } }, id), 'retain text-layer edge tolerance');
  for (const value of [
    null, { ...meta, version: 99 }, { ...meta, id: 'b'.repeat(64) },
    { ...meta, page: NaN }, { ...meta, page: 0 }, { ...meta, annotations: 'invalid-array' },
    { ...meta, futureField: true }, { ...meta, annotations: [annotation, annotation] },
    { ...meta, annotations: [{ ...annotation, anchor: null }] },
    { ...meta, annotations: [{ ...annotation, anchor: { ...annotation.anchor, rects: 'invalid' } }] },
    { ...meta, annotations: [{ ...annotation, anchor: { ...annotation.anchor, pdfId: 'b'.repeat(64) } }] },
    { ...meta, annotations: [{ ...annotation, anchor: { ...annotation.anchor, rotation: 45 } }] },
    { ...meta, annotations: [{ ...annotation, anchor: { ...annotation.anchor, rects: [{ x: NaN, y: 0, w: 0.1, h: 0.1 }] } }] },
    { ...meta, annotations: [{ ...annotation, text: {} }] },
  ]) assert.throws(() => normalizePdfMeta(value, id));
});

test('PDF read and save reject damaged or future sidecars without changing their bytes', async () => {
  const workspace = await createSmokeWorkspace('pdf-meta');
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const file = path.join(workspace.fixture, 'book.pdf');
    await fs.writeFile(file, '%PDF-test-content');
    const store = new FileStore(); await store.grantFile(file);
    const opened = await store.pdf(file);
    const dir = path.join(workspace.fixture, '.reader'); await fs.mkdir(dir);
    const sidecar = path.join(dir, opened.meta.id + '.json');
    for (const value of [
      { ...opened.meta, annotations: 'invalid-array' },
      { ...opened.meta, annotations: [{ ...annotation, anchor: null }] },
      { ...opened.meta, version: 99, futureField: 'preserve me' },
      { ...opened.meta, id: 'b'.repeat(64) },
    ]) {
      const bytes = Buffer.from(JSON.stringify(value)); await fs.writeFile(sidecar, bytes);
      await assert.rejects(() => store.pdf(file));
      // Simulate another version replacing the sidecar after this app opened it.
      await assert.rejects(() => store.savePdf(file, opened.meta));
      assert.deepEqual(await fs.readFile(sidecar), bytes);
    }
    await fs.writeFile(sidecar, '{broken json');
    await assert.rejects(() => store.savePdf(file, opened.meta));
    assert.equal(await fs.readFile(sidecar, 'utf8'), '{broken json');
    assert.equal(await fs.readFile(file, 'utf8'), '%PDF-test-content');
  } finally { await cleanupSmokeWorkspace(workspace); }
});
