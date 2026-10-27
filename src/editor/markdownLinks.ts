import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

type MarkdownTree = ReturnType<typeof syntaxTree>;
type MarkdownNode = ReturnType<MarkdownTree['resolveInner']>;
const referenceCache = new WeakMap<MarkdownTree, { doc: EditorState['doc']; references: Set<string> }>();
const labelKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

// Lezer recognizes possible reference links even when no definition exists.
// Match the reader's resolution before hiding brackets or toggling a link.
export function isResolvedMarkdownLink(state: EditorState, tree: MarkdownTree, node: MarkdownNode) {
  const marks = node.getChildren('LinkMark');
  if (marks.some(mark => state.sliceDoc(mark.from, mark.to) === '(')) return true;
  const cached = referenceCache.get(tree);
  let references = cached?.doc === state.doc ? cached.references : undefined;
  if (!references) {
    references = new Set();
    tree.iterate({ enter(ref) {
      if (ref.name !== 'LinkReference') return;
      const label = ref.node.getChild('LinkLabel');
      if (label) references!.add(labelKey(state.sliceDoc(label.from + 1, label.to - 1)));
    } });
    referenceCache.set(tree, { doc: state.doc, references });
  }
  const first = marks[0], close = marks.find(mark => state.sliceDoc(mark.from, mark.to) === ']');
  if (!first || !close) return false;
  const label = node.getChild('LinkLabel');
  const explicit = label && state.sliceDoc(label.from + 1, label.to - 1);
  return references.has(labelKey(explicit || state.sliceDoc(first.to, close.from)));
}

// Return the destination associated with the same direct/reference syntax the
// reading view resolves, including collapsed and shortcut reference labels.
export function markdownLinkURL(state: EditorState, tree: MarkdownTree, node: MarkdownNode) {
  const direct = node.getChild('URL');
  if (direct) return state.sliceDoc(direct.from, direct.to);
  if (!isResolvedMarkdownLink(state, tree, node)) return undefined;
  const marks = node.getChildren('LinkMark'), first = marks[0], close = marks.find(mark => state.sliceDoc(mark.from, mark.to) === ']');
  if (!first || !close) return undefined;
  const explicit = node.getChild('LinkLabel'), explicitLabel = explicit && state.sliceDoc(explicit.from + 1, explicit.to - 1);
  const label = labelKey(explicitLabel || state.sliceDoc(first.to, close.from));
  let destination: string | undefined;
  tree.iterate({ enter(ref) {
    if (ref.name !== 'LinkReference') return;
    const candidate = ref.node.getChild('LinkLabel'), url = ref.node.getChild('URL');
    if (candidate && url && destination === undefined && labelKey(state.sliceDoc(candidate.from + 1, candidate.to - 1)) === label) destination = state.sliceDoc(url.from, url.to);
  } });
  return destination;
}
