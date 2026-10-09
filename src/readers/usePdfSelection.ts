import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ActivePdf } from '../readerContext';
import { capturePdfTextSelection, selectedPdfPages, setPdfSelectionFromPoints, type PdfTextSelection } from './pdfSelection';
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
  const drag = useRef<{ x: number; y: number; scrollX: number; scrollY: number; key: object; page: number } | null>(null);
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
    const down = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target : null, host = root.current, current = latest.current;
      if (!element || !host || !current.pdf) return;
      if (element.closest('.pdf-text-actions, .pdf-annotation-menu')) return;
      if (!host.contains(element)) { clear(); return; }
      if (element.closest('input, textarea')) { clear(); return; }
      const holder = element.closest('.canvas-holder');
      if (!holder || event.button !== 0 || (current.tool !== 'select' && current.tool !== 'highlight')) return;
      clear(); current.onStart();
      const number = Number(holder.closest<HTMLElement>('[data-pdf-page]')?.dataset.pdfPage);
      const scroller = host.querySelector<HTMLElement>('.pdf-canvas-wrap');
      drag.current = { x: event.clientX, y: event.clientY, scrollX: scroller?.scrollLeft || 0, scrollY: scroller?.scrollTop || 0, key: current.pdf.data, page: number }; setPins([number]);
    };
    const collect = (start: typeof drag.current, event?: PointerEvent) => {
      const current = latest.current, element = root.current;
      if (!element || !current.pdf || (start && current.pdf.data !== start.key) || (current.tool !== 'select' && current.tool !== 'highlight')) return;
      const value = capturePdfTextSelection(element, { pdfId: current.pdf.meta.id, path: current.pdf.path, documentKey: current.pdf.data });
      replace(value);
      if (!value && start && event && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 5 && event.target instanceof Element && element.contains(event.target)) current.onClickPoint(event.clientX, event.clientY, event.target);
    };
    const up = (event: PointerEvent) => {
      const start = drag.current; if (!start) return;
      const token = generation.current;
      const finish = { x: event.clientX, y: event.clientY };
      drag.current = null;
      cancelAnimationFrame(frame);
      const scroller = root.current?.querySelector<HTMLElement>('.pdf-canvas-wrap');
      const points = { anchor: { x: start.x - ((scroller?.scrollLeft || 0) - start.scrollX), y: start.y - ((scroller?.scrollTop || 0) - start.scrollY) }, focus: finish };
      frame = requestAnimationFrame(() => { void (async () => {
        if (root.current) setPdfSelectionFromPoints(root.current, points.anchor, points.focus);
        const pages = root.current ? selectedPdfPages(root.current) : [];
        setPins(old => [...new Set([...old, ...pages])]);
        // A fast cross-page drag can extend through recycled page placeholders.
        // Keep every covered layer mounted until PDF.js has supplied its text;
        // otherwise a snapshot would silently omit intermediate pages.
        const deadline = performance.now() + 8000;
        const pending = () => pages.some(number => !Number(root.current?.querySelector<HTMLElement>(`[data-pdf-page="${number}"] .textLayer`)?.dataset.textRevision));
        while (token === generation.current && pending() && performance.now() < deadline) await new Promise(resolve => window.setTimeout(resolve, 20));
        if (token !== generation.current) return;
        if (pending()) { clear(); latest.current.onMessage('所选页面的文字尚未载入，请待页面显示完成后重新选择。'); return; }
        if (root.current) setPdfSelectionFromPoints(root.current, points.anchor, points.focus);
        collect(start, event); setPins([]);
      })(); });
    };
    const cancel = () => { cancelAnimationFrame(frame); clear(); };
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
    window.addEventListener('pointerdown', down, true); window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel); window.addEventListener('keyup', keyUp);
    window.addEventListener('copy', copy); window.document.addEventListener('selectionchange', pin);
    return () => {
      generation.current += 1;
      cancelAnimationFrame(frame); window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('keyup', keyUp);
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
      if (outcome.done) clear();
      else { setResult(outcome); if (outcome.error) current.onMessage(outcome.error); }
    } catch (error) { if (draftRef.current?.id === selected.id) current.onMessage(`PDF 文字操作失败：${String(error)}`); }
    finally { lock.current = false; setBusy(false); }
  }
  async function copy() {
    const value = draftRef.current; if (!value || latest.current.pdf?.data !== value.documentKey) return;
    try { await navigator.clipboard.writeText(value.quote); }
    catch (error) { latest.current.onMessage(`复制失败，请使用 Ctrl+C：${String(error)}`); }
  }
  return { draft: draft?.documentKey === pdf?.data ? draft : null, pins, busy, result, clear, act, copy };
}
