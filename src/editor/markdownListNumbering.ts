import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { countColumn, type ChangeSet, type EditorState } from '@codemirror/state';
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

type OrderedItem = { item: SyntaxNode; mark: SyntaxNode; lists: SyntaxNode[] };
type EnsureTree = typeof ensureSyntaxTree;
type Edit = { from: number; to: number; insert: string };

const listMarkerCandidate = /^[\t ]*(?:>[\t ]*)*\d{1,9}[.)](?:[\t ]|$)/;

function ancestors(node: SyntaxNode | null, name: string) {
  const found: SyntaxNode[] = [];
  for (; node; node = node.parent) if (node.name === name) found.push(node);
  return found;
}

function orderedItemOnLine(state: EditorState, tree: NonNullable<ReturnType<typeof ensureSyntaxTree>>, lineNumber: number) {
  const line = state.doc.line(lineNumber);
  if (!listMarkerCandidate.test(line.text)) return null;
  const results: OrderedItem[] = [];
  tree.iterate({ from: line.from, to: line.to, enter(ref) {
    if (ref.name !== 'ListMark' || state.doc.lineAt(ref.from).number !== lineNumber) return;
    if (!/^\d{1,9}[.)]$/.test(state.sliceDoc(ref.from, ref.to))) return;
    let item: SyntaxNode | null = ref.node;
    for (; item && item.name !== 'ListItem'; item = item.parent) {}
    if (!item || item.parent?.name !== 'OrderedList') return;
    results.push({ item, mark: ref.node, lists: ancestors(item.parent, 'OrderedList') });
  } });
  return results[0] ?? null;
}

function directItems(list: SyntaxNode) {
  const items: SyntaxNode[] = [];
  for (let child = list.firstChild; child; child = child.nextSibling) if (child.name === 'ListItem') items.push(child);
  return items;
}

function itemMark(item: SyntaxNode | undefined) { return item?.getChild('ListMark') ?? null; }
function nodeKey(node: SyntaxNode) { return `${node.from}:${node.to}`; }

function ownerMark(list: SyntaxNode) {
  for (let node = list.parent; node; node = node.parent) if (node.name === 'ListItem') return itemMark(node);
  return null;
}

function sameOwner(beforeList: SyntaxNode, afterList: SyntaxNode, changes: ChangeSet) {
  const oldOwner = ownerMark(beforeList), newOwner = ownerMark(afterList);
  if (!oldOwner || !newOwner) return !oldOwner && !newOwner;
  return changes.mapPos(oldOwner.from, 1) === newOwner.from;
}

function mappedItem(state: EditorState, tree: NonNullable<ReturnType<typeof ensureSyntaxTree>>, mark: SyntaxNode, changes: ChangeSet) {
  const position = Math.min(state.doc.length, changes.mapPos(mark.from, 1));
  return orderedItemOnLine(state, tree, state.doc.lineAt(position).number);
}

function lineGap(state: EditorState, previous: SyntaxNode, next: SyntaxNode) {
  const previousLine = state.doc.lineAt(Math.max(previous.from, previous.to - 1)).number;
  return state.doc.lineAt(next.from).number - previousLine;
}

function groupAround(state: EditorState, list: SyntaxNode, item: SyntaxNode) {
  const items = directItems(list);
  const index = items.findIndex(candidate => itemMark(candidate)?.from === itemMark(item)?.from);
  if (index < 0) return [];
  let first = index, last = index;
  const connected = (previous: SyntaxNode, next: SyntaxNode) => {
    const gap = lineGap(state, previous, next);
    if (gap <= 1) return true;
    const left = itemMark(previous), right = itemMark(next);
    if (gap !== 2 || !left || !right) return false;
    const a = /^(\d+)([.)])$/.exec(state.sliceDoc(left.from, left.to));
    const b = /^(\d+)([.)])$/.exec(state.sliceDoc(right.from, right.to));
    return !!a && !!b && a[2] === b[2] && Number(b[1]) === Number(a[1]) + 1;
  };
  while (first > 0 && connected(items[first - 1], items[first])) first--;
  while (last + 1 < items.length && connected(items[last], items[last + 1])) last++;
  return items.slice(first, last + 1);
}

function directItemUnder(item: SyntaxNode, list: SyntaxNode) {
  let child = item;
  while (child.parent && child.parent !== list) child = child.parent;
  return child.parent === list ? child : null;
}

function firstNumber(state: EditorState, items: readonly SyntaxNode[]) {
  const mark = items.map(itemMark).find(Boolean);
  return Number(/^\d+/.exec(mark ? state.sliceDoc(mark.from, mark.to) : '')?.[0] ?? 1);
}

export function hasOrderedMarkerOnLines(state: EditorState, lines: readonly number[], ensureTree: EnsureTree = ensureSyntaxTree) {
  if (!lines.some(number => listMarkerCandidate.test(state.doc.line(number).text))) return false;
  const end = Math.max(...lines.map(number => state.doc.line(number).to));
  const tree = syntaxTreeAvailable(state, end) ? syntaxTree(state) : ensureTree(state, end, 100);
  if (!tree) return null;
  return lines.some(number => orderedItemOnLine(state, tree, number) !== null);
}

