import { EditorView } from '@codemirror/view';
import { insertNewlineContinueMarkupCommand, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { isResolvedMarkdownLink } from './markdownLinks';
import { projectedHeadingLabel } from './markdownProjection';
import { markdownSyntax } from './markdownLanguage';
export type MarkdownInlineFormat = 'bold' | 'italic' | 'code' | 'highlight' | 'strike' | 'link';
export type MarkdownBlockFormat = 'heading' | 'quote' | 'bullet' | 'ordered' | 'task' | 'table';

// Empty list items exit one level immediately instead of becoming a loose list.
export const continueMarkdown = insertNewlineContinueMarkupCommand({ nonTightLists: false });

export function exitEmptyIndent(view: EditorView) {
  const { state } = view, selection = state.selection.main;
  if (state.selection.ranges.length !== 1 || !selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to || !/^[\t ]+$/.test(line.text) ||
    !markdownLanguage.isActiveAt(state, selection.head, -1)) return false;
  // A leading Tab is parsed as indented code even for ordinary prose. On an
  // empty line, Enter exits that indentation instead of copying it indefinitely.
  // Fenced code and nested Markdown containers retain their own Enter behavior.
  const tree = ensureSyntaxTree(state, line.to, 100);
  if (!tree) return false;
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(selection.head, -1); node; node = node.parent) {
    if (['FencedCode', 'ListItem', 'Blockquote', 'HTMLBlock'].includes(node.name)) return false;
  }
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: state.lineBreak },
    selection: { anchor: line.from + 1 },
    scrollIntoView: true,
    userEvent: 'input'
  });
  return true;
}

export function exitEmptyBlockquote(view: EditorView) {
  const { state } = view, selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false;
  const match = /^(\s*)(?:>\s*)+$/.exec(line.text);
  if (!match || !markdownLanguage.isActiveAt(state, selection.head, -1)) return false;
  const tree = ensureSyntaxTree(state, line.to, 100);
  if (!tree) return false;
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(selection.head, -1);
  for (; node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false;
    if (node.name === 'Blockquote') {
      // Keep outer quote levels and their whitespace; exit only the innermost.
      const from = line.from + line.text.lastIndexOf('>');
      view.dispatch({
        changes: { from, to: line.to, insert: '' },
        selection: { anchor: from },
        userEvent: 'input'
      });
      return true;
    }
  }
  return false;
}

