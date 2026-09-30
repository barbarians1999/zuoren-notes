const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const EpubCfi = /^epubcfi\(.+\)$/;
const META_KEYS = ['version', 'id', 'cfi', 'progress', 'fontSize', 'annotations'];
const ANNOTATION_KEYS = ['id', 'kind', 'cfiRange', 'quote', 'comment', 'chapterHref', 'chapterLabel', 'createdAt', 'updatedAt'];

function validAnnotation(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return false;
  if (Object.keys(annotation).some(key => !ANNOTATION_KEYS.includes(key)) || !['id', 'kind', 'cfiRange', 'quote', 'createdAt', 'updatedAt'].every(key => Object.hasOwn(annotation, key))) return false;
  if (!UUID.test(annotation.id) || annotation.kind !== 'highlight' || typeof annotation.cfiRange !== 'string' || annotation.cfiRange.length > 8192 || !EpubCfi.test(annotation.cfiRange)) return false;
  if (typeof annotation.quote !== 'string' || annotation.quote.length > 20000) return false;
  if (Object.hasOwn(annotation, 'comment') && (typeof annotation.comment !== 'string' || annotation.comment.length > 10000)) return false;
  if (Object.hasOwn(annotation, 'chapterHref') && (typeof annotation.chapterHref !== 'string' || annotation.chapterHref.length > 2048)) return false;
  if (Object.hasOwn(annotation, 'chapterLabel') && (typeof annotation.chapterLabel !== 'string' || annotation.chapterLabel.length > 512)) return false;
  return Number.isFinite(Date.parse(annotation.createdAt)) && Number.isFinite(Date.parse(annotation.updatedAt));
}

function normalizeEpubMeta(value, id, { strict = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EPUB 阅读数据格式无效');
  if (value.version > 2) throw new Error('此 EPUB 标注数据来自较新版本，已禁止覆盖');
  if (![1, 2].includes(value.version)) throw new Error('不支持的 EPUB 阅读数据版本');
  if (value.id !== id || !HASH.test(value.id)) throw new Error('EPUB 文档标识无效');
  if (value.version === 2 && Object.keys(value).some(key => !META_KEYS.includes(key))) throw new Error('EPUB 标注数据包含未知字段，已禁止覆盖');
  if (strict && value.version !== 2) throw new Error('EPUB 标注数据必须使用版本 2');
  if (strict && (Object.keys(value).length !== META_KEYS.length || META_KEYS.some(key => !Object.hasOwn(value, key)))) throw new Error('EPUB 标注数据字段不完整');
  const annotations = value.version === 1 ? [] : Array.isArray(value.annotations) ? value.annotations.filter(validAnnotation) : [];
  if (strict && (!Array.isArray(value.annotations) || annotations.length !== value.annotations.length)) throw new Error('EPUB 标注包含无效数据');
  return {
    meta: {
      version: 2,
      id,
      cfi: typeof value.cfi === 'string' && value.cfi.length <= 8192 ? value.cfi : '',
      progress: Number.isFinite(value.progress) ? Math.min(1, Math.max(0, value.progress)) : 0,
      fontSize: Number.isFinite(value.fontSize) ? Math.min(180, Math.max(70, value.fontSize)) : 100,
      annotations,
    },
    warnings: value.version === 2 && Array.isArray(value.annotations) && annotations.length !== value.annotations.length ? ['部分无效 EPUB 标注已跳过'] : [],
  };
}

module.exports = { validAnnotation, normalizeEpubMeta };