/** Renumber only the affected same-level groups around moved ordered-list markers. */
export function renumberListsAfterIndent(before: EditorState, after: EditorState, changes: ChangeSet, changedLines: readonly number[], ensureTree: EnsureTree = ensureSyntaxTree): Edit[] | null {
  const beforeTree = ensureTree(before, before.doc.length, 100);
  const afterTree = ensureTree(after, after.doc.length, 100);
  if (!beforeTree || !afterTree) return null;

  const moved: { before: OrderedItem; after: OrderedItem }[] = [];
  const protectedMarks = new Set<number>();
  const selectedLines = new Set(changedLines);
  for (const number of changedLines) {
    const oldItem = orderedItemOnLine(before, beforeTree, number);
    if (!oldItem) continue;
    const newItem = mappedItem(after, afterTree, oldItem.mark, changes);
    if (!newItem) continue;
    moved.push({ before: oldItem, after: newItem });
    beforeTree.iterate({ from: oldItem.item.from, to: oldItem.item.to, enter(ref) {
      if (ref.name === 'ListMark' && !selectedLines.has(before.doc.lineAt(ref.from).number)) protectedMarks.add(changes.mapPos(ref.from, 1));
    } });
  }
  if (!moved.length) return [];

  const related = new Map<string, SyntaxNode>();
  const eligible = new Map<string, Set<number>>();
  const starts = new Map<string, { value: number; priority: number }>();
  const addStart = (list: SyntaxNode, value: number, priority: number) => {
    const key = nodeKey(list), current = starts.get(key);
    if (!current || current.priority < priority) starts.set(key, { value, priority });
  };
  const addEligible = (list: SyntaxNode, position: number) => {
    const key = nodeKey(list);
    related.set(key, list);
    const positions = eligible.get(key) ?? new Set<number>();
    positions.add(position);
    eligible.set(key, positions);
  };

  for (const { before: oldItem, after: newItem } of moved) {
    const newListKeys = new Set(newItem.lists.map(nodeKey));
    const oldNearest = oldItem.lists[0], newNearest = newItem.lists[0];
    const oldFirstMark = itemMark(directItems(oldNearest)[0]);
    const mappedFirst = oldFirstMark && mappedItem(after, afterTree, oldFirstMark, changes);
    const oldLine = before.doc.lineAt(oldItem.mark.from), newLine = after.doc.lineAt(newItem.mark.from);
    const markerIndentUnchanged = countColumn(before.sliceDoc(oldLine.from, oldItem.mark.from), before.tabSize) ===
      countColumn(after.sliceDoc(newLine.from, newItem.mark.from), after.tabSize);
    if (mappedFirst?.lists[0] && nodeKey(mappedFirst.lists[0]) === nodeKey(newNearest) && sameOwner(oldNearest, newNearest, changes) && markerIndentUnchanged) continue;

    for (const list of newItem.lists) related.set(nodeKey(list), list);
    for (const oldList of oldItem.lists) {
      const host = directItemUnder(oldItem.item, oldList);
      if (!host) continue;
      const group = groupAround(before, oldList, host), groupStart = firstNumber(before, group), firstSourceMark = itemMark(group[0]);
      const targetGroups = new Map<string, { list: SyntaxNode; positions: Set<number> }>();
      for (const sourceItem of group) {
        const sourceMark = itemMark(sourceItem);
        if (!sourceMark) continue;
        const mapped = mappedItem(after, afterTree, sourceMark, changes);
        if (!mapped) continue;
        for (const target of mapped.lists) {
          const key = nodeKey(target), positions = targetGroups.get(key)?.positions ?? new Set<number>();
          positions.add(mapped.mark.from);
          targetGroups.set(key, { list: target, positions });
        }
      }
      for (const { list: target, positions } of targetGroups.values()) {
        const key = nodeKey(target), mappedFirstMark = firstSourceMark && mappedItem(after, afterTree, firstSourceMark, changes)?.mark;
        const targetFirst = itemMark(directItems(target)[0]);
        const oldFirstLine = firstSourceMark && before.doc.lineAt(firstSourceMark.from);
        const newFirstLine = mappedFirstMark && after.doc.lineAt(mappedFirstMark.from);
        const sameIndent = !!oldFirstLine && !!newFirstLine &&
          countColumn(before.sliceDoc(oldFirstLine.from, firstSourceMark.from), before.tabSize) ===
          countColumn(after.sliceDoc(newFirstLine.from, mappedFirstMark.from), after.tabSize);
        const originalStartRemainsFirst = !!mappedFirstMark && mappedFirstMark.from === targetFirst?.from && sameOwner(oldList, target, changes) && sameIndent;
        addStart(target, newListKeys.has(key) && !originalStartRemainsFirst ? 1 : groupStart, originalStartRemainsFirst ? 2 : 1);
        for (const position of positions) addEligible(target, position);
      }
    }
    // When a nested item moves to an outer list, include its new marker among
    // the target siblings while keeping its old descendants protected.
    for (const list of newItem.lists) addEligible(list, newItem.mark.from);
  }

  const edits = new Map<string, Edit>();
  for (const [key, list] of related) {
    const positions = eligible.get(key);
    if (!positions) continue;
    const start = starts.get(key)?.value ?? 1;
    const indexByMark = new Map<number, number>();
    let index = 0;
    for (const item of directItems(list)) {
      const mark = itemMark(item);
      if (mark && positions.has(mark.from)) indexByMark.set(mark.from, index++);
    }
    for (const item of directItems(list)) {
      const mark = itemMark(item);
      if (!mark || protectedMarks.has(mark.from)) continue;
      const itemIndex = indexByMark.get(mark.from);
      if (itemIndex === undefined) continue;
      const current = /^(\d+)([.)])$/.exec(after.sliceDoc(mark.from, mark.to));
      if (!current) continue;
      const number = String(start + itemIndex);
      if (current[1] !== number) edits.set(`${mark.from}:${mark.from + current[1].length}`, { from: mark.from, to: mark.from + current[1].length, insert: number });
    }
  }
  return [...edits.values()];
}