export function formatSourceSelection(view: EditorView, format: MarkdownInlineFormat) {
  const { state } = view;
  const range = state.selection.main;
  const { from, to } = range;
  const selected = view.state.sliceDoc(from, to);
  const wrapper = { bold: '**', italic: '*', code: '`', highlight: '==', strike: '~~', link: '' }[format];
  const nodeName = { bold: 'StrongEmphasis', italic: 'Emphasis', code: 'InlineCode', highlight: 'Highlight', strike: 'Strikethrough', link: 'Link' }[format];
  // Ask the parser, not a delimiter search: literal stars in code/escaped text
  // and nested bold/italic must not be mistaken for the requested style.
  const tree = ensureSyntaxTree(state, to + (to < state.doc.length ? 1 : 0), 100) || syntaxTree(state);
  if (format !== 'code') {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(from, 1); node; node = node.parent) {
      if (['InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name) && to <= node.to) { view.focus(); return true; }
    }
  }
  const matching: ReturnType<typeof tree.resolveInner>[] = [];
  tree.iterate({ from, to, enter(node) {
    if (node.name === nodeName && (format !== 'link' || isResolvedMarkdownLink(state, tree, node.node)) && node.from <= from && node.to >= to &&
      (!range.empty || from > node.from && from < node.to)) matching.push(node.node);
  } });
  const active = matching.at(-1);
  let remove: { from: number; to: number; insert: string }[] | undefined;
  if (active) {
    const first = active.firstChild, last = active.lastChild;
    if (first && last) {
      if (format === 'link') {
        const close = active.getChildren('LinkMark').find(mark => state.sliceDoc(mark.from, mark.to) === ']');
        if (close) remove = [{ from: active.from, to: first.to, insert: '' }, { from: close.from, to: active.to, insert: '' }];
      } else {
        let start = first.to, end = last.from;
        // CommonMark inline-code padding is syntax, not part of the value.
        const body = state.sliceDoc(start, end);
        if (format === 'code' && body.startsWith(' ') && body.endsWith(' ') && /\S/.test(body)) { start++; end--; }
        remove = [{ from: active.from, to: start, insert: '' }, { from: end, to: active.to, insert: '' }];
      }
    }
  }
  // Empty placeholders (**** / ** / ==== / ~~~~ / ``) are not syntax nodes.
  // Also support text-only callers without a Markdown language extension.
  const outside = wrapper && from >= wrapper.length && state.sliceDoc(from - wrapper.length, from) === wrapper && state.sliceDoc(to, to + wrapper.length) === wrapper;
  const exactRun = wrapper && (wrapper !== '*' || state.sliceDoc(Math.max(0, from - 2), from - 1) !== '*' && state.sliceDoc(to + 1, to + 2) !== '*');
  if (!remove && outside && exactRun && (range.empty || tree.topNode.name !== 'Document')) remove = [{ from: from - wrapper.length, to: from, insert: '' }, { from: to, to: to + wrapper.length, insert: '' }];
  if (remove) {
    const changes = state.changes(remove);
    view.dispatch({ changes, selection: { anchor: changes.mapPos(range.anchor), head: changes.mapPos(range.head) }, userEvent: 'input.format' });
  } else {
    let before = wrapper || '[', after = wrapper || '](https://)';
    if (format === 'code') {
      const longest = Math.max(0, ...Array.from(selected.matchAll(/`+/g), match => match[0].length));
      before = after = '`'.repeat(longest + 1);
      if (/^`|`$/.test(selected) || /^ .* $/.test(selected) && /\S/.test(selected)) { before += ' '; after = ' ' + after; }
    }
    view.dispatch({ changes: { from, to, insert: before + selected + after }, selection: {
      anchor: (range.anchor === from ? from : to) + before.length,
      head: (range.head === to ? to : from) + before.length,
    }, userEvent: 'input.format' });
  }
  view.focus(); return true;
}

export function formatSourceBlock(view: EditorView, format: MarkdownBlockFormat) {
  const selection = view.state.selection.main;
  const first = view.state.doc.lineAt(selection.from), last = view.state.doc.lineAt(selection.to > selection.from && view.state.doc.lineAt(selection.to).from === selection.to ? selection.to - 1 : selection.to);
  if (format === 'table') {
    const table = '| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n';
    const insert = (first.text ? '\n\n' : '') + table;
    view.dispatch({ changes: { from: first.text ? last.to : first.from, insert }, userEvent: 'input.format', scrollIntoView: true }); view.focus(); return true;
  }
  const selected = view.state.sliceDoc(first.from, last.to);
  const prefix = { heading: '## ', quote: '> ', bullet: '- ', ordered: '1. ', task: '- [ ] ' }[format];
  const lines = selected.split('\n');
  const currentMarker = { heading: /^##\s+/, quote: /^>\s+/, bullet: /^[-*+]\s+(?!\[[ xX]\])/, ordered: /^\d+[.)]\s+/, task: /^[-*+]\s+\[[ xX]\]\s+/ }[format];
  const remove = lines.every(line => currentMarker.test(line.trimStart()));
  const replacement = lines.map((line, index) => {
    const indent = line.match(/^\s*/)?.[0] || '';
    const body = line.slice(indent.length);
    return indent + (remove ? body.replace(currentMarker, '') : (format === 'ordered' ? (index + 1) + '. ' : prefix) + body.replace(/^(?:#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ''));
  }).join('\n');
  view.dispatch({ changes: { from: first.from, to: last.to, insert: replacement }, selection: { anchor: first.from, head: first.from + replacement.length }, userEvent: 'input.format' });
  view.focus(); return true;
}

const outlineParser = markdownSyntax().language.parser;
const outlineCache = new WeakMap<EditorView['state']['doc'], { text: string; level: number; line: number; previewAt: number }[]>();
export function markdownOutline(view: EditorView) {
  const cached = outlineCache.get(view.state.doc);
  if (cached) return cached;
  const headings: { text: string; level: number; line: number; previewAt: number }[] = [];
  // The same complete index supplies labels in editing and reading modes.
  // Cache by immutable document, not selection or mode; a partial parse must
  // not remove headings merely because the editor is hidden behind preview.
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 100) || outlineParser.parse(view.state.doc.toString());
  tree.iterate({ enter(node) {
    if (!/^(ATX|Setext)Heading/.test(node.name)) return;
    let previewAt = node.name.startsWith('ATX') ? node.node.getChild('HeaderMark')!.to : node.from;
    while (previewAt < node.to && /[\t ]/.test(view.state.sliceDoc(previewAt, previewAt + 1))) previewAt++;
    headings.push({ text: projectedHeadingLabel(view.state, node.node, tree), level: Number(node.name.slice(-1)), line: view.state.doc.lineAt(node.from).number - 1, previewAt });
  } });
  outlineCache.set(view.state.doc, headings);
  return headings;
}
