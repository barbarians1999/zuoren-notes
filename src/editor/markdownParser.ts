import { Marked } from 'marked';
import { matchHighlight } from './markdownPolicy';

const parser = new Marked({ gfm: true, breaks: true });
parser.use({
  tokenizer: {
    // Obsidian uses double tildes. Marked also accepts a single tilde, unlike
    // the editor's GFM parser; keep literal ~text~ identical in both views.
    del(source) { return source.startsWith('~~') ? false : undefined; },
  },
  extensions: [{
    name: 'highlight', level: 'inline',
    start(source) { return source.indexOf('=='); },
    tokenizer(source) {
      const match = matchHighlight(source);
      if (match) return { type: 'highlight', raw: match.raw, tokens: this.lexer.inlineTokens(match.inner) };
    },
    renderer(token) { return '<mark>' + this.parser.parseInline(token.tokens || []) + '</mark>'; },
  }],
});

// Every DOM consumer must sanitize this HTML through renderMarkdown.
export function parseMarkdown(source: string): string {
  return parser.parse(source, { async: false }) as string;
}
