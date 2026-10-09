import type { PdfAnchor, PdfRect } from '../types';

export type PdfSelectedPage = { page: number; rotation: PdfAnchor['rotation']; quote: string; rects: PdfRect[]; textRevision: number };
export type PdfTextSelection = { id: string; pdfId: string; path: string; documentKey: object; pages: PdfSelectedPage[]; quote: string };
type DirectedRect = PdfRect & { angle?: number };
type Bounds = { left: number; top: number; width: number; height: number };

// Coordinates remain relative to the already-rotated page viewport, as in v1 anchors.
export function cleanPdfRects(rects: readonly DirectedRect[], width: number, height: number): PdfRect[] {
  if (!(width > 0 && height > 0)) return [];
  const result: DirectedRect[] = [];
  for (const rect of rects) {
    if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) continue;
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    const right = Math.min(1, rect.x + rect.w), bottom = Math.min(1, rect.y + rect.h);
    if (right <= x || bottom <= y) continue;
    let next: DirectedRect = { x, y, w: right - x, h: bottom - y, angle: rect.angle || 0 };
    // Restart after each union, so one bridge fragment cannot leave overlap behind.
    for (let i = 0; i < result.length;) {
      const old = result[i], angle = Math.abs((old.angle || 0) - (next.angle || 0)) % 180;
      const vertical = Math.abs(Math.sin((next.angle || 0) * Math.PI / 180)) > Math.SQRT1_2;
      const crossSize = vertical ? Math.min(old.w, next.w) * width : Math.min(old.h, next.h) * height;
      const centers = vertical ? Math.abs(old.x + old.w / 2 - next.x - next.w / 2) * width : Math.abs(old.y + old.h / 2 - next.y - next.h / 2) * height;
      const gap = vertical ? Math.max(old.y, next.y) - Math.min(old.y + old.h, next.y + next.h) : Math.max(old.x, next.x) - Math.min(old.x + old.w, next.x + next.w);
      if (Math.min(angle, 180 - angle) <= 1 && centers <= Math.max(1, crossSize * .15) && gap * (vertical ? height : width) <= 1) {
        const left = Math.min(old.x, next.x), top = Math.min(old.y, next.y);
        next = { x: left, y: top, w: Math.max(old.x + old.w, next.x + next.w) - left, h: Math.max(old.y + old.h, next.y + next.h) - top, angle: next.angle };
        result.splice(i, 1); i = 0;
      } else i += 1;
    }
    result.push(next);
  }
  return result.map(({ x, y, w, h }) => ({ x, y, w, h }));
}

// Paint saved geometry once, even when distinct old annotations overlap.
// During re-selection, leave that area to the blue overlay instead of mixing
// yellow and blue. This changes drawing only, never persisted annotations.
export function visiblePdfHighlightRects(saved: readonly PdfRect[], selected: readonly PdfRect[], width: number, height: number): PdfRect[] {
  let visible = cleanPdfRects(saved, width, height);
  for (const cut of cleanPdfRects(selected, width, height)) visible = visible.flatMap(rect => {
    const left = Math.max(rect.x, cut.x), top = Math.max(rect.y, cut.y);
    const right = Math.min(rect.x + rect.w, cut.x + cut.w), bottom = Math.min(rect.y + rect.h, cut.y + cut.h);
    if (right <= left || bottom <= top) return [rect];
    return [
      { x: rect.x, y: rect.y, w: rect.w, h: top - rect.y },
      { x: rect.x, y: bottom, w: rect.w, h: rect.y + rect.h - bottom },
      { x: rect.x, y: top, w: left - rect.x, h: bottom - top },
      { x: right, y: top, w: rect.x + rect.w - right, h: bottom - top },
    ].filter(piece => piece.w > 1e-8 && piece.h > 1e-8);
  });
  return visible;
}

