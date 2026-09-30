import { EditorView } from '@codemirror/view';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
export type MarkdownInlineFormat = 'bold' | 'italic' | 'code' | 'highlight' | 'strike' | 'link';
export type MarkdownBlockFormat = 'heading' | 'quote' | 'bullet' | 'ordered' | 'task' | 'table';

export function exitEmptyBlockquote(view: EditorView) {
  const { state } = view, selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false;
  const match = /^(\s*)(?:>\s*)+$/.exec(line.text);
  if (!match || !markdownLanguage.isActiveAt(state, selection.head, -1)) return false;
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(selection.head, -1);
  for (; node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false;
    if (node.name === 'Blockquote') {
      const from = line.from + match[1].length;
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
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const wrapper = { bold: '**', italic: '*', code: '`', highlight: '==', strike: '~~', link: '' }[format];
  const outside = wrapper && from >= wrapper.length && view.state.sliceDoc(from - wrapper.length, from) === wrapper && view.state.sliceDoc(to, to + wrapper.length) === wrapper;
  if (outside) view.dispatch({ changes: [{ from: from - wrapper.length, to: from, insert: '' }, { from: to, to: to + wrapper.length, insert: '' }], selection: { anchor: from - wrapper.length, head: to - wrapper.length }, userEvent: 'input.format' });
  else {
    const replacement = wrapper ? wrapper + selected + wrapper : '[' + selected + '](https://)';
    view.dispatch({ changes: { from, to, insert: replacement }, selection: { anchor: from + (wrapper.length || 1), head: to + (wrapper.length || 1) }, userEvent: 'input.format' });
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

export function markdownOutline(view: EditorView) {
  const headings: { text: string; level: number; line: number }[] = [];
  syntaxTree(view.state).iterate({ enter(node) {
    if (/^(ATX|Setext)Heading/.test(node.name)) headings.push({ text: view.state.sliceDoc(node.from, node.to).replace(/^#{1,6}\s+/, '').replace(/\n.*$/, ''), level: Number(node.name.slice(-1)), line: view.state.doc.lineAt(node.from).number - 1 });
  } }); return headings;
}
