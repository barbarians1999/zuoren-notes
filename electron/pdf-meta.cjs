const HASH = /^[a-f0-9]{64}$/i;
const META_KEYS = ['version', 'id', 'page', 'annotations'];
const ANNOTATION_KEYS = ['id', 'type', 'anchor', 'color', 'comment', 'text', 'attachment', 'ocrText', 'createdAt'];
const ANCHOR_KEYS = ['pdfId', 'page', 'rects', 'rotation', 'quote', 'source'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validPdfAnnotation(value, id) {
  if (!object(value) || Object.keys(value).some(key => !ANNOTATION_KEYS.includes(key))) return false;
  // Older PDF sidecars used non-UUID identifiers; retain those valid IDs.
  if (typeof value.id !== 'string' || !value.id || !['highlight', 'region', 'note'].includes(value.type)) return false;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return false;
  for (const key of ['color', 'comment', 'text', 'attachment', 'ocrText']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  const anchor = value.anchor;
  if (!object(anchor) || Object.keys(anchor).some(key => !ANCHOR_KEYS.includes(key))) return false;
  if (anchor.pdfId !== id || !Number.isInteger(anchor.page) || anchor.page < 1 || ![0, 90, 180, 270].includes(anchor.rotation)) return false;
  for (const key of ['quote', 'source']) if (anchor[key] !== undefined && typeof anchor[key] !== 'string') return false;
  if (!Array.isArray(anchor.rects) || !anchor.rects.length) return false;
  return anchor.rects.every(rect => object(rect) && Object.keys(rect).length === 4 &&
    ['x', 'y', 'w', 'h'].every(key => Object.hasOwn(rect, key) && Number.isFinite(rect[key])) &&
    rect.x >= -0.01 && rect.x <= 1 && rect.y >= -0.01 && rect.y <= 1 && rect.w > 0 && rect.w <= 1.02 && rect.h > 0 && rect.h <= 1.02);
}

function normalizePdfMeta(value, id) {
  if (!object(value)) throw new Error('PDF 标记数据格式无效');
  if (value.version > 1) throw new Error('此 PDF 标记数据来自较新版本，已禁止覆盖');
  if (value.version !== 1) throw new Error('不支持的 PDF 标记数据版本');
  if (!HASH.test(id) || value.id !== id) throw new Error('PDF 文档标识无效');
  if (Object.keys(value).some(key => !META_KEYS.includes(key))) throw new Error('PDF 标记数据包含未知字段，已禁止覆盖');
  if (!Number.isInteger(value.page) || value.page < 1 || !Array.isArray(value.annotations)) throw new Error('PDF 标记数据字段无效');
  const ids = new Set();
  for (const annotation of value.annotations) {
    if (!validPdfAnnotation(annotation, id) || ids.has(annotation.id)) throw new Error('PDF 标记包含无效或重复数据，已保留原文件');
    ids.add(annotation.id);
  }
  // Reject rather than silently discard annotations or unknown fields. Opening
  // a damaged sidecar must never enable an automatic destructive rewrite.
  return { version: 1, id, page: value.page, annotations: value.annotations };
}

module.exports = { normalizePdfMeta, validPdfAnnotation };
