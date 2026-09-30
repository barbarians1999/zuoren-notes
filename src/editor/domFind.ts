import { EditorView as CodeMirrorView } from '@codemirror/view';
import { findLiteralMatches, type LiteralMatch } from '../findReplace';
import { normalizePdfSearchText, normalizePdfSearchTextWithMap } from '../pdfSearch';
export type FindRange = LiteralMatch & { from: number; to: number };


export function findSourceMatches(view: CodeMirrorView, query: string, caseSensitive: boolean): FindRange[] {
  if (!query) return [];
  return findLiteralMatches(view.state.doc.toString(), query, caseSensitive).map(match => ({
    from: match.from,
    to: match.to,
  }));
}

export type DomTextMap = { text: string; nodes: { from: number; to: number; node: Text }[] };
export function readDomText(root: HTMLElement): DomTextMap {
  const nodes: DomTextMap['nodes'] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data) continue;
    nodes.push({ from: text.length, to: text.length + node.data.length, node });
    text += node.data;
  }
  return { text, nodes };
}

export function domRangeForMatch(root: HTMLElement, map: DomTextMap, match: LiteralMatch): Range | null {
  const start = map.nodes.find(segment => match.from >= segment.from && match.from < segment.to);
  const end = map.nodes.find(segment => match.to > segment.from && match.to <= segment.to);
  if (!start || !end || !root.contains(start.node) || !root.contains(end.node)) return null;
  const range = document.createRange();
  range.setStart(start.node, match.from - start.from);
  range.setEnd(end.node, match.to - end.from);
  return range;
}

export function selectDomMatch(root: HTMLElement, map: DomTextMap, match: LiteralMatch) {
  const range = domRangeForMatch(root, map, match);
  if (!range) return;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  (range.startContainer.parentElement || root).scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function findDomMatch(root: HTMLElement, query: string, occurrence: number, caseSensitive = false): { map: DomTextMap; match: LiteralMatch } | null {
  const nodes: DomTextMap['nodes'] = [];
  let raw = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data) continue;
    const previous = raw.at(-1) || '';
    if (previous && !/\s/u.test(previous) && /[A-Za-z0-9]/u.test(previous) && /[A-Za-z0-9]/u.test(node.data[0] || '')) raw += ' ';
    nodes.push({ from: raw.length, to: raw.length + node.data.length, node });
    raw += node.data;
  }
  const normalized = normalizePdfSearchTextWithMap(raw);
  const normalizedQuery = normalizePdfSearchText(query).trim();
  const matches = findLiteralMatches(normalized.text, normalizedQuery, caseSensitive);
  const match = matches[Math.min(Math.max(occurrence, 0), Math.max(0, matches.length - 1))];
  if (!match) return null;
  const rawFrom = normalized.starts[match.from];
  const rawTo = normalized.ends[match.to - 1];
  return Number.isInteger(rawFrom) && Number.isInteger(rawTo) ? { map: { text: raw, nodes }, match: { from: rawFrom, to: rawTo } } : null;
}