type TextPiece = { text: string; element: HTMLElement; range: Range; angle: number };
function textPieces(range: Range, layer: HTMLElement): TextPiece[] {
  const pieces: TextPiece[] = [];
  const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, element = node.parentElement;
    if (!node.data || !element || element.closest('[role="img"], .endOfContent') || !range.intersectsNode(node)) continue;
    const from = range.startContainer === node ? range.startOffset : 0;
    const to = range.endContainer === node ? range.endOffset : node.length;
    if (from >= to) continue;
    const css = getComputedStyle(element);
    if (css.display === 'none' || css.visibility === 'hidden') continue;
    const part = layer.ownerDocument.createRange(); part.setStart(node, from); part.setEnd(node, to);
    const matrix = css.transform === 'none' ? null : new DOMMatrixReadOnly(css.transform);
    pieces.push({ text: node.data.slice(from, to), element, range: part, angle: Number(layer.dataset.mainRotation || 0) + (matrix ? Math.atan2(matrix.b, matrix.a) * 180 / Math.PI : 0) });
  }
  return pieces;
}
function pieceRects(pieces: TextPiece[], bounds: Bounds): PdfRect[] {
  const rects: DirectedRect[] = [];
  for (const piece of pieces) for (const rect of piece.range.getClientRects()) {
    rects.push({ x: (rect.left - bounds.left) / bounds.width, y: (rect.top - bounds.top) / bounds.height, w: rect.width / bounds.width, h: rect.height / bounds.height, angle: piece.angle });
  }
  return cleanPdfRects(rects, bounds.width, bounds.height);
}
export function pdfRangeRects(range: Range, layer: HTMLElement, bounds = layer.getBoundingClientRect()): PdfRect[] {
  return pieceRects(textPieces(range, layer), bounds);
}
function pieceQuote(pieces: TextPiece[]): string {
  let quote = '', previous: TextPiece | undefined;
  for (const piece of pieces) {
    if (previous && piece.element !== previous.element && !/\s$/u.test(quote) && !/^\s/u.test(piece.text)) {
      const a = previous.range.getBoundingClientRect(), b = piece.range.getBoundingClientRect();
      const vertical = Math.abs(Math.sin(piece.angle * Math.PI / 180)) > Math.SQRT1_2;
      const cross = vertical ? Math.abs(a.left + a.width / 2 - b.left - b.width / 2) : Math.abs(a.top + a.height / 2 - b.top - b.height / 2);
      const size = vertical ? Math.min(a.width, b.width) : Math.min(a.height, b.height);
      if (previous.element.nextElementSibling?.tagName === 'BR' || cross > Math.max(1, size * .5) || Math.abs(previous.angle - piece.angle) > 1) quote += '\n';
      else if (/[A-Za-z0-9]$/u.test(quote) && /^[A-Za-z0-9]/u.test(piece.text) && b.left - a.right > 1) quote += ' ';
    }
    quote += piece.text; previous = piece;
  }
  return quote.trim();
}
export function selectedPdfPages(root: HTMLElement, selection = window.getSelection()): number[] {
  if (!selection?.rangeCount || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return [];
  return [...root.querySelectorAll<HTMLElement>('[data-pdf-page]')].filter(slot => range.intersectsNode(slot)).map(slot => Number(slot.dataset.pdfPage));
}
type PdfPoint = { x: number; y: number };
function pointRectDistance(point: PdfPoint, rect: DOMRect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return dx * dx + dy * dy;
}
function nearestPdfTextPosition(root: HTMLElement, point: PdfPoint): { node: Text; offset: number } | null {
  const holders = [...root.querySelectorAll<HTMLElement>('.canvas-holder')];
  const holder = holders.find(item => {
    const rect = item.getBoundingClientRect();
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  });
  const layer = holder?.querySelector<HTMLElement>('.textLayer');
  if (!layer) return null;

  let span: HTMLElement | null = null, spanDistance = Infinity, spanTop = -Infinity;
  for (const candidate of layer.querySelectorAll<HTMLElement>('span')) {
    if (candidate.closest('[role="img"], .endOfContent') || !candidate.firstChild || candidate.firstChild.nodeType !== Node.TEXT_NODE) continue;
    const rect = candidate.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const distance = pointRectDistance(point, rect);
    // At an exact inter-line tie, prefer the lower visual line: that is the
    // line the pointer is entering as the user drags down through the gap.
    if (distance < spanDistance - .01 || (Math.abs(distance - spanDistance) <= .01 && rect.top > spanTop)) {
      span = candidate; spanDistance = distance; spanTop = rect.top;
    }
  }
  if (!span) return null;
  const style = getComputedStyle(span), transform = style.transform === 'none' ? null : new DOMMatrixReadOnly(style.transform);
  const angle = transform ? Math.atan2(transform.b, transform.a) : 0;
  const direction = style.direction === 'rtl' ? -1 : 1;
  const axisX = Math.cos(angle) * direction, axisY = Math.sin(angle) * direction;
  let best: { node: Text; offset: number; distance: number } | null = null;
  const walker = layer.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    for (let offset = 0; offset < node.length; offset += 1) {
      const range = layer.ownerDocument.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const distance = pointRectDistance(point, rect);
      if (!best || distance < best.distance) {
        const after = (point.x - (rect.left + rect.width / 2)) * axisX + (point.y - (rect.top + rect.height / 2)) * axisY > 0;
        best = { node, offset: offset + (after ? 1 : 0), distance };
      }
    }
  }
  return best && { node: best.node, offset: best.offset };
}
function textPositionAtPoint(root: HTMLElement, point: PdfPoint): { node: Text; offset: number } | null {
  const document = root.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const range = document.caretRangeFromPoint?.(point.x, point.y);
  const caret = range ? null : document.caretPositionFromPoint?.(point.x, point.y);
  const position = range ? { node: range.startContainer, offset: range.startOffset }
    : caret ? { node: caret.offsetNode, offset: caret.offset } : null;
  if (position?.node.nodeType === Node.TEXT_NODE && root.contains(position.node)) {
    const text = position.node as Text, span = text.parentElement?.closest('.textLayer span');
    if (span && !span.closest('[role="img"], .endOfContent') && position.offset >= 0 && position.offset <= text.length) return { node: text, offset: position.offset };
  }
  return nearestPdfTextPosition(root, point);
}

