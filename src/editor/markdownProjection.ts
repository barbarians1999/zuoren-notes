import { countColumn, type EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { decodeHTMLStrict } from 'entities';
import { isResolvedMarkdownLink } from './markdownLinks';

type MarkdownTree = ReturnType<typeof syntaxTree>;
export type MarkdownNode = ReturnType<MarkdownTree['resolveInner']>;
type Segment = { displayFrom: number; displayTo: number; sourceFrom: number; sourceTo: number };
export type TextProjection = { text: string; segments: Segment[]; anchor: number };
export type BlockContext = { quoteDepth: number; indentColumns: number; markers: { column: number; label: string; source: number }[] };
export type BlockProjection = { from: number; to: number; content: TextProjection; context: BlockContext };
export type CodeProjection = BlockProjection & { language: string };
export type TableCellProjection = TextProjection & { from: number; to: number; row: number; column: number };
export type TableProjection = BlockProjection & { cells: TableCellProjection[]; references: string };

class ProjectionBuilder {
  text = '';
  segments: Segment[] = [];
  append(value: string, sourceFrom: number, sourceTo: number) {
    if (!value) return;
    this.segments.push({ displayFrom: this.text.length, displayTo: this.text.length + value.length, sourceFrom, sourceTo });
    this.text += value;
  }
  copy(state: EditorState, from: number, to: number) { if (to > from) this.append(state.sliceDoc(from, to), from, to); }
  finish(anchor: number): TextProjection { return { text: this.text, segments: this.segments, anchor }; }
}

// Positions use the same UTF-16 offsets as CodeMirror and DOM Range. Removed
// container prefixes are gaps, not characters to add to a single starting offset.
export function projectedSourcePosition(projection: TextProjection, offset: number, association: -1 | 1 = 1) {
  const position = Math.max(0, Math.min(projection.text.length, offset));
  for (let index = 0; index < projection.segments.length; index++) {
    const part = projection.segments[index];
    if (position < part.displayTo || position === part.displayTo && (association < 0 || index === projection.segments.length - 1)) {
      const inside = Math.max(0, position - part.displayFrom);
      if (part.displayTo - part.displayFrom === part.sourceTo - part.sourceFrom) return part.sourceFrom + inside;
      return inside === 0 || association < 0 ? part.sourceFrom : part.sourceTo;
    }
  }
  return projection.segments.at(-1)?.sourceTo ?? projection.anchor;
}

export const decodeMarkdownEntity = (source: string) => decodeHTMLStrict(source);

// Only parsed syntax is omitted. Literal stars, unresolved brackets and code
// contents remain text; decoding never writes back into the document.
export function projectInlineText(state: EditorState, node: MarkdownNode, tree: MarkdownTree = syntaxTree(state)): TextProjection {
  const result = new ProjectionBuilder();
  const copy = (from: number, to: number) => result.copy(state, from, to);
  const children = (parent: MarkdownNode, from = parent.from, to = parent.to) => {
    let position = from;
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.to <= from || child.from >= to) continue;
      copy(position, Math.max(position, child.from));
      visit(child);
      position = Math.max(position, child.to);
    }
    copy(position, to);
  };
  const visit = (item: MarkdownNode) => {
    if (/^(HeaderMark|EmphasisMark|StrikethroughMark|HighlightMark|QuoteMark|HTMLTag)$/.test(item.name)) return;
    if (item.name === 'Escape') { copy(item.from + 1, item.to); return; }
    if (item.name === 'Entity') { result.append(decodeMarkdownEntity(state.sliceDoc(item.from, item.to)), item.from, item.to); return; }
    if (item.name === 'InlineCode') {
      const marks = item.getChildren('CodeMark');
      const from = marks[0]?.to ?? item.from, to = marks.at(-1)?.from ?? item.to;
      const raw = state.sliceDoc(from, to), pieces: { value: string; from: number; to: number }[] = [];
      const list = (() => { for (let parent = item.parent; parent; parent = parent.parent) if (parent.name === 'ListItem') return parent; return null; })();
      let listIndent = 0;
      if (list) {
        const marker = list.getChild('ListMark');
        if (marker) {
          const line = state.doc.lineAt(marker.from); let end = marker.to;
          while (end < line.to && /[\t ]/.test(state.sliceDoc(end, end + 1))) end++;
          listIndent = countColumn(state.sliceDoc(line.from, end).replace(/>[\t ]?/g, ''), state.tabSize);
        }
      }
      const quoteMarks = item.getChildren('QuoteMark').sort((left, right) => left.from - right.from);
      const append = (value: string, sourceFrom: number, sourceTo: number) => {
        if (!value) return;
        const previous = pieces.at(-1);
        if (previous && previous.to === sourceFrom && previous.to - previous.from === previous.value.length && sourceTo - sourceFrom === value.length) {
          previous.value += value; previous.to = sourceTo;
        } else pieces.push({ value, from: sourceFrom, to: sourceTo });
      };
      const skipListIndent = (offset: number) => {
        let columns = 0;
        while (offset < raw.length && /[\t ]/.test(raw[offset]) && columns < listIndent) {
          const width = raw[offset] === '\t' ? state.tabSize - columns % state.tabSize : 1;
          offset++;
          if (columns + width > listIndent) append(' '.repeat(columns + width - listIndent), from + offset - 1, from + offset);
          columns += width;
        }
        return offset;
      };
      let offset = 0;
      let copiedTo = 0;
      while (offset < raw.length) {
        if (raw[offset] === '\n') {
          append(raw.slice(copiedTo, offset), from + copiedTo, from + offset);
          append(' ', from + offset, from + offset + 1); offset++; copiedTo = offset;
          const line = state.doc.lineAt(from + offset), lineFrom = line.from;
          for (const quote of quoteMarks) {
            if (quote.from < lineFrom || quote.from >= line.to || quote.from < from + offset) continue;
            const localFrom = quote.from - from, localTo = quote.to - from;
            if (localFrom > offset && !/^[\t ]*$/.test(raw.slice(offset, localFrom))) break;
            offset = localTo;
            if (/[\t ]/.test(raw[offset] || '')) offset++;
            copiedTo = offset;
          }
          if (list) { offset = skipListIndent(offset); copiedTo = offset; }
        } else {
          offset++;
        }
      }
      append(raw.slice(copiedTo), from + copiedTo, to);
      if (pieces[0]?.value.startsWith(' ') && pieces.at(-1)?.value.endsWith(' ') && pieces.some(piece => /\S/.test(piece.value))) {
        const first = pieces[0]; first.value = first.value.slice(1);
        if (first.to - first.from === first.value.length + 1) first.from++;
        if (!pieces[0].value) pieces.shift();
        const last = pieces.at(-1)!; last.value = last.value.slice(0, -1);
        if (last.to - last.from === last.value.length + 1) last.to--;
        if (!last.value) pieces.pop();
      }
      for (const piece of pieces) result.append(piece.value, piece.from, piece.to);
      return;
    }
    if ((item.name === 'Link' || item.name === 'Image') && isResolvedMarkdownLink(state, tree, item)) {
      const marks = item.getChildren('LinkMark'), close = marks.find(mark => state.sliceDoc(mark.from, mark.to) === ']');
      if (marks[0] && close) { children(item, marks[0].to, close.from); return; }
    }
    if (item.name === 'Autolink') { copy(item.from + 1, item.to - 1); return; }
    if (item.firstChild) children(item); else copy(item.from, item.to);
  };
  visit(node);
  return result.finish(node.from);
}

