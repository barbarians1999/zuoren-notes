import DOMPurify from 'dompurify';
import { Marked } from 'marked';

// Extend the default policy only for URLs issued by our checked asset IPC.
if (typeof window !== 'undefined') DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.nodeName === 'IMG' && data.attrName === 'src' && /^reader-asset:\/\/local\/[^\s]+$/i.test(data.attrValue)) data.forceKeepAttr = true;
});

const parser = new Marked({ gfm: true, breaks: true });
parser.use({ extensions: [{
  name: 'highlight', level: 'inline',
  start(source) { return source.indexOf('=='); },
  tokenizer(source) {
    const match = /^==([^=\n]+)==/.exec(source);
    if (match) return { type: 'highlight', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
  },
  renderer(token) { return '<mark>' + this.parser.parseInline(token.tokens || []) + '</mark>'; },
}] });

export function renderMarkdown(source: string): string {
  const html = parser.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed', 'style'],
    ADD_TAGS: ['input'], ADD_ATTR: ['checked', 'disabled'],
    // type is not a URL; restricting all attribute values with a URI regexp
    // strips type="checkbox". Keep DOMPurify's default URI policy.
    ADD_URI_SAFE_ATTR: ['type'],
  });
}