// Native dragging can anchor to a distant PDF.js text run when the pointer
// starts in the whitespace between lines. Re-anchor from the actual pointer
// endpoints so visual intent, not DOM order, defines the selected text.
export function setPdfSelectionFromPoints(root: HTMLElement, anchor: PdfPoint, focus: PdfPoint, selection = window.getSelection()): boolean {
  if (!selection) return false;
  const start = textPositionAtPoint(root, anchor), end = textPositionAtPoint(root, focus);
  if (!start || !end) return false;
  try {
    selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    return true;
  } catch { return false; }
}
export function capturePdfTextSelection(root: HTMLElement, identity: { pdfId: string; path: string; documentKey: object }, selection = window.getSelection()): PdfTextSelection | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const pages: PdfSelectedPage[] = [];
  for (const layer of root.querySelectorAll<HTMLElement>('.textLayer')) {
    if (!range.intersectsNode(layer)) continue;
    const holder = layer.closest<HTMLElement>('.canvas-holder'), slot = layer.closest<HTMLElement>('[data-pdf-page]');
    if (!holder || !slot) continue;
    const pieces = textPieces(range, layer), quote = pieceQuote(pieces), rects = pieceRects(pieces, holder.getBoundingClientRect());
    if (!quote || !rects.length) continue;
    pages.push({ page: Number(slot.dataset.pdfPage), rotation: Number(holder.dataset.rotation || 0) as PdfAnchor['rotation'], quote, rects, textRevision: Number(layer.dataset.textRevision || 0) });
  }
  return pages.length ? { ...identity, id: crypto.randomUUID(), pages, quote: pages.map(item => item.quote).join('\n\n') } : null;
}