export function projectedHeadingLabel(state: EditorState, node: MarkdownNode, tree: MarkdownTree = syntaxTree(state)) {
  return projectInlineText(state, node, tree).text.replace(/[\t\r\n ]+/g, ' ').trim() || '无标题';
}

function columns(text: string, tabSize: number) {
  let column = 0;
  for (const character of text) column += character === '\t' ? tabSize - column % tabSize : 1;
  return column;
}

function blockContext(state: EditorState, node: MarkdownNode): BlockContext {
  const line = state.doc.lineAt(node.from), prefix = state.sliceDoc(line.from, node.from);
  // This prefix is outside the parsed block and contains container syntax only.
  const withoutQuotes = (text: string) => text.replace(/>[\t ]?/g, '');
  let quoteDepth = 0, inList = false;
  const markers: BlockContext['markers'] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') quoteDepth++;
    if (parent.name !== 'ListItem') continue;
    inList = true;
    const marker = parent.getChild('ListMark');
    if (marker && marker.from >= line.from && marker.to <= node.from) markers.unshift({
      column: columns(withoutQuotes(state.sliceDoc(line.from, marker.from)), state.tabSize),
      label: parent.parent?.name === 'OrderedList' ? state.sliceDoc(marker.from, marker.to) : '•',
      source: marker.from,
    });
  }
  return { quoteDepth, indentColumns: inList ? columns(withoutQuotes(prefix), state.tabSize) : 0, markers };
}

function blockRange(state: EditorState, node: MarkdownNode) {
  return { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(Math.max(node.from, node.to - 1)).to };
}

