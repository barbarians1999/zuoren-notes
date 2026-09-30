const HASH = /^[a-f0-9]{64}$/i;
const CFI = /^epubcfi\(.+\)$/;

function isEpubAnchor(anchor) {
  return !!anchor && typeof anchor === 'object' && HASH.test(anchor.epubId) && CFI.test(anchor.cfiRange);
}

function isPdfAnchor(value) {
  return !!value && typeof value === 'object' && HASH.test(value.pdfId) && Number.isInteger(value.page) && value.page > 0 && Array.isArray(value.rects) && [0, 90, 180, 270].includes(value.rotation);
}

function encodeReaderAnchor(anchor) {
  if (!(isEpubAnchor(anchor) || isPdfAnchor(anchor))) throw new Error('无效的原文锚点');
  const bytes = new TextEncoder().encode(JSON.stringify(anchor));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeReaderAnchor(href) {
  const prefix = '#reader-anchor-';
  if (typeof href !== 'string' || !href.startsWith(prefix)) return null;
  try {
    const token = href.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(token + '='.repeat((4 - token.length % 4) % 4));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (isEpubAnchor(value) || isPdfAnchor(value)) return value;
    return null;
  } catch { return null; }
}

function formatEpubAnchor(anchor, bookName) {
  return [bookName, typeof anchor.chapterLabel === 'string' ? anchor.chapterLabel.trim() : ''].filter(Boolean).join(' · ');
}

module.exports = { isEpubAnchor, encodeReaderAnchor, decodeReaderAnchor, formatEpubAnchor };
