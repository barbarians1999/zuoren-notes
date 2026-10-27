import { EditorState, countColumn } from '@codemirror/state';
import { ensureSyntaxTree, getIndentUnit, indentString, indentUnit, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { hasOrderedMarkerOnLines, renumberListsAfterIndent } from './markdownListNumbering';

function syntaxNodeAt(state: EditorState, position: number, lineEnd: number, name: string) {
  const tree = syntaxTreeAvailable(state, lineEnd) ? syntaxTree(state) : ensureSyntaxTree(state, lineEnd, 100);
  if (!tree) return null;
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(position, -1); node; node = node.parent) if (node.name === name) return node;
  return null;
}

function decreaseIndent(state: EditorState, value: string) {
  const columns = countColumn(value, state.tabSize), target = Math.max(0, columns - getIndentUnit(state));
  let current = 0;
  for (let index = 0; index <= value.length; index++) {
    if (current === target) return value.slice(0, index);
    if (index === value.length) break;
    const character = value[index];
    const next = character === '\t' ? current + state.tabSize - current % state.tabSize : current + 1;
    if (next > target) return indentString(state, target);
    current = next;
  }
  return indentString(state, target);
}

/** Handle Enter in fenced code while preserving source indentation and containers. */
export function keyHabitsEnter(view: EditorView) {
  const { state } = view, selection = state.selection.main;
  if (view.composing || state.readOnly || state.selection.ranges.length !== 1 || !selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  const fenced = syntaxNodeAt(state, selection.head, line.to, 'FencedCode');
  if (!fenced) return false;
  const codeText = fenced.getChildren('CodeText').find(node => node.from < line.to && node.to > line.from);
  if (!codeText) return false;
  const codeStart = Math.max(line.from, codeText.from);
  if (selection.head < codeStart || codeStart > line.to) return false;
  const containerPrefix = state.sliceDoc(line.from, codeStart);
  const source = state.sliceDoc(codeStart, line.to);
  const indentation = /^[\t ]*/.exec(source)![0];
  if (!source.slice(indentation.length)) {
    if (!indentation || selection.head !== line.to) return false;
    const reduced = decreaseIndent(state, indentation);
    const insert = containerPrefix + reduced;
    view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length }, scrollIntoView: true, userEvent: 'input' });
    return true;
  }
  if (selection.head < codeStart + indentation.length) return false;
  const insert = state.lineBreak + containerPrefix + indentation;
  view.dispatch({ changes: { from: selection.head, insert }, selection: { anchor: selection.head + insert.length }, scrollIntoView: true, userEvent: 'input' });
  return true;
}

/** Continue a list item on a source line aligned with its body, without a new marker. */
export function keyHabitsShiftEnter(view: EditorView) {
  const { state } = view, selection = state.selection.main;
  if (view.composing || state.readOnly || state.selection.ranges.length !== 1 || !selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  const tree = syntaxTreeAvailable(state, line.to) ? syntaxTree(state) : ensureSyntaxTree(state, line.to, 100);
  if (!tree) return false;
  let item: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(selection.head, -1);
  for (; item && item.name !== 'ListItem'; item = item.parent) {
    if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(item.name)) return false;
  }
  if (!item) return false;
  const marker = item.getChild('ListMark');
  if (!marker) return false;
  const markerLine = state.doc.lineAt(marker.from);
  const taskMarker = item.getChild('Task')?.getChild('TaskMarker');
  let bodyFrom = taskMarker?.to ?? marker.to;
  while (bodyFrom < markerLine.to && /[\t ]/.test(state.sliceDoc(bodyFrom, bodyFrom + 1))) bodyFrom++;
  if (selection.head < bodyFrom || selection.head > item.to) return false;
  const containerPrefix = state.sliceDoc(markerLine.from, marker.from);
  const listSeparatorEnd = marker.to + (/[\t ]/.test(state.sliceDoc(marker.to, marker.to + 1)) ? 1 : 0);
  const bodyColumn = countColumn(state.sliceDoc(markerLine.from, listSeparatorEnd), state.tabSize);
  const prefixColumn = countColumn(containerPrefix, state.tabSize);
  const continuation = containerPrefix + ' '.repeat(Math.max(0, bodyColumn - prefixColumn));
  const insert = state.lineBreak + continuation;
  view.dispatch({ changes: { from: selection.head, insert }, selection: { anchor: selection.head + insert.length }, scrollIntoView: true, userEvent: 'input' });
  return true;
}

