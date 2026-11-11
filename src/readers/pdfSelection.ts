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
type PdfTextPosition = { node: Text; offset: number };
type PdfEndpointCandidate = { element: HTMLElement; rect: DOMRect; position: PdfTextPosition; text: string };
export type PdfTextEndpointCache = { layer: HTMLElement; revision: string; rotation: string; candidates: PdfEndpointCandidate[] };
export type PdfTextEndpointLayerState = { layer: HTMLElement | null; revision: string; firstSpan: HTMLElement | null };
export function pdfTextEndpointLayerState(page: HTMLElement): PdfTextEndpointLayerState {
  const layer = page.querySelector<HTMLElement>('.canvas-holder .textLayer');
  return { layer, revision: layer?.dataset.textRevision || '', firstSpan: layer?.querySelector<HTMLElement>('span') || null };
}
export function pdfTextEndpointLayerChanged(previous: PdfTextEndpointLayerState, current: PdfTextEndpointLayerState): boolean {
  return previous.layer !== current.layer || previous.revision !== current.revision || previous.firstSpan !== current.firstSpan;
}
export function pdfSelectionPointsAfterScroll(anchor: PdfPoint, focus: PdfPoint, initialScroll: PdfPoint, currentScroll: PdfPoint): { anchor: PdfPoint; focus: PdfPoint } {
  return {
    anchor: { x: anchor.x - (currentScroll.x - initialScroll.x), y: anchor.y - (currentScroll.y - initialScroll.y) },
    focus,
  };
}
export function pdfPageNumbersBetween(start: number, end: number): number[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) return [];
  const direction = end < start ? -1 : 1;
  return Array.from({ length: Math.abs(end - start) + 1 }, (_, index) => start + index * direction);
}
function pointRectDistance(point: PdfPoint, rect: DOMRect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return dx * dx + dy * dy;
}
export function closestPdfTextSpan(spans: readonly { element: HTMLElement; rect: DOMRect }[], point: PdfPoint, toward?: PdfPoint): HTMLElement | null {
  let closest: HTMLElement | null = null, distance = Infinity, top = -Infinity, projection = -Infinity;
  for (const span of spans) {
    const nextDistance = pointRectDistance(point, span.rect);
    const nextProjection = toward ? (span.rect.left + span.rect.width / 2) * toward.x + (span.rect.top + span.rect.height / 2) * toward.y : 0;
    if (nextDistance < distance - .01 || (Math.abs(nextDistance - distance) <= .01 && (toward && (toward.x || toward.y)
      ? nextProjection > projection : span.rect.top > top))) {
      closest = span.element; distance = nextDistance; top = span.rect.top; projection = nextProjection;
    }
  }
  return closest;
}
export function pdfCaretMatchesNearestSpan(position: { node: Node; offset: number }, nearest: HTMLElement | null): boolean {
  const text = position.node as Text, span = text.parentElement?.closest('.textLayer span');
  return position.node.nodeType === 3 && !!nearest && span === nearest && position.offset >= 0 && position.offset <= text.length;
}
export function pdfCaretCoversPoint(position: { node: Node; offset: number }, point: PdfPoint): boolean {
  const text = position.node as Text, span = text.parentElement?.closest('.textLayer span');
  if (position.node.nodeType !== 3 || !span || span.closest('[role="img"], .endOfContent') || position.offset < 0 || position.offset > text.length) return false;
  const rect = span.getBoundingClientRect();
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}
export function pdfSelectionEndpointDirections(anchor: PdfPoint, focus: PdfPoint): { start: PdfPoint; end: PdfPoint } {
  return { start: { x: focus.x - anchor.x, y: focus.y - anchor.y }, end: { x: anchor.x - focus.x, y: anchor.y - focus.y } };
}
function pdfTextSpans(layer: HTMLElement) {
  return [...layer.querySelectorAll<HTMLElement>('span')]
    .filter(span => !span.closest('[role="img"], .endOfContent') && !!span.firstChild && span.firstChild.nodeType === Node.TEXT_NODE)
    .map(element => ({ element, rect: element.getBoundingClientRect() }))
    .filter(span => span.rect.width > 0 && span.rect.height > 0);
}
function textLayerAtPoint(root: HTMLElement, point: PdfPoint): HTMLElement | null {
  const holders = [...root.querySelectorAll<HTMLElement>('.canvas-holder')];
  const holder = holders.find(item => {
    const rect = item.getBoundingClientRect();
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  });
  return holder?.querySelector<HTMLElement>('.textLayer') || null;
}
function nearestPdfTextPositionInSpan(span: HTMLElement, point: PdfPoint): PdfTextPosition | null {
  const style = getComputedStyle(span), transform = style.transform === 'none' ? null : new DOMMatrixReadOnly(style.transform);
  const angle = transform ? Math.atan2(transform.b, transform.a) : 0;
  const direction = style.direction === 'rtl' ? -1 : 1;
  const axisX = Math.cos(angle) * direction, axisY = Math.sin(angle) * direction;
  let best: { node: Text; offset: number; distance: number } | null = null;
  const walker = span.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    for (let offset = 0; offset < node.length; offset += 1) {
      const range = span.ownerDocument.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
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
function nearestPdfTextPosition(root: HTMLElement, point: PdfPoint, toward?: PdfPoint): PdfTextPosition | null {
  const layer = textLayerAtPoint(root, point);
  if (!layer) return null;
  const span = closestPdfTextSpan(pdfTextSpans(layer), point, toward);
  return span ? nearestPdfTextPositionInSpan(span, point) : null;
}
function nativePdfTextPosition(root: HTMLElement, point: PdfPoint): { node: Node; offset: number } | null {
  const document = root.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const range = document.caretRangeFromPoint?.(point.x, point.y);
  const caret = range ? null : document.caretPositionFromPoint?.(point.x, point.y);
  const position = range ? { node: range.startContainer, offset: range.startOffset }
    : caret ? { node: caret.offsetNode, offset: caret.offset } : null;
  return position?.node.nodeType === Node.TEXT_NODE && root.contains(position.node) ? position : null;
}
function textPositionAtPoint(root: HTMLElement, point: PdfPoint, toward?: PdfPoint): PdfTextPosition | null {
  const position = nativePdfTextPosition(root, point);
  if (position?.node.nodeType === Node.TEXT_NODE && root.contains(position.node)) {
    if (pdfCaretCoversPoint(position, point)) return { node: position.node as Text, offset: position.offset };
    const holder = root.querySelectorAll<HTMLElement>('.canvas-holder');
    const layer = [...holder].find(item => {
      const rect = item.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    })?.querySelector<HTMLElement>('.textLayer');
    const nearest = layer ? closestPdfTextSpan(pdfTextSpans(layer), point, toward) : null;
    if (pdfCaretMatchesNearestSpan(position, nearest)) return { node: position.node as Text, offset: position.offset };
  }
  return nearestPdfTextPosition(root, point, toward);
}
export function createPdfTextEndpointCache(root: HTMLElement, point: PdfPoint): PdfTextEndpointCache | null {
  const layer = textLayerAtPoint(root, point);
  if (!layer) return null;
  const spans = pdfTextSpans(layer);
  let minimum = Infinity;
  for (const span of spans) minimum = Math.min(minimum, pointRectDistance(point, span.rect));
  if (!Number.isFinite(minimum)) return null;
  const native = nativePdfTextPosition(root, point);
  const candidates: PdfEndpointCandidate[] = [];
  for (const span of spans) {
    const distance = pointRectDistance(point, span.rect);
    if (Math.abs(distance - minimum) > .01) continue;
    const position = native && pdfCaretMatchesNearestSpan(native, span.element)
      ? { node: native.node as Text, offset: native.offset }
      : nearestPdfTextPositionInSpan(span.element, point);
    if (position) candidates.push({ element: span.element, rect: span.rect, position, text: position.node.data });
  }
  return candidates.length ? { layer, revision: layer.dataset.textRevision || '', rotation: layer.dataset.mainRotation || '', candidates } : null;
}
export function isPdfTextEndpointCacheValid(root: HTMLElement, cache: PdfTextEndpointCache): boolean {
  if (!root.contains(cache.layer) || cache.layer.dataset.textRevision !== cache.revision || (cache.layer.dataset.mainRotation || '') !== cache.rotation) return false;
  return cache.candidates.every(candidate => {
    if (!root.contains(candidate.position.node) || !candidate.element.isConnected || candidate.position.node.data !== candidate.text
      || candidate.position.node.parentElement?.closest('.textLayer span') !== candidate.element) return false;
    const rect = candidate.element.getBoundingClientRect();
    return Math.abs(rect.width - candidate.rect.width) < .05 && Math.abs(rect.height - candidate.rect.height) < .05;
  });
}
export function pdfTextPositionFromEndpointCache(root: HTMLElement, cache: PdfTextEndpointCache, toward?: PdfPoint): PdfTextPosition | null {
  if (!isPdfTextEndpointCacheValid(root, cache)) return null;
  let best = cache.candidates[0], top = best.rect.top;
  let projection = toward ? (best.rect.left + best.rect.width / 2) * toward.x + (best.rect.top + best.rect.height / 2) * toward.y : 0;
  for (const candidate of cache.candidates.slice(1)) {
    const nextProjection = toward ? (candidate.rect.left + candidate.rect.width / 2) * toward.x + (candidate.rect.top + candidate.rect.height / 2) * toward.y : 0;
    if (toward && (toward.x || toward.y) ? nextProjection > projection : candidate.rect.top > top) {
      best = candidate; top = candidate.rect.top; projection = nextProjection;
    }
  }
  return best.position;
}

// Native dragging can anchor to a distant PDF.js text run when the pointer
// starts in the whitespace between lines. Re-anchor from the actual pointer
// endpoints so visual intent, not DOM order, defines the selected text.
export function setPdfSelectionFromPoints(root: HTMLElement, anchor: PdfPoint, focus: PdfPoint, selection = window.getSelection(), cachedAnchor?: PdfTextPosition | null): boolean {
  if (!selection) return false;
  const toward = pdfSelectionEndpointDirections(anchor, focus);
  const start = cachedAnchor === undefined ? textPositionAtPoint(root, anchor, toward.start)
    : cachedAnchor && root.contains(cachedAnchor.node) ? cachedAnchor : null;
  const end = textPositionAtPoint(root, focus, toward.end);
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