export function projectCodeBlock(state: EditorState, node: MarkdownNode): CodeProjection {
  const result = new ProjectionBuilder(), body = node.getChildren('CodeText');
  for (const part of body) result.copy(state, part.from, part.to);
  const anchor = body[0]?.from ?? Math.min(node.to, state.doc.lineAt(node.from).to + 1);
  const info = node.getChild('CodeInfo');
  return { ...blockRange(state, node), content: result.finish(anchor), context: blockContext(state, node), language: info ? state.sliceDoc(info.from, info.to) : '' };
}

const referenceCache = new WeakMap<MarkdownTree, { doc: EditorState['doc']; source: string }>();
function referenceTitle(state: EditorState, title: MarkdownNode) {
  let source = '', position = title.from;
  const cursor = title.cursor();
  do {
    if (cursor.name !== 'QuoteMark') continue;
    source += state.sliceDoc(position, cursor.from);
    position = cursor.to;
    if (/[\t ]/.test(state.sliceDoc(position, position + 1))) position++;
  } while (cursor.next() && cursor.from < title.to);
  return source + state.sliceDoc(position, title.to);
}
function referenceSource(state: EditorState, tree: MarkdownTree) {
  const cached = referenceCache.get(tree);
  if (cached?.doc === state.doc) return cached.source;
  const definitions: string[] = [];
  tree.iterate({ enter(ref) {
    if (ref.name !== 'LinkReference') return;
    const label = ref.node.getChild('LinkLabel'), url = ref.node.getChild('URL'), title = ref.node.getChild('LinkTitle');
    if (label && url) definitions.push(state.sliceDoc(label.from, label.to) + ': ' + state.sliceDoc(url.from, url.to) + (title ? ' ' + referenceTitle(state, title) : ''));
  } });
  const source = definitions.length ? '\n\n' + definitions.join('\n') : '';
  referenceCache.set(tree, { doc: state.doc, source });
  return source;
}

export function projectTable(state: EditorState, node: MarkdownNode, tree: MarkdownTree = syntaxTree(state)): TableProjection {
  const result = new ProjectionBuilder(), cells: TableCellProjection[] = [];
  const rowCells = (row: MarkdownNode) => {
    const delimiters = row.getChildren('TableDelimiter'), parsed = row.getChildren('TableCell');
    const intervals: { from: number; to: number }[] = [];
    let from = row.from;
    for (let index = 0; index < delimiters.length; index++) {
      const delimiter = delimiters[index];
      if (index || state.sliceDoc(row.from, delimiter.from).trim()) intervals.push({ from, to: delimiter.from });
      from = delimiter.to;
    }
    if (!delimiters.length || state.sliceDoc(delimiters.at(-1)!.to, row.to).trim()) intervals.push({ from, to: row.to });
    let parsedIndex = 0;
    return intervals.map((interval, column) => {
      while (parsedIndex < parsed.length && parsed[parsedIndex].from < interval.from) parsedIndex++;
      const candidate = parsed[parsedIndex], cell = candidate && candidate.to <= interval.to ? candidate : undefined;
      if (cell) parsedIndex++;
      const text = cell ? projectInlineText(state, cell, tree) : { text: '', segments: [], anchor: interval.to };
      const raw = state.sliceDoc(interval.from, interval.to), leading = raw.match(/^[\t ]*/)?.[0].length ?? 0;
      const trailing = raw.match(/[\t ]*$/)?.[0].length ?? 0;
      const from = Math.min(interval.to, interval.from + leading), to = Math.max(from, interval.to - trailing);
      return { ...text, from, to, row: -1, column };
    });
  };
  const header = node.getChild('TableHeader');
  const width = header ? rowCells(header).length : 0;
  let rowIndex = 0;
  for (let row = node.firstChild; row; row = row.nextSibling) {
    if (!['TableHeader', 'TableDelimiter', 'TableRow'].includes(row.name)) continue;
    if (result.text) result.append('\n', state.doc.lineAt(row.from).from - 1, state.doc.lineAt(row.from).from);
    result.copy(state, row.from, row.to);
    if (row.name === 'TableDelimiter') continue;
    const projected = rowCells(row);
    for (let index = 0; index < width; index++) {
      const cell = projected[index] ?? { text: '', segments: [], anchor: row.to, from: row.to, to: row.to, row: -1, column: index };
      cells.push({ ...cell, row: rowIndex, column: index });
    }
    rowIndex++;
  }
  return { ...blockRange(state, node), content: result.finish(node.from), context: blockContext(state, node), cells, references: referenceSource(state, tree) };
}
