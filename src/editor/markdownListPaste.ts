import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { markdownSyntax } from './markdownLanguage';

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];
type PasteEdit = { from: number; to: number; insert: string };
type Target = {
  item: SyntaxNode; list: SyntaxNode; line: { from: number; to: number; number: number }; marker: SyntaxNode;
  markerText: string; afterMarker: string; taskMarker: SyntaxNode | null;
  quote: string; indentation: string; number: number;
};
type ClipboardShape =
  | { type: 'list'; state: EditorState; roots: SyntaxNode[]; items: SyntaxNode[][]; safe: boolean }
  | { type: 'plain' } | { type: 'other' };
type Insertion = { text: string; orderedNext: { number: number; delimiter: string } | null };
export type MarkdownListPaste = { changes: PasteEdit[]; cursor: number };

const listNames = new Set(['BulletList', 'OrderedList']);
const unsafeTargetNames = new Set(['CodeBlock', 'FencedCode', 'HTMLBlock', 'Table']);
const unsafeClipboardNames = new Set(['HTMLBlock']);
const plainTextNames = new Set(['Document', 'Paragraph', 'Text', 'SoftBreak', 'HardBreak', 'Escape', 'EscapeMark', 'Entity']);

function children(node: SyntaxNode) {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function columns(value: string) {
  let column = 0;
  for (const character of value) column = character === '\t' ? column + 4 - column % 4 : column + 1;
  return column;
}

function markerOf(item: SyntaxNode) { return item.getChild('ListMark'); }

function clipboardShape(source: string): ClipboardShape | null {
  const normalized = source.replace(/\r\n?|\n/g, '\n');
  const state = EditorState.create({ doc: normalized, extensions: [markdownSyntax()] });
  const tree = ensureSyntaxTree(state, state.doc.length, 120);
  if (!tree) return null;
  const roots = children(tree.topNode);
  if (roots.length > 0 && roots.every(node => listNames.has(node.name))) {
    const items = roots.map(root => children(root).filter(node => node.name === 'ListItem'));
    let safe = items.every(group => group.length > 0);
    tree.iterate({ enter(ref) { if (unsafeClipboardNames.has(ref.name)) safe = false; } });
    return { type: 'list', state, roots, items, safe };
  }
  if (roots.length && roots.every(node => node.name === 'Paragraph')) {
    let plain = true;
    tree.iterate({ enter(ref) { if (!plainTextNames.has(ref.name)) plain = false; } });
    if (plain) return { type: 'plain' };
  }
  return { type: 'other' };
}

function targetItem(state: EditorState): Target | null {
  const selection = state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return null;
  const line = state.doc.lineAt(selection.main.head), tree = ensureSyntaxTree(state, line.to, 120);
  if (!tree) return null;
  const candidates: SyntaxNode[] = [];
  tree.iterate({ from: line.from, to: line.to, enter(ref) {
    const node = ref.node;
    if (node.name !== 'ListItem') return;
    const marker = markerOf(node);
    if (marker && marker.from >= line.from && marker.from < line.to) candidates.push(node);
  } });
  const item = candidates.at(-1), marker = item && markerOf(item);
  if (!item || !marker) return null;
  const taskMarker = item.getChild('Task')?.getChild('TaskMarker');
  let bodyStart = taskMarker ? taskMarker.to : marker.to;
  while (bodyStart < line.to && /[\t ]/.test(state.sliceDoc(bodyStart, bodyStart + 1))) bodyStart++;
  if (selection.main.head < bodyStart || selection.main.head > line.to || /\S/.test(state.sliceDoc(bodyStart, line.to))) return null;
  const beforeMarker = state.sliceDoc(line.from, marker.from);
  const quote = /^(?:[\t ]{0,3}>[\t ]?)+/.exec(beforeMarker)?.[0] || '';
  if (beforeMarker.slice(quote.length).includes('>')) return null;
  const indentation = beforeMarker.slice(quote.length), list = item.parent;
  if (!list || !listNames.has(list.name)) return null;
  for (let parent: SyntaxNode | null = item.parent; parent; parent = parent.parent) if (unsafeTargetNames.has(parent.name)) return null;
  return {
    item, list, line, marker, markerText: state.sliceDoc(marker.from, marker.to),
    afterMarker: state.sliceDoc(marker.to, bodyStart), taskMarker: taskMarker ?? null, quote, indentation,
    number: Number(state.sliceDoc(marker.from, marker.to).match(/^\d+/)?.[0]),
  };
}

function stripColumns(leading: string, remove: number) {
  let column = 0, index = 0, overhang = 0;
  while (index < leading.length && column < remove) {
    const character = leading[index++];
    const next = character === '\t' ? column + 4 - column % 4 : column + 1;
    if (next > remove) overhang = next - remove;
    column = next;
  }
  return ' '.repeat(overhang) + leading.slice(index);
}

function shiftedIndent(line: string, sourceBase: number, targetIndent: string) {
  const leading = /^[\t ]*/.exec(line)![0];
  const relative = Math.max(0, columns(leading) - sourceBase);
  const sourceRemainder = stripColumns(leading, sourceBase);
  const remainder = columns(targetIndent + sourceRemainder) === columns(targetIndent) + relative
    ? sourceRemainder : ' '.repeat(relative);
  return targetIndent + remainder + line.slice(leading.length);
}

function plainItems(source: string, target: Target): Insertion | null {
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.length < 2) return null;
  const ordered = target.list.name === 'OrderedList' ? /^(\d+)([.)])$/.exec(target.markerText) : null;
  const uncheckedAfterMarker = target.taskMarker
    ? target.afterMarker.replace(/\[[ xX]\]/, '[ ]') : target.afterMarker;
  const text = lines.map((line, index) => {
    const marker = ordered ? `${Number(ordered[1]) + index}${ordered[2]}` : target.markerText;
    const afterMarker = index === 0 ? target.afterMarker : uncheckedAfterMarker;
    return target.quote + target.indentation + marker + afterMarker + line;
  }).join('\n');
  return { text, orderedNext: ordered ? { number: target.number + lines.length, delimiter: ordered[2] } : null };
}

