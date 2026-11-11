import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ActivePdf } from '../readerContext';
import { capturePdfTextSelection, createPdfTextEndpointCache, isPdfTextEndpointCacheValid, pdfPageNumbersBetween, pdfSelectionEndpointDirections, pdfSelectionPointsAfterScroll, pdfTextEndpointLayerChanged, pdfTextEndpointLayerState, pdfTextPositionFromEndpointCache, selectedPdfPages, setPdfSelectionFromPoints, type PdfTextEndpointCache, type PdfTextEndpointLayerState, type PdfTextSelection } from './pdfSelection';
import type { PdfTextAction, PdfTextActionHandler, PdfTextActionResult } from './pdfTextAction';

export function usePdfSelection({ pdf, root, tool, onTextAction, onMessage, onClickPoint, onStart }: {
  pdf: ActivePdf | null; root: RefObject<HTMLElement | null>; tool: string;
  onTextAction: PdfTextActionHandler; onMessage: (message: string) => void;
  onClickPoint: (x: number, y: number, element: Element) => void; onStart: () => void;
}) {
  const [draft, setDraft] = useState<PdfTextSelection | null>(null), draftRef = useRef(draft);
  const [pins, setPins] = useState<number[]>([]);
  const [busy, setBusy] = useState(false), lock = useRef(false);
  const [result, setResult] = useState<PdfTextActionResult | null>(null);
  const drag = useRef<{ x: number; y: number; focusX: number; focusY: number; scrollX: number; scrollY: number; pointerId: number; key: object; page: number; pageSlot: HTMLElement | null; anchorCacheReady: boolean; anchorCache: PdfTextEndpointCache | null; anchorProbe: PdfTextEndpointLayerState } | null>(null);
  const generation = useRef(0);
  const latest = useRef({ pdf, tool, onTextAction, onMessage, onClickPoint, onStart });
  latest.current = { pdf, tool, onTextAction, onMessage, onClickPoint, onStart };
  const replace = (value: PdfTextSelection | null) => { draftRef.current = value; setDraft(value); setResult(null); };
  const clear = () => {
    generation.current += 1;
    replace(null); drag.current = null; setPins([]);
    const selected = window.getSelection();
    if (selected?.anchorNode && root.current?.contains(selected.anchorNode)) selected.removeAllRanges();
  };
  useEffect(() => { clear(); }, [pdf?.data]);
  useEffect(() => { if (tool !== 'select' && tool !== 'highlight') clear(); }, [tool]);
  useEffect(() => {
    let frame = 0;
    const pin = () => {
      const start = drag.current, element = root.current;
      if (!start || !element || latest.current.pdf?.data !== start.key) return;
      const pages = [...new Set([start.page, ...selectedPdfPages(element)])];
      setPins(old => { const next = [...new Set([...old, ...pages])]; return next.length === old.length ? old : next; });
    };
    const updateDragSelection = (start: NonNullable<typeof drag.current>, released = false) => {
      const current = latest.current, host = root.current;
      if ((drag.current !== start && !(released && !drag.current)) || !host || current.pdf?.data !== start.key || (current.tool !== 'select' && current.tool !== 'highlight')) return;
      const scroller = host.querySelector<HTMLElement>('.pdf-canvas-wrap');
      const points = pdfSelectionPointsAfterScroll(
        { x: start.x, y: start.y }, { x: start.focusX, y: start.focusY },
        { x: start.scrollX, y: start.scrollY }, { x: scroller?.scrollLeft || 0, y: scroller?.scrollTop || 0 },
      );
      const focusPage = [...host.querySelectorAll<HTMLElement>('[data-pdf-page]')].find(slot => {
        const rect = slot.getBoundingClientRect();
        return points.focus.x >= rect.left && points.focus.x <= rect.right && points.focus.y >= rect.top && points.focus.y <= rect.bottom;
      });
      const endPage = Number(focusPage?.dataset.pdfPage) || start.page;
      const pages = [...new Set([...pdfPageNumbersBetween(start.page, endPage), ...selectedPdfPages(host)])];
      setPins(old => { const next = [...new Set([...old, ...pages])]; return next.length === old.length ? old : next; });
      const layerState = start.pageSlot ? pdfTextEndpointLayerState(start.pageSlot) : { layer: null, revision: '', firstSpan: null };
      const shouldResolveAnchor = !start.anchorCacheReady
        || (start.anchorCache && !isPdfTextEndpointCacheValid(host, start.anchorCache))
        || (!start.anchorCache && pdfTextEndpointLayerChanged(start.anchorProbe, layerState));
      if (shouldResolveAnchor) {
        start.anchorCache = createPdfTextEndpointCache(host, points.anchor); start.anchorCacheReady = true; start.anchorProbe = layerState;
      }
      const toward = pdfSelectionEndpointDirections(points.anchor, points.focus).start;
      const cachedAnchor = start.anchorCache ? pdfTextPositionFromEndpointCache(host, start.anchorCache, toward) : null;
      if (start.anchorCache && !cachedAnchor) {
        start.anchorCache = createPdfTextEndpointCache(host, points.anchor); start.anchorProbe = layerState;
        const refreshed = start.anchorCache && pdfTextPositionFromEndpointCache(host, start.anchorCache, toward);
        setPdfSelectionFromPoints(host, points.anchor, points.focus, undefined, refreshed);
      } else setPdfSelectionFromPoints(host, points.anchor, points.focus, undefined, cachedAnchor);
    };
    const scheduleDragSelection = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; const start = drag.current; if (start) updateDragSelection(start); });
    };
    const down = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target : null, host = root.current, current = latest.current;
      if (!element || !host || !current.pdf) return;
      if (element.closest('.pdf-text-actions, .pdf-annotation-menu')) return;
      if (!host.contains(element)) { clear(); return; }
      if (element.closest('input, textarea')) { clear(); return; }
      const holder = element.closest('.canvas-holder');
      if (!holder || event.button !== 0 || !event.isPrimary || (current.tool !== 'select' && current.tool !== 'highlight')) return;
      cancelAnimationFrame(frame); frame = 0;
      clear(); current.onStart();
      const pageSlot = holder.closest<HTMLElement>('[data-pdf-page]'), number = Number(pageSlot?.dataset.pdfPage);
      const scroller = host.querySelector<HTMLElement>('.pdf-canvas-wrap');
      drag.current = { x: event.clientX, y: event.clientY, focusX: event.clientX, focusY: event.clientY, scrollX: scroller?.scrollLeft || 0, scrollY: scroller?.scrollTop || 0, pointerId: event.pointerId, key: current.pdf.data, page: number, pageSlot,
        anchorCacheReady: false, anchorCache: null, anchorProbe: pageSlot ? pdfTextEndpointLayerState(pageSlot) : { layer: null, revision: '', firstSpan: null } }; setPins([number]);
    };
    const move = (event: PointerEvent) => {
      const start = drag.current;
      if (!start || event.pointerId !== start.pointerId || !event.isPrimary) return;
      start.focusX = event.clientX; start.focusY = event.clientY;
      // Leave native pointer handling enabled; re-anchor its live range once per frame.
      scheduleDragSelection();
    };
    const scroll = () => { if (drag.current) scheduleDragSelection(); };
    const collect = (start: typeof drag.current, event?: PointerEvent) => {
      const current = latest.current, element = root.current;
      if (!element || !current.pdf || (start && current.pdf.data !== start.key) || (current.tool !== 'select' && current.tool !== 'highlight')) return;
      const value = capturePdfTextSelection(element, { pdfId: current.pdf.meta.id, path: current.pdf.path, documentKey: current.pdf.data });
      replace(value);
      if (!value && start && event && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 5 && event.target instanceof Element && element.contains(event.target)) current.onClickPoint(event.clientX, event.clientY, event.target);
    };
    const up = (event: PointerEvent) => {
      const start = drag.current; if (!start || event.pointerId !== start.pointerId) return;
      const token = generation.current;
      start.focusX = event.clientX; start.focusY = event.clientY;
      cancelAnimationFrame(frame); frame = 0;
      updateDragSelection(start);
      const finish = { x: start.focusX, y: start.focusY };
      drag.current = null;
      const scroller = root.current?.querySelector<HTMLElement>('.pdf-canvas-wrap');
      const points = pdfSelectionPointsAfterScroll(
        { x: start.x, y: start.y }, finish,
        { x: start.scrollX, y: start.scrollY }, { x: scroller?.scrollLeft || 0, y: scroller?.scrollTop || 0 },
      );
      frame = requestAnimationFrame(() => { void (async () => {
        if (token !== generation.current) return;
        updateDragSelection(start, true);
        const focusPage = root.current ? [...root.current.querySelectorAll<HTMLElement>('[data-pdf-page]')].find(slot => {
          const rect = slot.getBoundingClientRect();
          return points.focus.x >= rect.left && points.focus.x <= rect.right && points.focus.y >= rect.top && points.focus.y <= rect.bottom;
        }) : null;
        const endPage = Number(focusPage?.dataset.pdfPage) || start.page;
        const pages = [...new Set([...(root.current ? selectedPdfPages(root.current) : []), ...pdfPageNumbersBetween(start.page, endPage)])];
        setPins(old => [...new Set([...old, ...pages])]);
        // A fast cross-page drag can extend through recycled page placeholders.
        // Keep every covered layer mounted until PDF.js has supplied its text;
        // otherwise a snapshot would silently omit intermediate pages.
        const deadline = performance.now() + 8000;
        const pending = () => pages.some(number => !Number(root.current?.querySelector<HTMLElement>(`[data-pdf-page="${number}"] .textLayer`)?.dataset.textRevision));
        while (token === generation.current && pending() && performance.now() < deadline) await new Promise(resolve => window.setTimeout(resolve, 20));
        if (token !== generation.current) return;
        if (pending()) { clear(); latest.current.onMessage('所选页面的文字尚未载入，请待页面显示完成后重新选择。'); return; }
        updateDragSelection(start, true);
        collect(start, event); setPins([]);
      })(); });
    };
    const cancel = (event: PointerEvent) => {
      if (!drag.current || event.pointerId !== drag.current.pointerId) return;
      cancelAnimationFrame(frame); frame = 0; clear();
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!root.current?.contains(event.target as Node) || !event.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const token = generation.current;
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (token === generation.current) collect(null); });
    };
    const copy = (event: ClipboardEvent) => {
      const current = draftRef.current, host = root.current;
      const target = event.target instanceof Element ? event.target : null;
      const focused = window.document.activeElement instanceof Element ? window.document.activeElement : null;
      const selection = window.getSelection();
      const selectedInside = !!selection?.rangeCount && !!host?.contains(selection.getRangeAt(0).commonAncestorContainer);
      const belongsToReader = !!host && (host.contains(target) || host.contains(focused) || selectedInside);
      const editingText = target?.closest('input, textarea, [contenteditable="true"]') || focused?.closest('input, textarea, [contenteditable="true"]');
      if (!current || latest.current.pdf?.data !== current.documentKey || !belongsToReader || editingText) return;
      if (event.clipboardData) { event.clipboardData.setData('text/plain', current.quote); event.preventDefault(); }
    };
    window.addEventListener('pointerdown', down, true); window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
    window.addEventListener('scroll', scroll, true); window.addEventListener('keyup', keyUp);
    window.addEventListener('copy', copy); window.document.addEventListener('selectionchange', pin);
    return () => {
      generation.current += 1;
      cancelAnimationFrame(frame); window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('scroll', scroll, true); window.removeEventListener('keyup', keyUp);
      window.removeEventListener('copy', copy); window.document.removeEventListener('selectionchange', pin);
    };
  }, []);
  async function act(action: PdfTextAction) {
    const selected = draftRef.current, current = latest.current;
    if (!selected || selected.documentKey !== current.pdf?.data || lock.current) return;
    const retry = result?.retry;
    lock.current = true; setBusy(true);
    try {
      const outcome = await (retry ? retry() : current.onTextAction(selected, action));
      if (draftRef.current?.id !== selected.id || latest.current.pdf?.data !== selected.documentKey) return;
      if (outcome.done) { clear(); current.onMessage(outcome.inserted ? '摘录已插入当前笔记' : '高亮已保存'); }
      else { setResult(outcome); if (outcome.error) current.onMessage(outcome.error); }
    } catch (error) { if (draftRef.current?.id === selected.id) current.onMessage(`PDF 文字操作失败：${String(error)}`); }
    finally { lock.current = false; setBusy(false); }
  }
  async function copy() {
    const value = draftRef.current; if (!value || latest.current.pdf?.data !== value.documentKey) return false;
    try { await navigator.clipboard.writeText(value.quote); return draftRef.current?.id === value.id && latest.current.pdf?.data === value.documentKey; }
    catch (error) { if (draftRef.current?.id === value.id) latest.current.onMessage(`复制失败，请使用 Ctrl+C：${String(error)}`); return false; }
  }
  return { draft: draft?.documentKey === pdf?.data ? draft : null, pins, busy, result, clear, act, copy };
}
