const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEpubMeta, validAnnotation } = require('../electron/epub-meta.cjs');
const { encodeReaderAnchor, decodeReaderAnchor, formatEpubAnchor } = require('../src/readerAnchor.cjs');
const { updateAnnotationComment, annotationExcerpt } = require('../src/epubAnnotationActions.cjs');

const id = '6a8d4aa2-cc3b-4dae-84c4-86b028ad7e19';
const documentId = 'a'.repeat(64);
const now = '2026-09-13T00:00:00.000Z';
const annotation = { id, kind: 'highlight', cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:4)', quote: '中文📚', comment: '批注', chapterHref: 'OEBPS/ch1.xhtml', chapterLabel: '第一章', createdAt: now, updatedAt: now };

test('EPUB metadata migrates v1 and validates version 2 annotation schema and limits', () => {
  const migrated = normalizeEpubMeta({ version: 1, id: documentId, cfi: 'epubcfi(/6/4)', progress: 0.5, fontSize: 110 }, documentId);
  assert.equal(migrated.meta.version, 2); assert.deepEqual(migrated.meta.annotations, []);
  assert.equal(validAnnotation(annotation), true);
  assert.equal(validAnnotation({ ...annotation, id: 'not-a-uuid' }), false);
  assert.equal(validAnnotation({ ...annotation, cfiRange: 'bad' }), false);
  assert.equal(validAnnotation({ ...annotation, quote: 'x'.repeat(20001) }), false);
  assert.equal(validAnnotation({ ...annotation, comment: 'x'.repeat(10001) }), false);
  assert.equal(normalizeEpubMeta({ version: 2, id: documentId, cfi: '', progress: 0, fontSize: 100, annotations: [annotation, { ...annotation, id: 'bad' }] }, documentId).warnings.length, 1);
  assert.throws(() => normalizeEpubMeta({ version: 3, id: documentId }, documentId), /较新版本/);
  assert.throws(() => normalizeEpubMeta({ version: 2, id: 'b'.repeat(64), cfi: '', progress: 0, fontSize: 100, annotations: [] }, documentId), /标识/);
  assert.throws(() => normalizeEpubMeta({ version: 2, id: documentId, cfi: '', progress: 0, fontSize: 100 }, documentId, { strict: true }), /字段不完整/);
  assert.throws(() => normalizeEpubMeta({ version: 2, id: documentId, cfi: '', progress: 0, fontSize: 100, annotations: [annotation], future: 1 }, documentId, { strict: true }), /未知字段/);
});

test('EPUB reader anchors round-trip, preserve legacy PDF links, and format chapter source', () => {
  const epub = { epubId: documentId, cfiRange: annotation.cfiRange, quote: annotation.quote, annotationId: id, chapterHref: annotation.chapterHref, chapterLabel: annotation.chapterLabel, source: '../books/read.epub' };
  const href = `#reader-anchor-${encodeReaderAnchor(epub)}`;
  assert.deepEqual(JSON.parse(JSON.stringify(decodeReaderAnchor(href))), epub);
  assert.equal(formatEpubAnchor(epub, '研究读物.epub'), '研究读物.epub · 第一章');
  const pdf = { pdfId: documentId, page: 4, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }], rotation: 0, quote: '旧版摘录' };
  assert.deepEqual(JSON.parse(JSON.stringify(decodeReaderAnchor(`#reader-anchor-${encodeReaderAnchor(pdf)}`))), pdf);
  assert.equal(decodeReaderAnchor('#reader-anchor-invalid'), null);
});

test('editing an EPUB annotation changes only its comment and update time', () => {
  const other = { ...annotation, id: 'f20d9347-901f-48f1-9a0e-5e3ae4054801' };
  const updatedAt = '2026-09-13T01:00:00.000Z';
  const updated = updateAnnotationComment([annotation, other], id, '  新批注  ', updatedAt);
  assert.deepEqual(updated[0], { ...annotation, comment: '新批注', updatedAt });
  assert.equal(updated[1], other);
  const cleared = updateAnnotationComment([annotation], id, '  ', updatedAt)[0];
  assert.equal(Object.hasOwn(cleared, 'comment'), false);
  assert.equal(validAnnotation(cleared), true);
});

test('excerpt data for an existing EPUB annotation retains its CFI and return-link identity', () => {
  assert.deepEqual(annotationExcerpt(documentId, annotation), {
    anchor: {
      epubId: documentId, cfiRange: annotation.cfiRange, quote: annotation.quote,
      annotationId: id, chapterHref: annotation.chapterHref, chapterLabel: annotation.chapterLabel,
    },
    quote: annotation.quote, comment: annotation.comment,
  });
});
