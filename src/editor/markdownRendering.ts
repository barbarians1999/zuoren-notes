import DOMPurify from 'dompurify';
import { parseMarkdown } from './markdownParser';

// Extend the default policy only for URLs issued by our checked asset IPC.
if (typeof window !== 'undefined') DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.nodeName === 'IMG' && data.attrName === 'src' && /^reader-asset:\/\/local\/[^\s]+$/i.test(data.attrValue)) data.forceKeepAttr = true;
});

export function renderMarkdown(source: string): string {
  const html = parseMarkdown(source);
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed', 'style'],
    ADD_TAGS: ['input'], ADD_ATTR: ['checked', 'disabled'],
    // type is not a URL; restricting all attribute values with a URI regexp
    // strips type="checkbox". Keep DOMPurify's default URI policy.
    ADD_URI_SAFE_ATTR: ['type'],
  });
}
