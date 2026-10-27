import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { projectTable } from './markdownProjection';

function tableAt(view: EditorView) {
  const { state } = view, selection = state.selection.main, head = selection.head;
  if (view.composing || state.readOnly || state.selection.ranges.length !== 1) return null;
  const findTable = (tree: ReturnType<typeof syntaxTree>, assoc: -1 | 1 = 1) => {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(head, assoc); node; node = node.parent) {
      if (node.name === 'Table') return node;
      if (['FencedCode', 'CodeBlock'].includes(node.name)) return null;
    }
    return null;
  };
  let tree: ReturnType<typeof syntaxTree> | null = syntaxTree(state);
  let node = findTable(tree);
  let trailingBoundary = false;
  if (!node) { node = findTable(tree, -1); trailingBoundary = !!node; }
  if (!node && !syntaxTreeAvailable(state, head)) {
    tree = ensureSyntaxTree(state, head, 100);
    if (!tree) return null;
    node = findTable(tree);
    if (!node) { node = findTable(tree, -1); trailingBoundary = !!node; }
  }
  if (!node) return null;
  tree = ensureSyntaxTree(state, state.doc.length, 100);
  if (!tree) return null;
  node = findTable(tree) ?? (trailingBoundary ? findTable(tree, -1) : null);
  if (!node) return null;
  const projection = projectTable(state, node, tree);
  let selectedCell: (typeof projection.cells)[number] | undefined;
  if (!selection.empty) {
    const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
    selectedCell = projection.cells.find(cell => from >= cell.from && to <= cell.to && to > from);
    // Projection cell bounds exclude padding and source delimiters. If a
    // selection crosses either boundary, leave it to the normal indent keymap.
    if (!selectedCell) return null;
  }
  if (trailingBoundary) {
    const lastCell = projection.cells.at(-1);
    if (!lastCell || state.doc.lineAt(head).number !== state.doc.lineAt(lastCell.to).number || head < lastCell.to) return null;
  }
  return { state, node, projection, selectedCell };
}

function currentCell(table: NonNullable<ReturnType<typeof tableAt>>, head: number) {
  const line = table.state.doc.lineAt(head);
  const row = table.projection.cells.filter(cell => table.state.doc.lineAt(cell.from).number === line.number);
  if (!row.length) return null;
  return row.find(cell => head >= cell.from && head <= cell.to)
    ?? row.reduce((best, cell) => Math.abs(cell.from - head) < Math.abs(best.from - head) ? cell : best);
}

function move(view: EditorView, direction: -1 | 1) {
  const table = tableAt(view);
  if (!table) return false;
  const cells = table.projection.cells;
  let active = table.selectedCell ?? currentCell(table, view.state.selection.main.head);
  if (!active) {
    const separator = table.node.getChild('TableDelimiter');
    if (!separator || view.state.doc.lineAt(separator.from).number !== view.state.doc.lineAt(view.state.selection.main.head).number || !cells.length) return false;
    if (direction < 0) active = cells.filter(cell => cell.row === 0).at(-1) ?? null;
    else active = cells.filter(cell => cell.row > 0)[0] ?? cells.filter(cell => cell.row === 0).at(-1) ?? null;
    if (!active) return false;
    if (direction < 0 || cells.some(cell => cell.row > 0)) {
      const target = direction < 0 ? cells.find(cell => cell.row === active!.row && cell.column === active!.column) : cells.find(cell => cell.row === 1 && cell.column === 0);
      if (target) { view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true, userEvent: 'select' }); return true; }
      return false;
    }
  }
  const index = cells.findIndex(cell => cell.row === active.row && cell.column === active.column);
  const target = cells[index + direction];
  if (target) {
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true, userEvent: 'select' });
    return true;
  }
  if (direction < 0) return true;
  const rowNodes = [];
  for (let child = table.node.firstChild; child; child = child.nextSibling) if (['TableHeader', 'TableRow'].includes(child.name)) rowNodes.push(child);
  const bodyCell = cells.filter(cell => cell.row > 0).at(-1);
  const prefixNode = bodyCell ? rowNodes[bodyCell.row] : rowNodes[0];
  const prefixLine = table.state.doc.lineAt(prefixNode.from);
  const rowPrefix = table.state.sliceDoc(prefixLine.from, prefixNode.from);
  const listHeader = /^((?:[\t ]{0,3}>[\t ]?)*)((?:[\t ]*))([-+*]|\d+[.)])([\t ]+)$/.exec(rowPrefix);
  const prefix = bodyCell ? rowPrefix : listHeader
    ? listHeader[1] + listHeader[2] + ' '.repeat(listHeader[3].length + listHeader[4].length)
    : rowPrefix;
  const cellsInRow = cells.filter(cell => cell.row === active.row).length || 1;
  const row = prefix + '| ' + Array(cellsInRow).fill('').join(' | ') + ' |';
  const insert = (table.projection.to > 0 && table.state.sliceDoc(table.projection.to - 1, table.projection.to) !== '\n' ? table.state.lineBreak : '') + row;
  const from = table.projection.to;
  view.dispatch({ changes: { from, insert }, selection: { anchor: from + insert.length - row.length + prefix.length + 2 }, scrollIntoView: true, userEvent: 'input', annotations: isolateHistory.of('full') });
  return true;
}

export const tableNextCell = (view: EditorView) => move(view, 1);
export const tablePreviousCell = (view: EditorView) => move(view, -1);