/** Remove the current list marker when Backspace is exactly at nonempty body start. */
export function keyHabitsNonemptyListBackspace(view: EditorView, onError?: (message: string) => void, ensureTree: typeof ensureSyntaxTree = ensureSyntaxTree) {
  const { state } = view, selection = state.selection.main;
  if (view.composing || state.readOnly || state.selection.ranges.length !== 1 || !selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  const nextLine = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const parseEnd = nextLine?.to ?? line.to;
  const tree = syntaxTreeAvailable(state, parseEnd) ? syntaxTree(state) : ensureTree(state, parseEnd, 100);
  if (!tree) return false;
  let item: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(selection.head, -1);
  for (; item && item.name !== 'ListItem'; item = item.parent) {
    if (['FencedCode', 'CodeBlock'].includes(item.name)) return false;
  }
  if (!item) return false;
  const marker = item.getChild('ListMark');
  if (!marker || state.doc.lineAt(marker.from).number !== line.number || selection.head > item.to) return false;
  const taskMarker = item.getChild('Task')?.getChild('TaskMarker');
  const sourceEnd = taskMarker?.to ?? marker.to;
  let bodyStart = sourceEnd;
  while (bodyStart < line.to && /[\t ]/.test(state.sliceDoc(bodyStart, bodyStart + 1))) bodyStart++;
  if (selection.head !== bodyStart || bodyStart === line.to || !/\S/.test(state.sliceDoc(bodyStart, line.to))) return false;
  const separatorEnd = sourceEnd + 1;
  if (separatorEnd > bodyStart) return false;
  const hasOuterListItem = (() => {
    for (let node = item.parent; node; node = node.parent) if (node.name === 'ListItem') return true;
    return false;
  })();
  const originalPrefix = state.sliceDoc(line.from, marker.from);
  const quotePrefix = /^(?:[\t ]{0,3}>[\t ]?)+/.exec(line.text)?.[0] ?? '';
  const prefix = hasOuterListItem ? originalPrefix : quotePrefix;
  const extraWhitespace = state.sliceDoc(separatorEnd, bodyStart);
  let followingNonOneOrderedItem = false;
  if (nextLine?.text.startsWith(prefix)) {
    const nextBody = nextLine.text.slice(prefix.length), nextMarker = /^(\d{1,9})[.)][\t ]+/.exec(nextBody);
    followingNonOneOrderedItem = !!nextMarker && nextMarker[1] !== '1';
  }
  let insert = prefix + extraWhitespace;
  const changes = [{ from: line.from, to: bodyStart, insert }];
  if (followingNonOneOrderedItem && nextLine) changes.push({ from: line.to, insert: state.lineBreak + prefix, to: line.to });
  const trialChanges = state.changes(changes), trialState = state.update({ changes: trialChanges }).state;
  const trialPosition = trialChanges.mapPos(bodyStart, 1), trialLine = trialState.doc.lineAt(trialPosition);
  const trialTree = ensureTree(trialState, trialLine.to, 100);
  if (!trialTree) {
    onError?.('文档仍在解析，请稍后重试');
    return true;
  }
  let allowedListDepth = 0;
  for (let node = item.parent; node; node = node.parent) if (node.name === 'ListItem') allowedListDepth++;
  let resultingListDepth = 0;
  for (let node: ReturnType<typeof trialTree.resolveInner> | null = trialTree.resolveInner(trialPosition, -1); node; node = node.parent) {
    if (node.name === 'ListItem') resultingListDepth++;
  }
  if (resultingListDepth > allowedListDepth) {
    insert = prefix + state.lineBreak + prefix + extraWhitespace;
    changes[0] = { from: line.from, to: bodyStart, insert };
  }
  view.dispatch({
    changes,
    selection: { anchor: line.from + insert.length },
    scrollIntoView: true,
    userEvent: 'delete',
    annotations: isolateHistory.of('full'),
  });
  return true;
}

function selectedLineNumbers(state: EditorState) {
  if (state.selection.ranges.length !== 1) return null;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from);
  let last = state.doc.lineAt(range.to);
  if (!range.empty && range.to === last.from) last = state.doc.lineAt(range.to - 1);
  return Array.from({ length: last.number - first.number + 1 }, (_, index) => first.number + index);
}

function removeIndentUnit(state: EditorState, value: string) {
  const unit = getIndentUnit(state);
  let columns = 0;
  for (let index = 0; index < value.length; index++) {
    const next = value[index] === '\t' ? columns + state.tabSize - columns % state.tabSize : columns + 1;
    if (next === unit) return value.slice(index + 1);
    if (next > unit) return ' '.repeat(next - unit) + value.slice(index + 1);
    columns = next;
  }
  return '';
}

/** Tab / Shift-Tab indentation with related ordered-list numbering in one transaction. */
export function keyHabitsTab(direction: -1 | 1, onError?: (message: string) => void, ensureTree: typeof ensureSyntaxTree = ensureSyntaxTree) {
  return (view: EditorView) => {
    const { state } = view;
    if (view.composing || state.readOnly) return false;
    const lines = selectedLineNumbers(state);
    if (!lines) return false;
    const hasOrderedMarker = hasOrderedMarkerOnLines(state, lines, ensureTree);
    if (hasOrderedMarker === null) {
      onError?.('列表仍在解析，请稍后重试');
      return true;
    }
    const edits: { from: number; to?: number; insert: string }[] = [];
    for (const number of lines) {
      const line = state.doc.line(number);
      if (direction > 0) edits.push({ from: line.from, insert: state.facet(indentUnit) });
      else {
        const whitespace = /^[\t ]*/.exec(line.text)![0];
        if (!whitespace) continue;
        const remaining = removeIndentUnit(state, whitespace);
        edits.push({ from: line.from, to: line.from + whitespace.length, insert: remaining });
      }
    }
    if (!edits.length) return false;
    const indentationChanges = state.changes(edits);
    const indented = state.update({ changes: indentationChanges }).state;
    const numberingEdits = hasOrderedMarker ? renumberListsAfterIndent(state, indented, indentationChanges, lines, ensureTree) : [];
    if (numberingEdits === null) {
      onError?.('列表仍在解析，请稍后重试');
      return true;
    }
    const changes = numberingEdits.length
      ? indentationChanges.compose(indented.changes(numberingEdits))
      : indentationChanges;
    view.dispatch({
      changes,
      selection: state.selection.map(changes, 1),
      scrollIntoView: true,
      userEvent: direction > 0 ? 'input.indent' : 'delete.dedent',
      annotations: isolateHistory.of('full'),
    });
    return true;
  };
}