function markdownItems(parsed: Extract<ClipboardShape, { type: 'list' }>, target: Target): Insertion | null {
  if (!parsed.safe) return null;
  const { state, roots, items } = parsed, firstMarker = markerOf(items[0][0]);
  if (!firstMarker) return null;
  const firstLine = state.doc.lineAt(firstMarker.from), sourceBase = columns(state.sliceDoc(firstLine.from, firstMarker.from));
  const targetStart = target.list.name === 'OrderedList' && roots[0].name === 'OrderedList' ? target.number : null;
  const overrides = new Map<number, { from: number; to: number; text: string }>();
  if (targetStart !== null && Number.isSafeInteger(targetStart)) items[0].forEach((rootItem, index) => {
      const marker = markerOf(rootItem);
      if (!marker) return;
      const value = state.sliceDoc(marker.from, marker.to), match = /^(\d+)([.)])$/.exec(value);
      if (!match) return;
      const line = state.doc.lineAt(marker.from);
      overrides.set(line.number - 1, { from: marker.from - line.from, to: marker.to - line.from, text: `${targetStart + index}${match[2]}` });
  });
  const text = state.doc.toString().split('\n').map((line, index) => {
    const override = overrides.get(index);
    const replaced = override ? line.slice(0, override.from) + override.text + line.slice(override.to) : line;
    return target.quote + shiftedIndent(replaced, sourceBase, target.indentation);
  }).join('\n');
  let orderedNext: Insertion['orderedNext'] = null;
  const lastRoot = roots.at(-1)!;
  if (target.list.name === 'OrderedList' && lastRoot.name === 'OrderedList' && /^\n?$/.test(state.sliceDoc(lastRoot.to))) {
    const lastItems = items.at(-1)!, firstLastMarker = markerOf(lastItems[0]);
    const markerText = firstLastMarker && state.sliceDoc(firstLastMarker.from, firstLastMarker.to);
    const match = markerText && /^(\d+)([.)])$/.exec(markerText);
    if (match) {
      const startsAtTarget = roots.length === 1 || roots[0].name === 'OrderedList' && lastRoot === roots[0];
      const start = startsAtTarget ? target.number : Number(match[1]);
      orderedNext = { number: start + lastItems.length, delimiter: match[2] };
    }
  }
  return { text, orderedNext };
}

export function markdownListPaste(state: EditorState, source: string): MarkdownListPaste | null {
  const target = targetItem(state);
  if (!target || !source) return null;
  const parsed = clipboardShape(source);
  if (!parsed) return null;
  const insertion = parsed.type === 'list' ? markdownItems(parsed, target)
    : parsed.type === 'plain' ? plainItems(source, target) : null;
  if (!insertion) return null;

  const changes: PasteEdit[] = [{ from: target.line.from, to: target.line.to, insert: insertion.text }];
  if (insertion.orderedNext && target.list.name === 'OrderedList') {
    const siblings = children(target.list).filter(node => node.name === 'ListItem');
    const index = siblings.findIndex(sibling => sibling.from === target.item.from);
    let previous = target.item;
    for (const sibling of siblings.slice(index + 1)) {
      const marker = markerOf(sibling);
      const previousEnd = state.doc.lineAt(Math.max(previous.from, previous.to - 1)).number;
      if (!marker || state.doc.lineAt(marker.from).number - previousEnd > 1) break;
      const oldMarker = state.sliceDoc(marker.from, marker.to), match = /^(\d+)([.)])$/.exec(oldMarker);
      if (!match || match[2] !== insertion.orderedNext.delimiter) break;
      changes.push({ from: marker.from, to: marker.to, insert: `${insertion.orderedNext.number++}${match[2]}` });
      previous = sibling;
    }
  }
  return { changes, cursor: target.line.from + insertion.text.length };
}
