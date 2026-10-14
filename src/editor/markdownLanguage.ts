import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { matchHighlight } from './markdownPolicy';

// The shared policy chooses highlight boundaries; the Markdown parser still
// owns nested inline content and code/escape contexts. Decorations use nodes.
export function markdownSyntax() {
  return markdown({
    base: markdownLanguage,
    extensions: {
      remove: ['Subscript', 'Superscript', 'Emoji'],
      defineNodes: ['Highlight', 'HighlightMark'],
      parseInline: [{
        name: 'Highlight',
        parse(cx, next, pos) {
          if (next !== 61 || cx.char(pos + 1) !== 61) return -1;
          const match = matchHighlight(cx.slice(pos, cx.end));
          if (!match) return -1;
          const to = pos + match.raw.length;
          return cx.addElement(cx.elt('Highlight', pos, to, [cx.elt('HighlightMark', pos, pos + 2),
            ...cx.parser.parseInline(match.inner, pos + 2), cx.elt('HighlightMark', to - 2, to)]));
        },
      }],
    },
  });
}

