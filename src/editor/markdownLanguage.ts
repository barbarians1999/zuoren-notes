import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

// A delimiter parser lets the Markdown parser own escaping, nesting and code
// boundaries; the view never searches raw lines for formatting punctuation.
const highlightDelimiter = { resolve: 'Highlight', mark: 'HighlightMark' };
export function markdownSyntax() {
  return markdown({
    base: markdownLanguage,
    extensions: {
      defineNodes: ['Highlight', 'HighlightMark'],
      parseInline: [{
        name: 'Highlight',
        parse(cx, next, pos) {
          if (next !== 61 || cx.char(pos + 1) !== 61) return -1;
          return cx.addDelimiter(highlightDelimiter, pos, pos + 2, true, true);
        },
      }],
    },
  });
}

