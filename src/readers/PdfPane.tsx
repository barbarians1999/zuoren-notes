import React, { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OutlinePanel } from '../OutlinePanel';
import { BookOpen, ChevronLeft, ChevronRight, Copy, Crop, FileText, List, Highlighter, Maximize2, MessageSquare, MousePointer2, Search, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { PdfAnchor, PdfAnnotation, PdfMeta, PdfRect } from '../types';
import { reader, type ActivePdf, type OcrDialog } from '../readerContext';
import * as pdfjsLib from 'pdfjs-dist';
import type { OcrProgress } from '../types';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { findPdfPageMatches, pdfPageText, type PdfSearchMatch } from '../pdfSearch';
import { stepMatchIndex } from '../findReplace';
import { domRangeForMatch, findDomMatch } from '../editor/domFind';
import { cleanPdfRects, pdfRangeRects, visiblePdfHighlightRects, type PdfSelectedPage } from './pdfSelection';
import type { PdfTextActionHandler } from './pdfTextAction';
import { usePdfSelection } from './usePdfSelection';
import { PdfPopover } from './PdfPopover';
import { ActionButton } from '../ui/ActionButton';
import { ResponsiveToolGroup } from '../ui/ResponsiveToolGroup';
import { DialogFrame } from '../ui/overlays';
import { ReducedMotionContext, usePanelMotion } from '../uiMotion';
import { createPdfRegionAction, type PdfExcerptContext, type PdfRegionAction } from './pdfRegionAction';
import type { ExcerptFlowResult } from './excerptFlow';
import { groupedPdfImages, paintPdfAppearance } from './pdfAppearance';
import { findVisiblePdfPage } from './pdfScroll';
import { PdfBitmapCache, pdfBitmapCacheKey } from './pdfBitmapCache';
import { PdfRenderQueue } from './pdfRenderQueue';

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];
type PdfSearchSpec = { query: string; occurrence: number; caseSensitive: boolean };
type SlotObserverRegister = (element: HTMLElement, onVisibility: (visible: boolean) => void) => () => void;
type WaitForScrollIdle = (bypass: boolean) => { promise: Promise<void>; cancel: () => void };
type LazyPdfRaster = { source: HTMLCanvasElement | null; images: ArrayLike<number> | null; pdfPage: any; viewport: any; fromDarkCache?: boolean };

function clonePdfCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = source.ownerDocument.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext('2d')?.drawImage(source, 0, 0);
  return copy;
}
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
// PDF.js 6 loads JBIG2/OpenJPEG/ICC decoders on demand.  The desktop build
// runs from a file:// URL, so leaving wasmUrl unset makes the fallback module
// resolve as a bare (and invalid) module specifier.  Keep the decoder bundle
// beside the app's renderer assets and give PDF.js an explicit directory URL.
const pdfWasmUrl = new URL('pdfjs/wasm/', document.baseURI).toString();
type PdfTool = 'select' | 'highlight' | 'region' | 'note';
export function PdfPane({ dark, pdf, page, setPage, scale, setScale, fullscreen, onToggleFullscreen, onMeta, captureExcerpt, onTextAction, canExcerpt, target, onMessage, onActivate, headerTarget = null }: { dark: boolean; pdf: ActivePdf | null; page: number; setPage: (page: number) => void; scale: number; setScale: (scale: number) => void; fullscreen: boolean; onToggleFullscreen: () => void; onMeta: (change: (current: PdfMeta) => PdfMeta) => Promise<boolean>; captureExcerpt: (source: ActivePdf) => PdfExcerptContext | null; onTextAction: PdfTextActionHandler; canExcerpt: boolean; target: PdfAnchor | null; onMessage: (message: string) => void; onActivate: () => void; headerTarget?: HTMLElement | null }) {
  const [loadedDocument, setLoadedDocument] = useState<{ path: string; id: string; document: any } | null>(null);
  // A path change renders before effects dispose the old worker. Never mount
  // the new file's page slots with a document proxy owned by the previous file.
  const document = loadedDocument?.path === pdf?.path && loadedDocument?.id === pdf?.meta.id ? loadedDocument?.document : null;
  const [pages, setPages] = useState(0), [tool, setTool] = useState<PdfTool>('select');
  const [pageDraft, setPageDraft] = useState(String(page));
  const [toc, setToc] = useState<{ title: string; depth: number; dest: any }[]>([]), [showToc, setShowToc] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false), [searchText, setSearchText] = useState('');
  const [searchCase, setSearchCase] = useState(false), [searching, setSearching] = useState(false);
  const [searchMatches, setSearchMatches] = useState<PdfSearchMatch[]>([]), [searchIndex, setSearchIndex] = useState(-1);
  const [searchStatus, setSearchStatus] = useState({ processed: 0, totalPages: 0, totalMatches: 0, errors: 0, truncated: false });
  const [size, setSize] = useState({ width: 595, height: 842 });
  const reducedMotion = useContext(ReducedMotionContext);
  const pane = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null), searchTrigger = useRef<HTMLButtonElement>(null), pageInput = useRef<HTMLInputElement>(null);
  const searchMotion = usePanelMotion(searchOpen, reducedMotion, '4px', () => searchTrigger.current || pane.current, 'y', { enter: '--motion-feedback', exit: '--motion-exit' });
  const [annotationMenu, setAnnotationMenu] = useState<{ id: string; key: object } | null>(null);
  const textSelection = usePdfSelection({ pdf, root: pane, tool, onTextAction, onMessage, onStart: () => setAnnotationMenu(null),
    onClickPoint: (x, y, element) => {
      const holder = element.closest('.canvas-holder'), number = Number(holder?.closest<HTMLElement>('[data-pdf-page]')?.dataset.pdfPage);
      const bounds = holder?.getBoundingClientRect(); if (!bounds || !pdf) return;
      const px = (x - bounds.left) / bounds.width, py = (y - bounds.top) / bounds.height;
      const hit = [...pdf.meta.annotations].reverse().find(item => item.anchor.page === number && item.anchor.rects.some(rect => px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h));
      setAnnotationMenu(hit ? { id: hit.id, key: pdf.data } : null);
    },
  });
  const menuAnnotation = annotationMenu && annotationMenu.key === pdf?.data ? pdf?.meta.annotations.find(item => item.id === annotationMenu.id) : null;
  const visibleRect = (selector: string) => {
    const viewport = pane.current?.querySelector('.pdf-canvas-wrap')?.getBoundingClientRect();
    const rects = [...pane.current?.querySelectorAll<HTMLElement>(selector) || []].map(item => item.getBoundingClientRect());
    return viewport ? rects.filter(rect => rect.bottom >= viewport.top && rect.top <= viewport.bottom && rect.right >= viewport.left && rect.left <= viewport.right).at(-1) || null : null;
  };
  const clearSelectionRef = useRef(textSelection.clear); clearSelectionRef.current = textSelection.clear;
  const showAnnotation = useCallback((id: string) => {
    clearSelectionRef.current();
    const data = latest.current.pdf?.data;
    if (data) setAnnotationMenu({ id, key: data });
  }, []);
  const scroll = useRef<HTMLDivElement>(null), lastPage = useRef(0), searchGeneration = useRef(0);
  const scrollRaf = useRef(0);
  const scrollingRef = useRef(false);
  const scrollIdleTimer = useRef<number | null>(null);
  const scrollIdleWaiters = useRef(new Set<() => void>());
  const scrolledStateRef = useRef<{ scrolled: boolean; immersive: boolean } | null>(null);
  const searchOpenRef = useRef(searchOpen); searchOpenRef.current = searchOpen;
  const slotCallbacks = useRef(new Map<Element, (visible: boolean) => void>());
  const slotObserver = useRef<IntersectionObserver | null>(null);
  const pageSizeCache = useRef(new Map<number, { width: number; height: number }>());
  const bitmapCache = useRef(new PdfBitmapCache());
  const renderQueue = useRef(new PdfRenderQueue(2, () => lastPage.current || 1));
  const zoomAnchor = useRef<{ page: number; ratio: number; scale: number; token: number } | null>(null);
  const zoomToken = useRef(0), restoringZoom = useRef(false);
  const pageTextCache = useRef(new Map<number, string>());
  const pageTextErrors = useRef(new Set<number>());
  const latest = useRef({ pdf, onMeta }); latest.current = { pdf, onMeta };
  const captureCurrentExcerpt = useCallback(() => latest.current.pdf ? captureExcerpt(latest.current.pdf) : null, [captureExcerpt]);
  const flushScrollWaiters = useCallback(() => {
    scrollingRef.current = false;
    const waiters = [...scrollIdleWaiters.current];
    scrollIdleWaiters.current.clear();
    for (const wake of waiters) wake();
  }, []);
  const waitForScrollIdle = useCallback<WaitForScrollIdle>(bypass => {
    if (bypass || !scrollingRef.current) return { promise: Promise.resolve(), cancel: () => {} };
    let done = () => {};
    const promise = new Promise<void>(resolve => {
      done = () => {
        scrollIdleWaiters.current.delete(done);
        resolve();
      };
      scrollIdleWaiters.current.add(done);
    });
    return { promise, cancel: done };
  }, []);
  const observeSlot = useCallback<SlotObserverRegister>((element, onVisibility) => {
    if (!slotObserver.current) {
      slotObserver.current = new IntersectionObserver(entries => {
        for (const entry of entries) slotCallbacks.current.get(entry.target)?.(entry.isIntersecting);
      }, { root: scroll.current, rootMargin: '900px' });
    }
    slotCallbacks.current.set(element, onVisibility);
    slotObserver.current.observe(element);
    return () => {
      slotCallbacks.current.delete(element);
      slotObserver.current?.unobserve(element);
    };
  }, []);
  useEffect(() => () => {
    if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
    if (scrollIdleTimer.current !== null) window.clearTimeout(scrollIdleTimer.current);
    flushScrollWaiters();
    renderQueue.current.clear();
    bitmapCache.current.clear();
    slotObserver.current?.disconnect();
    slotObserver.current = null;
    slotCallbacks.current.clear();
  }, [flushScrollWaiters]);
  // Undo belongs to the document, not a virtualized page that may unmount.
  const [deletedAnnotation, setDeletedAnnotation] = useState<{ annotation: PdfAnnotation; index: number; path: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletionLock = useRef<object | null>(null);
  const [ocrPages, setOcrPages] = useState<number[]>([]);
  const setOcrPageActive = useCallback((pageNumber: number, active: boolean) => {
    setOcrPages(current => active ? (current.includes(pageNumber) ? current : [...current, pageNumber]) : current.filter(item => item !== pageNumber));
  }, []);
  useEffect(() => { setDeletedAnnotation(null); setOcrPages([]); }, [pdf?.path, pdf?.meta.id]);
  useEffect(() => { setOcrPages([]); }, [pdf?.data]);
  useEffect(() => {
    if (!deletedAnnotation || deleting) return;
    const timer = window.setTimeout(() => setDeletedAnnotation(null), 7000);
    return () => window.clearTimeout(timer);
  }, [deletedAnnotation, deleting]);
  const sameDocument = (path: string, id: string) => latest.current.pdf?.path === path && latest.current.pdf?.meta.id === id;
  async function removeAnnotation(id: string) {
    const current = latest.current;
    if (!current.pdf || deletionLock.current) return;
    const index = current.pdf.meta.annotations.findIndex(annotation => annotation.id === id);
    const annotation = current.pdf.meta.annotations[index];
    if (!annotation) return;
    const path = current.pdf.path, token = {};
    deletionLock.current = token; setDeleting(true);
    try {
      if (!(await current.onMeta(meta => ({ ...meta, annotations: meta.annotations.filter(item => item.id !== id) })))) return;
      if (sameDocument(path, annotation.anchor.pdfId)) setAnnotationMenu(null);
      if (sameDocument(path, annotation.anchor.pdfId)) setDeletedAnnotation({ annotation, index, path });
    } catch (error) { onMessage(`删除 PDF 标记失败：${String(error)}`); }
    finally { if (deletionLock.current === token) { deletionLock.current = null; setDeleting(false); } }
  }
  async function undoDelete() {
    const deleted = deletedAnnotation, current = latest.current;
    if (!deleted || deletionLock.current || !sameDocument(deleted.path, deleted.annotation.anchor.pdfId)) return;
    const token = {}; deletionLock.current = token; setDeleting(true);
    try {
      const saved = await current.onMeta(meta => {
        if (meta.annotations.some(item => item.id === deleted.annotation.id)) return meta;
        const annotations = [...meta.annotations];
        annotations.splice(Math.max(0, Math.min(deleted.index, annotations.length)), 0, deleted.annotation);
        return { ...meta, annotations };
      });
      if (saved && sameDocument(deleted.path, deleted.annotation.anchor.pdfId)) setDeletedAnnotation(value => value === deleted ? null : value);
    } catch (error) { onMessage(`撤销 PDF 删除失败：${String(error)}`); }
    finally { if (deletionLock.current === token) { deletionLock.current = null; setDeleting(false); } }
  }
  useEffect(() => {
    setLoadedDocument(null); setPages(0); setToc([]); setSearchMatches([]); setSearchIndex(-1); setSearching(false); setSearchStatus({ processed: 0, totalPages: 0, totalMatches: 0, errors: 0, truncated: false }); pageTextCache.current.clear(); pageTextErrors.current.clear(); pageSizeCache.current.clear(); bitmapCache.current.clear(); renderQueue.current.clear(); if (scrollIdleTimer.current !== null) { window.clearTimeout(scrollIdleTimer.current); scrollIdleTimer.current = null; } flushScrollWaiters(); lastPage.current = 0; zoomToken.current += 1; zoomAnchor.current = null; restoringZoom.current = false; searchGeneration.current += 1;
    slotObserver.current?.disconnect(); slotObserver.current = null; slotCallbacks.current.clear();
    if (!pdf) return;
    let disposed = false;
    const bytes = pdf.data instanceof Uint8Array ? new Uint8Array(pdf.data) : new Uint8Array(pdf.data as ArrayBufferLike);
    const task = pdfjsLib.getDocument({ data: bytes, wasmUrl: pdfWasmUrl, useWasm: true });
    void task.promise.then(async doc => {
      if (disposed) return;
      const first = await doc.getPage(1); const viewport = first.getViewport({ scale: 1 });
      if (disposed) return;
      setSize({ width: viewport.width, height: viewport.height }); setLoadedDocument({ path: pdf.path, id: pdf.meta.id, document: doc }); setPages(doc.numPages);
      const flatten = (items: any[], depth = 0): { title: string; depth: number; dest: any }[] => items.flatMap(item => [{ title: item.title, depth, dest: item.dest }, ...flatten(item.items || [], depth + 1)]);
      const outline = await doc.getOutline(); if (!disposed) setToc(flatten(outline || []));
    }).catch(error => { if (!disposed) onMessage('PDF 无法显示：' + error.message); });
    return () => { disposed = true; void task.destroy().catch(() => undefined); };
  }, [pdf?.path, pdf?.meta.id]);
  const pageAtProbe = () => {
    const host = scroll.current;
    const fallback = Math.max(1, page);
    if (!host) return { page: fallback, ratio: 0 };
    const probe = host.getBoundingClientRect().top + 80;
    const visible = findVisiblePdfPage(host, probe);
    // Prefer the page actually under the reading probe. The page field can
    // briefly lag during navigation, and using that stale value would make
    // Ctrl+wheel anchor zoom to the previous page.
    const element = visible || host.querySelector<HTMLElement>('[data-pdf-page="' + fallback + '"]');
    const pageNumber = Number(element?.dataset.pdfPage) || fallback;
    const bounds = element?.getBoundingClientRect();
    const ratio = bounds && bounds.height > 0 ? Math.min(1, Math.max(0, (probe - bounds.top) / bounds.height)) : 0;
    return { page: pageNumber, ratio };
  };
  const requestScale = (requested: number) => {
    const pending = zoomAnchor.current;
    const next = Math.round(Math.min(3, Math.max(.5, requested)) * 100) / 100;
    const current = pending?.scale ?? scale;
    if (Math.abs(next - current) < .001) return;
    const anchor = pending || { ...pageAtProbe(), scale: next, token: 0 };
    zoomAnchor.current = { ...anchor, scale: next, token: ++zoomToken.current };
    restoringZoom.current = true;
    lastPage.current = anchor.page;
    setScale(next);
  };
  useEffect(() => {
    const host = scroll.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      requestScale((zoomAnchor.current?.scale ?? scale) + (event.deltaY < 0 ? .15 : -.15));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [scale]);
  const jump = (number: number, cancelZoom = true) => {
    if (cancelZoom) { zoomToken.current += 1; zoomAnchor.current = null; restoringZoom.current = false; }
    const next = Math.max(1, Math.min(pages, number));
    const host = scroll.current;
    if (host) {
      if (next === 1) host.scrollTop = 0;
      else host.querySelector<HTMLElement>('[data-pdf-page="' + next + '"]')?.scrollIntoView({ block: 'start' });
      syncScrolledState(next > 1 && host.scrollTop > 42, searchOpen);
    }
    lastPage.current = next; setPage(next);
  };
  useEffect(() => { if (pages && lastPage.current !== page && !restoringZoom.current) jump(page); }, [page, pages]);
  useEffect(() => { if (target && pages) jump(target.page); }, [target, pages]);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    if (!anchor || Math.abs(anchor.scale - scale) > .001) return;
    const token = anchor.token;
    const restore = () => {
      const current = zoomAnchor.current;
      const host = scroll.current;
      const pageElement = host?.querySelector<HTMLElement>('[data-pdf-page="' + anchor.page + '"]');
      if (!current || current.token !== token || Math.abs(current.scale - scale) > .001 || !host || !pageElement) return false;
      const probe = host.getBoundingClientRect().top + 80;
      const bounds = pageElement.getBoundingClientRect();
      const targetTop = probe - current.ratio * bounds.height;
      const delta = bounds.top - targetTop;
      if (Math.abs(delta) > .5) host.scrollTop += delta;
      return true;
    };
    let firstFrame = 0, secondFrame = 0, finishTimer: number | undefined;
    restore();
    firstFrame = requestAnimationFrame(() => {
      if (!restore()) return;
      secondFrame = requestAnimationFrame(() => {
        if (!restore()) return;
        lastPage.current = anchor.page;
        if (page !== anchor.page) setPage(anchor.page);
        // A scroll event can be delivered one frame after the last layout
        // adjustment. Keep the guard up briefly so it cannot overwrite the
        // page restored with the zoom anchor.
        finishTimer = window.setTimeout(() => {
          const current = zoomAnchor.current;
          if (!current || current.token !== token) return;
          lastPage.current = anchor.page;
          setPage(anchor.page);
          zoomAnchor.current = null;
          restoringZoom.current = false;
        }, 80);
      });
    });
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); if (finishTimer !== undefined) window.clearTimeout(finishTimer); };
  }, [page, scale]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
      const origin = event.target instanceof Node ? event.target : window.document.activeElement;
      if (!origin || (!pane.current?.contains(origin) && !searchTrigger.current?.parentElement?.contains(origin))) return;
      if (origin instanceof Element && origin.closest('[aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation(); setSearchOpen(true);
      requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  useEffect(() => {
    const generation = ++searchGeneration.current;
    const query = searchText.trim();
    if (!document || !searchOpen || !query) { setSearchMatches([]); setSearchIndex(-1); setSearching(false); setSearchStatus({ processed: 0, totalPages: document?.numPages || 0, totalMatches: 0, errors: 0, truncated: false }); return; }
    setSearching(true); setSearchMatches([]); setSearchIndex(-1); setSearchStatus({ processed: 0, totalPages: document.numPages, totalMatches: 0, errors: 0, truncated: false });
    const timer = window.setTimeout(() => { void (async () => {
      const found: PdfSearchMatch[] = [];
      let totalMatches = 0, errors = 0;
      try {
        for (let first = 1; first <= document.numPages; first += 8) {
          const numbers = Array.from({ length: Math.min(8, document.numPages - first + 1) }, (_, offset) => first + offset);
          const pagesInBatch = await Promise.all(numbers.map(async number => {
            const cached = pageTextCache.current.get(number);
            if (cached !== undefined) return { number, text: cached, error: pageTextErrors.current.has(number) };
            try {
              const pdfPage = await document.getPage(number);
              const content = await pdfPage.getTextContent();
              const text = pdfPageText(content.items || []);
              pageTextCache.current.set(number, text);
              return { number, text, error: false };
            } catch { pageTextCache.current.set(number, ''); pageTextErrors.current.add(number); return { number, text: '', error: true }; }
          }));
          if (generation !== searchGeneration.current) return;
          for (const item of pagesInBatch) {
            if (item.error) { errors += 1; continue; }
            const matches = findPdfPageMatches(item.text, query, searchCase);
            totalMatches += matches.length;
            for (let occurrence = 0; occurrence < matches.length && found.length < 5000; occurrence += 1) {
              found.push({ page: item.number, occurrence, stableKey: `${item.number}:${occurrence}`, ...matches[occurrence] });
            }
          }
          setSearchMatches([...found]);
          if (found.length) setSearchIndex(index => index < 0 ? 0 : index);
          setSearchStatus({ processed: Math.min(document.numPages, first + numbers.length - 1), totalPages: document.numPages, totalMatches, errors, truncated: totalMatches > 5000 });
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        }
      } catch (error) { if (generation === searchGeneration.current) onMessage(`PDF 搜索失败：${error instanceof Error ? error.message : String(error)}`); }
      finally { if (generation === searchGeneration.current) setSearching(false); }
    })(); }, 220);
    return () => window.clearTimeout(timer);
  }, [document, searchOpen, searchText, searchCase]);
  const currentSearch = searchIndex >= 0 ? searchMatches[searchIndex] || null : null;
  useEffect(() => {
    if (!textSelection.draft) return;
    const dismissBodySelection = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.target !== window.document.body) return;
      const selection = window.getSelection();
      if (!selection?.anchorNode || !pane.current?.contains(selection.anchorNode)) return;
      textSelection.clear(); event.preventDefault(); event.stopPropagation();
    };
    window.document.addEventListener('keydown', dismissBodySelection);
    return () => window.document.removeEventListener('keydown', dismissBodySelection);
  }, [textSelection.draft, textSelection.clear]);
  useEffect(() => {
    if (window.document.activeElement !== pageInput.current) setPageDraft(String(page));
  }, [page]);
  useEffect(() => { if (currentSearch) jump(currentSearch.page); }, [currentSearch?.page, currentSearch?.occurrence]);
  useEffect(() => {
    if (!pdf || !pages) return;
    const flush = () => { const current = latest.current; if (current.pdf && current.pdf.meta.page !== page) void current.onMeta(meta => ({ ...meta, page })); };
    const timer = window.setTimeout(flush, 450);
    window.addEventListener('reader-flush', flush);
    return () => { clearTimeout(timer); window.removeEventListener('reader-flush', flush); };
  }, [page, pages, pdf?.path]);
  const syncScrolledState = useCallback((scrolled: boolean, searchIsOpen: boolean) => {
    const node = pane.current;
    if (!node) return;
    const nextScrolled = !!latest.current.pdf && scrolled;
    const nextImmersive = nextScrolled && !searchIsOpen;
    const previous = scrolledStateRef.current;
    if (previous && previous.scrolled === nextScrolled && previous.immersive === nextImmersive) return;
    scrolledStateRef.current = { scrolled: nextScrolled, immersive: nextImmersive };
    node.dataset.pdfScrolled = nextScrolled ? 'true' : 'false';
    node.dataset.pdfImmersive = nextImmersive ? 'true' : 'false';
    const appNode = node.closest<HTMLElement>('.app');
    if (appNode) {
      if (nextImmersive) appNode.dataset.pdfImmersive = 'true';
      else delete appNode.dataset.pdfImmersive;
    }
  }, []);
  const onPdfScroll = useCallback(() => {
    const host = scroll.current; if (!host) return;
    scrollingRef.current = true;
    if (scrollIdleTimer.current !== null) window.clearTimeout(scrollIdleTimer.current);
    scrollIdleTimer.current = window.setTimeout(() => {
      scrollIdleTimer.current = null;
      flushScrollWaiters();
    }, 90);
    syncScrolledState(host.scrollTop > 42, searchOpenRef.current);
    if (restoringZoom.current || scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const currentHost = scroll.current;
      if (!currentHost || restoringZoom.current) return;
      const top = currentHost.getBoundingClientRect().top;
      const visible = findVisiblePdfPage(currentHost, top + 80);
      const number = Number(visible?.dataset.pdfPage);
      if (number && number !== lastPage.current) { lastPage.current = number; setPage(number); }
    });
  }, [flushScrollWaiters, syncScrolledState]);
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, PdfAnnotation[]>();
    for (const annotation of pdf?.meta.annotations || EMPTY_ANNOTATIONS) {
      const list = map.get(annotation.anchor.page);
      if (list) list.push(annotation);
      else map.set(annotation.anchor.page, [annotation]);
    }
    return map;
  }, [pdf?.meta.annotations]);
  const textSelectionByPage = useMemo(() => {
    const map = new Map<number, PdfSelectedPage>();
    for (const part of textSelection.draft?.pages || []) map.set(part.page, part);
    return map;
  }, [textSelection.draft]);
  const currentSearchSpec = useMemo<PdfSearchSpec | null>(
    () => currentSearch ? { query: searchText.trim(), occurrence: currentSearch.occurrence, caseSensitive: searchCase } : null,
    [currentSearch?.page, currentSearch?.occurrence, searchText, searchCase],
  );
  useEffect(() => {
    const node = pane.current;
    if (!node) return;
    scrolledStateRef.current = null;
    if (!pdf) {
      delete node.dataset.pdfScrolled;
      delete node.dataset.pdfImmersive;
      delete node.closest<HTMLElement>('.app')?.dataset.pdfImmersive;
      return;
    }
    const host = scroll.current;
    syncScrolledState(!!(host && host.scrollTop > 42), searchOpen);
    return () => { scrolledStateRef.current = null; delete node.closest<HTMLElement>('.app')?.dataset.pdfImmersive; };
  }, [pdf?.path, searchOpen, syncScrolledState]);
  useEffect(() => {
    const host = scroll.current;
    if (!host) return;
    const syncOverflow = () => {
      host.dataset.hScroll = host.scrollWidth > host.clientWidth + 1 ? 'true' : 'false';
    };
    syncOverflow();
    const raf = window.requestAnimationFrame(syncOverflow);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(syncOverflow) : null;
    observer?.observe(host);
    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      delete host.dataset.hScroll;
    };
  }, [pdf?.path, pages, scale]);
  async function goToDestination(dest: any) {
    const source = document, identity = pdf?.data;
    if (!source || !identity) return;
    try {
      const resolved = typeof dest === 'string' ? await source.getDestination(dest) : dest;
      if (!resolved) return;
      const index = typeof resolved[0] === 'number' ? resolved[0] : await source.getPageIndex(resolved[0]);
      if (latest.current.pdf?.data === identity) jump(index + 1);
    } catch (error) { if (latest.current.pdf?.data === identity) onMessage('目录位置无法读取：' + String(error)); }
  }
  const submitPageDraft = () => {
    const parsed = Number(pageDraft.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || (pages > 0 && parsed > pages)) {
      setPageDraft(String(page));
      return;
    }
    jump(parsed);
    setPageDraft(String(Math.max(1, Math.min(pages || parsed, parsed))));
  };
  const headerToolbar = <div className="pane-toolbar pdf-top-bar" data-empty={!pdf ? 'true' : undefined} role="group" aria-label="PDF 阅读操作" title={pdf?.name || 'PDF 阅读工具'}>
    {pdf && headerTarget && <div className="document-tab active reader-tab pdf-doc-pill" title={pdf.path}><FileText size={13}/><span className="tab-file-name">{pdf.name}</span>{pdf.meta.annotations.length > 0 && <span className="pdf-annotation-badge" title={`${pdf.meta.annotations.length} 处标注`}>{pdf.meta.annotations.length}</span>}</div>}
    <span className="toolbar-spacer"/>
    <div className="pdf-top-actions">
      <button ref={searchTrigger} className="icon-button" aria-label="在 PDF 中查找" title="在 PDF 中查找（Ctrl+F）" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }}><Search size={16}/></button>
      {!fullscreen && <button className="icon-button" aria-pressed={false} title="进入全屏阅读" aria-label="进入全屏阅读" onClick={onToggleFullscreen}><Maximize2 size={17}/></button>}
      <button data-pdf-outline-toggle className={'icon-button' + (showToc ? ' active' : '')} aria-pressed={showToc} aria-expanded={showToc} aria-label={showToc ? '收起 PDF 大纲' : '展开 PDF 大纲'} title={pdf ? `${pdf.name}\n${showToc ? '收起大纲' : '展开大纲'}` : '展开大纲'} onClick={() => setShowToc(value => !value)}><List size={17}/></button>
    </div>
  </div>;
  const dockToolbar = pdf ? <div className="pane-toolbar pdf-navigation pdf-bottom-dock" role="group" aria-label="PDF 阅读工具" title={pdf.name}>
    <div className="toolbar-group pdf-page-navigation">
      <button className="icon-button" title="上一页（← / PageUp）" aria-label="上一页" onClick={() => jump(page - 1)}><ChevronLeft size={18}/></button>
      <span className="page-control"><span className="page-word">第</span><input ref={pageInput} aria-label="当前页码" inputMode="numeric" value={pageDraft} onChange={event => setPageDraft(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter') { event.preventDefault(); submitPageDraft(); } else if (event.key === 'Escape') { event.preventDefault(); setPageDraft(String(page)); (event.target as HTMLInputElement).blur(); } }} onBlur={() => setPageDraft(String(page))}/><span>/ {pages || '…'}<span className="page-word"> 页</span></span></span>
      <button className="icon-button" title="下一页（→ / PageDown）" aria-label="下一页" onClick={() => jump(page + 1)}><ChevronRight size={18}/></button>
    </div>
    <span className="dock-sep" aria-hidden="true"/>
    <ResponsiveToolGroup container={pane} label="PDF 标记工具">
      <button aria-label="选择" title="选择文本" aria-pressed={tool === 'select'} className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}><MousePointer2 size={16}/><span>选择</span></button>
      <button aria-label="文字高亮" title="文字高亮" aria-pressed={tool === 'highlight'} className={tool === 'highlight' ? 'on' : ''} onClick={() => setTool('highlight')}><Highlighter size={16}/><span>文字高亮</span></button>
      <button aria-label="框选" title="框选" aria-pressed={tool === 'region'} className={tool === 'region' ? 'on' : ''} onClick={() => setTool('region')}><Crop size={16}/><span>框选</span></button>
      <button aria-label="批注" title="批注" aria-pressed={tool === 'note'} className={tool === 'note' ? 'on' : ''} onClick={() => setTool('note')}><MessageSquare size={16}/><span>批注</span></button>
    </ResponsiveToolGroup>
    <span className="dock-sep" aria-hidden="true"/>
    <div className="toolbar-group zoom-control"><button className="icon-button" title="缩小" aria-label="缩小" onClick={() => requestScale((zoomAnchor.current?.scale ?? scale) - .15)}><ZoomOut size={17}/></button><span>{Math.round(scale * 100)}%</span><button className="icon-button" title="放大" aria-label="放大" onClick={() => requestScale((zoomAnchor.current?.scale ?? scale) + .15)}><ZoomIn size={17}/></button></div>
  </div> : null;
  return <section className={'pane pdf-pane' + (textSelection.draft ? ' pdf-text-selected' : '')} ref={pane} tabIndex={-1} onFocusCapture={onActivate} onPointerDownCapture={event => { onActivate(); if (!(event.target instanceof Element) || !event.target.closest('button, input, textarea')) pane.current?.focus({ preventScroll: true }); }} onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest('input, textarea, select'))) return;
    if (event.key === 'Escape') { textSelection.clear(); setAnnotationMenu(null); event.preventDefault(); event.stopPropagation(); return; }
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const host = scroll.current;
      // Do not steal the outline/menu's arrow navigation. Clicking the page
      // focuses the pane without moving its viewport; descendants also work.
      if (!document || !host || !(event.target instanceof Node) || (event.target !== pane.current && !host.contains(event.target))) return;
      event.preventDefault(); event.stopPropagation();
      // Explicit scrolling wins over a pending zoom position restoration.
      zoomToken.current += 1; zoomAnchor.current = null; restoringZoom.current = false;
      host.scrollTop += event.key === 'ArrowDown' ? 64 : -64;
      return;
    }
    if (event.key === 'PageDown' || event.key === 'ArrowRight') { event.preventDefault(); jump(page + 1); }
    if (event.key === 'PageUp' || event.key === 'ArrowLeft') { event.preventDefault(); jump(page - 1); }
    if (event.key === 'Home') { event.preventDefault(); jump(1); }
    if (event.key === 'End' && pages) { event.preventDefault(); jump(pages); }
  }}>
    {headerTarget ? createPortal(headerToolbar, headerTarget) : headerToolbar}
    {searchMotion.present && <div ref={searchMotion.ref as React.RefObject<HTMLDivElement | null>} className="pdf-find-bar" role="search" aria-label="查找当前 PDF" aria-hidden={!searchOpen}><Search size={15}/><input ref={searchInput} aria-label="PDF 查找文本" placeholder="在这份 PDF 中查找" value={searchText} onChange={event => setSearchText(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Escape') { setSearchOpen(false); setSearchText(''); pane.current?.focus(); } else if (event.key === 'Enter' && searchMatches.length) setSearchIndex(index => stepMatchIndex(searchMatches.length, index, event.shiftKey ? -1 : 1)); }}/><span className="pdf-find-progress" aria-live="polite">{searching ? `已检索 ${searchStatus.processed}/${searchStatus.totalPages} 页` : searchStatus.errors ? `${searchStatus.errors} 页无法提取文字` : ''}</span><span className="find-count" aria-live="polite">{searching ? `${searchStatus.totalMatches} 项` : searchStatus.totalMatches ? (searchStatus.truncated ? `${searchIndex + 1} / 5000 · 共 ${searchStatus.totalMatches}` : `${searchIndex + 1} / ${searchStatus.totalMatches}`) : '0 / 0'}</span><button className={searchCase ? 'selected' : ''} aria-label="PDF 搜索区分大小写" aria-pressed={searchCase} title="区分大小写" onClick={() => setSearchCase(value => !value)}>Aa</button><button aria-label="上一个 PDF 匹配" disabled={!searchMatches.length} onClick={() => setSearchIndex(index => stepMatchIndex(searchMatches.length, index, -1))}>↑</button><button aria-label="下一个 PDF 匹配" disabled={!searchMatches.length} onClick={() => setSearchIndex(index => stepMatchIndex(searchMatches.length, index, 1))}>↓</button><button aria-label="关闭 PDF 查找" title="关闭（Esc）" onClick={() => { setSearchOpen(false); setSearchText(''); pane.current?.focus(); }}>×</button></div>}

    <div className="pdf-reader-body">
      <div className="pdf-viewport-stage">
        <div className="pdf-canvas-wrap continuous-pdf" ref={scroll} onScroll={onPdfScroll}>
          {!pdf ? <div className="empty-state"><BookOpen size={28}/><p>打开 PDF 或 EPUB 开始阅读</p></div> : !document ? <div className="empty-state">正在载入 PDF…</div> : Array.from({ length: pages }, (_, index) => {
            const pageNumber = index + 1;
            const isPinned = textSelection.pins.includes(pageNumber) || ocrPages.includes(pageNumber);
            return <PdfPageSlot
              key={pdf.path + index}
              document={document}
              number={pageNumber}
              scale={scale}
              size={size}
              observeSlot={observeSlot}
              pageSizeCache={pageSizeCache}
              bitmapCache={bitmapCache}
              renderQueue={renderQueue}
              waitForScrollIdle={waitForScrollIdle}
              pinned={isPinned}
              dark={dark}
              pdfPath={pdf.path}
              pdfData={pdf.data}
              pdfId={pdf.meta.id}
              pageAnnotations={annotationsByPage.get(pageNumber) || EMPTY_ANNOTATIONS}
              onMeta={onMeta}
              onShowAnnotation={showAnnotation}
              deleting={deleting}
              captureExcerpt={captureCurrentExcerpt}
              targetActive={!!target && target.pdfId === pdf.meta.id && target.page === pageNumber}
              onMessage={onMessage}
              tool={tool}
              onOcrChange={setOcrPageActive}
              textSelection={textSelectionByPage.get(pageNumber) || null}
              search={currentSearch?.page === pageNumber ? currentSearchSpec : null}
            />;
          })}
        </div>
        {dockToolbar}
      </div>
      <OutlinePanel open={showToc} label="PDF 大纲" className="pdf-outline" emptyText={pdf ? '正在读取大纲…' : '请先打开 PDF。'}
        introduction={pages > 0 && !toc.length ? '这份 PDF 没有内置目录，可按页跳转。' : undefined}
        onClose={() => setShowToc(false)}
        returnFocus={() => headerTarget?.querySelector<HTMLElement>('[data-pdf-outline-toggle]') || pane.current?.querySelector<HTMLElement>('[data-pdf-outline-toggle]') || null}
        items={toc.length ? toc.map((item, index) => ({ id: String(index), label: item.title, depth: item.depth })) :
          Array.from({ length: pages }, (_, index) => ({ id: String(index), label: `第 ${index + 1} 页`, depth: 0, active: page === index + 1 }))}
        onSelect={item => { if (toc.length) void goToDestination(toc[Number(item.id)].dest); else jump(Number(item.id) + 1); }}/>
    </div>
    <PdfPopover open={!!textSelection.draft} root={pane} anchor={() => visibleRect('.pdf-text-selection')} className="selection-actions pdf-text-actions">
      {textSelection.draft && <>
        <ActionButton aria-label="复制 PDF 选中文字" title="复制选中文字（Ctrl+C）" identity={textSelection.draft.id} action={textSelection.copy} successLabel="已复制" onError={onMessage}><Copy size={14}/>复制</ActionButton>
        {textSelection.result?.retry ? <><span role="status">{textSelection.result.saved ? '高亮已保存，摘录待重试' : '操作未完成'}</span><button disabled={textSelection.busy} onClick={() => void textSelection.act('excerpt')}>{textSelection.result.saved ? '重试摘录' : '重试操作'}</button></> : <>
          <button disabled={textSelection.busy} onClick={() => void textSelection.act('highlight')}><Highlighter size={14}/>高亮</button>
          <button disabled={textSelection.busy || !canExcerpt} title={!canExcerpt ? '请先打开可写入的笔记并处理保存或恢复冲突' : '将选中文字插入当前笔记'} onClick={() => void textSelection.act('excerpt')}>摘录到当前笔记</button>
          {tool === 'highlight' && <button disabled={textSelection.busy || !canExcerpt} onClick={() => void textSelection.act('highlight-and-excerpt')}>高亮并摘录</button>}
        </>}
        <button aria-label="取消 PDF 文字选区" onClick={textSelection.clear}><X size={14}/></button>
      </>}
    </PdfPopover>
    <PdfPopover open={!!menuAnnotation} root={pane} anchor={() => visibleRect(`[data-annotation-id="${CSS.escape(menuAnnotation?.id || '')}"]`)} className="selection-actions pdf-annotation-menu">
      {menuAnnotation && <>
        <span>{menuAnnotation.type === 'highlight' ? '已保存高亮' : menuAnnotation.type === 'note' ? '批注' : '图片摘录'}</span>
        {menuAnnotation.text && <span>{menuAnnotation.text}</span>}
        <button disabled={deleting} aria-label="删除 PDF 标记" onClick={() => void removeAnnotation(menuAnnotation.id)}><Trash2 size={14}/>删除</button>
        <button aria-label="关闭 PDF 标记菜单" onClick={() => setAnnotationMenu(null)}><X size={14}/></button>
      </>}
    </PdfPopover>
    {deletedAnnotation && sameDocument(deletedAnnotation.path, deletedAnnotation.annotation.anchor.pdfId) && <div className="inline-undo" role="status">已删除一条 PDF 标记<button disabled={deleting} onClick={() => void undoDelete()}>撤销</button><button disabled={deleting} aria-label="关闭撤销提示" onClick={() => setDeletedAnnotation(null)}>×</button></div>}
  </section>;
}

const PdfPageSlot = memo(function PdfPageSlot({ document, number, scale, size, observeSlot, pageSizeCache, bitmapCache, renderQueue, waitForScrollIdle, pinned, dark, pdfPath, pdfData, pdfId, pageAnnotations, onMeta, onShowAnnotation, deleting, captureExcerpt, targetActive, onMessage, tool, onOcrChange, textSelection, search }: {
  document: any; number: number; scale: number; size: { width: number; height: number };
  observeSlot: SlotObserverRegister; pageSizeCache: React.RefObject<Map<number, { width: number; height: number }>>;
  bitmapCache: React.RefObject<PdfBitmapCache>; renderQueue: React.RefObject<PdfRenderQueue>;
  waitForScrollIdle: WaitForScrollIdle;
  pinned: boolean; dark: boolean; pdfPath: string; pdfData: ActivePdf['data']; pdfId: string;
  pageAnnotations: PdfAnnotation[]; onMeta: (change: (current: PdfMeta) => PdfMeta) => Promise<boolean>;
  onShowAnnotation: (id: string) => void; deleting: boolean; captureExcerpt: () => PdfExcerptContext | null;
  targetActive: boolean; onMessage: (message: string) => void; tool: PdfTool;
  onOcrChange: (page: number, active: boolean) => void; textSelection: PdfSelectedPage | null; search: PdfSearchSpec | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [actual, setActual] = useState(() => pageSizeCache.current.get(number) || size);
  useEffect(() => {
    let disposed = false;
    const element = host.current;
    if (!element) return;
    return observeSlot(element, isIntersecting => {
      if (disposed) return;
      setVisible(isIntersecting);
      if (!isIntersecting) return;
      const cached = pageSizeCache.current.get(number);
      if (cached) { setActual(prev => prev.width === cached.width && prev.height === cached.height ? prev : cached); return; }
      void (async () => {
        try {
          const page = await document.getPage(number);
          if (disposed) return;
          const viewport = page.getViewport({ scale: 1 });
          const next = { width: viewport.width, height: viewport.height };
          pageSizeCache.current.set(number, next);
          setActual(prev => prev.width === next.width && prev.height === next.height ? prev : next);
        } catch { /* Rendering reports read failures; sizing retains its placeholder after cancellation. */ }
      })();
    });
  }, [document, number, observeSlot, pageSizeCache]);
  return <div className="pdf-page-slot" ref={host} data-pdf-page={number} style={{ width: actual.width * scale, minHeight: actual.height * scale }}>
    <span className="pdf-page-label">{number}</span>
    {visible || pinned ? <PdfPage dark={dark} document={document} bitmapCache={bitmapCache} renderQueue={renderQueue} waitForScrollIdle={waitForScrollIdle} pinned={pinned} pdfPath={pdfPath} pdfData={pdfData} pdfId={pdfId} page={number} scale={scale} pageAnnotations={pageAnnotations} onMeta={onMeta} onShowAnnotation={onShowAnnotation} deleting={deleting} captureExcerpt={captureExcerpt} targetActive={targetActive} onMessage={onMessage} tool={tool} onOcrChange={onOcrChange} textSelection={textSelection} search={search}/> : <div className="pdf-page-placeholder" style={{ height: actual.height * scale }}/>}
  </div>;
});

const PdfPage = memo(function PdfPage({ dark, pdfPath, pdfData, pdfId, page, scale, pageAnnotations, onMeta, onShowAnnotation, deleting, captureExcerpt, targetActive, onMessage, document: sharedDocument, bitmapCache, renderQueue, waitForScrollIdle, pinned, tool, onOcrChange, textSelection, search }: {
  dark: boolean; document: any; tool: PdfTool; pdfPath: string; pdfData: ActivePdf['data']; pdfId: string;
  page: number; scale: number; pageAnnotations: PdfAnnotation[];
  bitmapCache: React.RefObject<PdfBitmapCache>; renderQueue: React.RefObject<PdfRenderQueue>;
  waitForScrollIdle: WaitForScrollIdle; pinned: boolean;
  onMeta: (change: (current: PdfMeta) => PdfMeta) => Promise<boolean>; onShowAnnotation: (id: string) => void;
  deleting: boolean; captureExcerpt: () => PdfExcerptContext | null; targetActive: boolean;
  onMessage: (message: string) => void; onOcrChange: (page: number, active: boolean) => void;
  textSelection: PdfSelectedPage | null; search: PdfSearchSpec | null;
}) {
  const reducedMotion = useContext(ReducedMotionContext);
  const reducedMotionRef = useRef(reducedMotion); reducedMotionRef.current = reducedMotion;
  const pinnedRef = useRef(pinned); pinnedRef.current = pinned;
  const searchRef = useRef(search); searchRef.current = search;
  const canvas = useRef<HTMLCanvasElement>(null);
  const raster = useRef<LazyPdfRaster | null>(null);
  const pagePainted = useRef(false);
  const textRenderedKey = useRef('');
  const night = useRef(dark); night.current = dark;
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);
  useLayoutEffect(() => {
    const currentCanvas = canvas.current, entry = raster.current;
    if (!currentCanvas || !entry) return;
    if (!dark) {
      if (entry.source) {
        paintPdfAppearance(currentCanvas, { source: entry.source, images: entry.images || [] }, false);
        return;
      }
      if (!entry.fromDarkCache) return;
      const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const lightCached = bitmapCache.current.get(pdfBitmapCacheKey(pdfPath, page, scale, outputScale, false));
      if (lightCached && lightCached.canvas.width === currentCanvas.width && lightCached.canvas.height === currentCanvas.height) {
        currentCanvas.getContext('2d')?.drawImage(lightCached.canvas, 0, 0);
        entry.fromDarkCache = false;
      } else {
        setRenderNonce(value => value + 1);
      }
      return;
    }
    if (entry.fromDarkCache && !entry.source) return;
    if (!entry.source) {
      entry.source = clonePdfCanvas(currentCanvas);
    }
    if (entry.images) {
      paintPdfAppearance(currentCanvas, { source: entry.source, images: entry.images }, true);
      return;
    }
    paintPdfAppearance(currentCanvas, { source: entry.source, images: entry.pdfPage?.imageCoordinates || [] }, true);
    let cancelled = false;
    void (async () => {
      try {
        const pdfPage = entry.pdfPage || await sharedDocument.getPage(Math.min(page, sharedDocument.numPages));
        if (cancelled || raster.current !== entry || !canvas.current || !entry.source) return;
        const viewport = entry.viewport || pdfPage.getViewport({ scale });
        entry.pdfPage = pdfPage;
        entry.viewport = viewport;
        const operators = await pdfPage.getOperatorList();
        if (cancelled || raster.current !== entry || !canvas.current || !entry.source) return;
        entry.images = [...pdfPage.imageCoordinates || [], ...groupedPdfImages(operators, viewport, pdfjsLib.OPS)];
        if (night.current) {
          paintPdfAppearance(canvas.current, { source: entry.source, images: entry.images }, true);
          const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
          const darkKey = pdfBitmapCacheKey(pdfPath, page, scale, outputScale, true);
          bitmapCache.current.set(darkKey, {
            canvas: clonePdfCanvas(canvas.current),
            cssWidth: viewport.width,
            cssHeight: viewport.height,
            rotation: (((pdfPage.rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270,
            bytes: canvas.current.width * canvas.current.height * 4,
            hasDarkImages: entry.images.length > 0,
          });
        }
      } catch { /* Base dark appearance already painted with recorded images. */ }
    })();
    return () => { cancelled = true; };
  }, [dark, bitmapCache, pdfPath, page, scale, sharedDocument]);
  useLayoutEffect(() => {
    if (reducedMotion) canvas.current?.getAnimations().forEach(animation => animation.cancel());
  }, [reducedMotion]);
  const textLayer = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const pdfDocument = useRef<any>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [textRevision, setTextRevision] = useState(0);
  const [searchRects, setSearchRects] = useState<{ left: number; top: number; width: number; height: number }[]>([]);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);

  const [selection, setSelection] = useState<PdfRect[] | null>(null);
  const lastSelection = useRef<PdfRect[] | null>(null); if (selection) lastSelection.current = selection;
  const selectionActionsMotion = usePanelMotion(!!selection, reducedMotion, '4px', () => holder.current?.closest<HTMLElement>('.pdf-pane') || null, 'y', { enter: '--motion-feedback', exit: '--motion-exit' });
  const selectionForMotion = selection || lastSelection.current;
  const [comment, setComment] = useState('');
  const [ocr, setOcr] = useState<(OcrDialog & { action: PdfRegionAction; result?: ExcerptFlowResult }) | null>(null);
  const ocrRef = useRef<(OcrDialog & { action: PdfRegionAction; result?: ExcerptFlowResult }) | null>(null);
  ocrRef.current = ocr;
  const latestPdfData = useRef(pdfData);
  latestPdfData.current = pdfData;
  const mountedRef = useRef(true);
  const ocrTitleId = React.useId();
  const regionOperation = useRef<{ action: PdfRegionAction; doOcr: boolean } | null>(null);
  const [regionResult, setRegionResult] = useState<ExcerptFlowResult | null>(null);
  const ocrTextAction = useRef<(() => Promise<ExcerptFlowResult>) | null>(null);
  const savingRef = useRef(false);
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  useEffect(() => { setSelection(null); setComment(''); dragStart.current = null; regionOperation.current = null; setRegionResult(null); }, [tool, pdfData]);
  useEffect(() => { onOcrChange(page, !!ocr); }, [onOcrChange, page, ocr]);
  useEffect(() => {
    const active = ocrRef.current;
    if (!active) return;
    if (active.status !== 'done' && !active.error) void reader().cancelOcr(active.jobId).catch(() => {});
    ocrRef.current = null;
    ocrTextAction.current = null;
    setOcr(null);
  }, [pdfData]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = ocrRef.current;
      if (active && active.status !== 'done' && !active.error) void reader().cancelOcr(active.jobId).catch(() => {});
      onOcrChange(page, false);
    };
  }, [onOcrChange, page]);

  pdfDocument.current = sharedDocument;
  useEffect(() => {
    const document = pdfDocument.current; if (!document || !canvas.current || !textLayer.current) return;
    let cancelled = false;
    let renderTask: any, textTask: InstanceType<typeof pdfjsLib.TextLayer> | undefined;
    let cancelQueue: (() => void) | null = null;
    let cancelScrollWait: (() => void) | null = null;
    const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const isDark = night.current;
    const cacheKey = pdfBitmapCacheKey(pdfPath, page, scale, outputScale, isDark);
    const cached = bitmapCache.current.get(cacheKey);
    if (!cached) setLoading(true);
    void (async () => {
      try {
        let pdfPage: any = null;
        let viewport: any = null;
        let fromCache = false;
        const currentCanvas = canvas.current!;
        if (cached) {
          fromCache = true;
          currentCanvas.width = cached.canvas.width;
          currentCanvas.height = cached.canvas.height;
          currentCanvas.style.width = `${cached.cssWidth}px`;
          currentCanvas.style.height = `${cached.cssHeight}px`;
          currentCanvas.getContext('2d')?.drawImage(cached.canvas, 0, 0);
          setRotation(cached.rotation);
          setPageSize(prev => prev && prev.width === cached.cssWidth && prev.height === cached.cssHeight ? prev : { width: cached.cssWidth, height: cached.cssHeight });
          raster.current = { source: null, images: null, pdfPage: null, viewport: null, fromDarkCache: isDark };
          setLoading(false);
        } else {
          const queued = renderQueue.current.enqueue(page, async () => {
            if (cancelled || !canvas.current || !textLayer.current) return null;
            const loadedPage = await document.getPage(Math.min(page, document.numPages));
            if (cancelled || !canvas.current) return null;
            const pageRotation = (((loadedPage.rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270;
            setRotation(pageRotation);
            const pageViewport = loadedPage.getViewport({ scale });
            if (cancelled || !canvas.current) return null;
            const targetCanvas = canvas.current;
            const pixelWidth = Math.ceil(pageViewport.width * outputScale);
            const pixelHeight = Math.ceil(pageViewport.height * outputScale);
            targetCanvas.width = pixelWidth;
            targetCanvas.height = pixelHeight;
            targetCanvas.style.width = `${pageViewport.width}px`;
            targetCanvas.style.height = `${pageViewport.height}px`;
            setPageSize(prev => prev && prev.width === pageViewport.width && prev.height === pageViewport.height ? prev : { width: pageViewport.width, height: pageViewport.height });
            const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
            let hasDarkImages = false;
            if (night.current) {
              // Render offscreen in dark mode so it never flashes a white page.
              const source = window.document.createElement('canvas');
              source.width = pixelWidth; source.height = pixelHeight;
              renderTask = loadedPage.render({ canvas: source, canvasContext: source.getContext('2d')!, viewport: pageViewport, transform, recordImages: true });
              await renderTask.promise;
              if (cancelled || canvas.current !== targetCanvas || !textLayer.current) return null;
              const operators = await loadedPage.getOperatorList();
              if (cancelled || canvas.current !== targetCanvas || !textLayer.current) return null;
              const images = [...loadedPage.imageCoordinates || [], ...groupedPdfImages(operators, pageViewport, pdfjsLib.OPS)];
              hasDarkImages = images.length > 0;
              raster.current = { source, images, pdfPage: loadedPage, viewport: pageViewport, fromDarkCache: false };
              paintPdfAppearance(targetCanvas, { source, images }, true);
            } else {
              // Light mode renders directly to the display canvas and defers
              // operator-list image extraction until dark mode is actually toggled.
              renderTask = loadedPage.render({ canvas: targetCanvas, canvasContext: targetCanvas.getContext('2d')!, viewport: pageViewport, transform, recordImages: true });
              await renderTask.promise;
              if (cancelled || canvas.current !== targetCanvas || !textLayer.current) return null;
              raster.current = { source: null, images: null, pdfPage: loadedPage, viewport: pageViewport, fromDarkCache: false };
            }
            const actualCacheKey = pdfBitmapCacheKey(pdfPath, page, scale, outputScale, night.current);
            bitmapCache.current.set(actualCacheKey, {
              canvas: clonePdfCanvas(targetCanvas),
              cssWidth: pageViewport.width,
              cssHeight: pageViewport.height,
              rotation: pageRotation,
              bytes: pixelWidth * pixelHeight * 4,
              hasDarkImages,
            });
            return { pdfPage: loadedPage, viewport: pageViewport };
          });
          cancelQueue = queued.cancel;
          const rendered = await queued.promise;
          if (!rendered || cancelled) return;
          pdfPage = rendered.pdfPage;
          viewport = rendered.viewport;
          setLoading(false);
        }
        if (!pagePainted.current) {
          pagePainted.current = true;
          if (!fromCache && !reducedMotionRef.current && canvas.current) {
            canvas.current.animate([{ opacity: 0.86 }, { opacity: 1 }], { duration: 120, easing: 'cubic-bezier(.2,.75,.3,1)' });
          }
        }
        const textKey = `${pdfPath}::${page}::${scale}`;
        const existingLayer = textLayer.current;
        if (textRenderedKey.current === textKey && existingLayer?.firstChild) return;
        // Yield one frame and wait for scrolling to settle before building the
        // text layer DOM (pinned/search pages bypass the idle wait).
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (cancelled) return;
        const idle = waitForScrollIdle(pinnedRef.current || !!searchRef.current);
        cancelScrollWait = idle.cancel;
        await idle.promise;
        if (cancelled) return;
        if (!pdfPage) {
          pdfPage = await document.getPage(Math.min(page, document.numPages));
          if (cancelled) return;
          viewport = pdfPage.getViewport({ scale });
          if (raster.current) {
            raster.current.pdfPage = pdfPage;
            raster.current.viewport = viewport;
          }
        }
        const layer = textLayer.current;
        if (cancelled || !layer) return;
        layer.replaceChildren(); layer.style.width = `${viewport.width}px`; layer.style.height = `${viewport.height}px`;
        layer.style.setProperty('--scale-factor', String(viewport.scale));
        layer.style.setProperty('--total-scale-factor', String(viewport.scale));
        const text = await pdfPage.getTextContent();
        if (cancelled || textLayer.current !== layer) return;
        textTask = new pdfjsLib.TextLayer({ textContentSource: text, container: layer, viewport });
        await textTask.render();
        if (!cancelled) {
          textRenderedKey.current = textKey;
          setTextRevision(value => value + 1);
        }
      } catch (error: any) { if (!cancelled && error?.name !== 'RenderingCancelledException') onMessage(`页面显示失败：${error?.message || error}`); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; cancelQueue?.(); cancelScrollWait?.(); renderTask?.cancel?.(); textTask?.cancel(); raster.current = null; };
  }, [pdfPath, page, scale, sharedDocument, bitmapCache, renderQueue, waitForScrollIdle, renderNonce]);

  useEffect(() => {
    const layer = textLayer.current;
    setSearchRects([]);
    if (!layer || !search?.query) return;
    const frame = requestAnimationFrame(() => {
      const found = findDomMatch(layer, search.query, search.occurrence, search.caseSensitive);
      if (!found) return;
      const range = domRangeForMatch(layer, found.map, found.match);
      if (!range) return;
      const bounds = layer.getBoundingClientRect();
      setSearchRects(pdfRangeRects(range, layer, bounds).map(rect => ({
        left: Math.max(0, rect.x * bounds.width - 2),
        top: rect.y * bounds.height,
        width: Math.min(bounds.width - rect.x * bounds.width, rect.w * bounds.width + 4),
        height: rect.h * bounds.height,
      })));
      (range.startContainer.parentElement || layer).scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [search?.query, search?.occurrence, search?.caseSensitive, textRevision]);

  useEffect(() => reader().onOcrProgress((progress: OcrProgress) => {
    setOcr(current => {
      if (!current || current.jobId !== progress.jobId) return current;
      return { ...current, progress: progress.progress, status: progress.status, text: progress.text ?? current.text, error: progress.message };
    });
  }), []);

  const pageWidth = pageSize?.width || 595 * scale;
  const pageHeight = pageSize?.height || 842 * scale;
  const savedHighlightRects = useMemo(
    () => visiblePdfHighlightRects(
      pageAnnotations.filter(item => item.type === 'highlight').flatMap(item => item.anchor.rects.map(rect => ({ ...rect, angle: item.anchor.rotation }))),
      textSelection?.rects || [],
      pageWidth,
      pageHeight,
    ),
    [pageAnnotations, textSelection, pageWidth, pageHeight],
  );
  const cleanedAnnotations = useMemo(
    () => pageAnnotations.map(annotation => ({
      annotation,
      rects: cleanPdfRects(annotation.anchor.rects.map(rect => ({ ...rect, angle: annotation.anchor.rotation })), pageWidth, pageHeight),
    })),
    [pageAnnotations, pageWidth, pageHeight],
  );
  function point(event: React.PointerEvent) {
    const bounds = holder.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)), y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)) };
  }
  function finishRegion(event: React.PointerEvent) {
    if (tool !== 'region' || !dragStart.current || savingRef.current) return;
    const end = point(event); const start = dragStart.current; dragStart.current = null;
    const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    if (rect.w > .006 && rect.h > .006) { regionOperation.current = null; setRegionResult(null); setSelection([rect]); }
  }
  async function cropPng(rect: PdfRect) {
    const pdfDoc = pdfDocument.current; if (!pdfDoc) throw new Error('PDF 尚未载入');
    const pdfPage = await pdfDoc.getPage(page); const viewport = pdfPage.getViewport({ scale: 3 });
    const full = document.createElement('canvas'); full.width = Math.ceil(viewport.width); full.height = Math.ceil(viewport.height);
    await pdfPage.render({ canvas: full, canvasContext: full.getContext('2d')!, viewport }).promise;
    const crop = document.createElement('canvas'); crop.width = Math.max(1, Math.round(full.width * rect.w)); crop.height = Math.max(1, Math.round(full.height * rect.h));
    crop.getContext('2d')!.drawImage(full, Math.round(full.width * rect.x), Math.round(full.height * rect.y), crop.width, crop.height, 0, 0, crop.width, crop.height);
    const blob = await new Promise<Blob | null>(resolve => crop.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('无法生成摘录图片'); return new Uint8Array(await blob.arrayBuffer());
  }
  async function storeAnnotation(type: PdfAnnotation['type'], options: Partial<PdfAnnotation> = {}) {
    if (!pdfId || !selection?.length) return null;
    const annotation: PdfAnnotation = { id: crypto.randomUUID(), type, anchor: { pdfId, page, rects: selection, rotation }, color: '#e4c95b', createdAt: new Date().toISOString(), ...options };
    if (!(await onMeta(meta => ({ ...meta, page, annotations: [...meta.annotations, annotation] })))) return null;
    return annotation;
  }
  async function saveHighlight() {
    if (savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    try {
      const annotation = await storeAnnotation('note', { text: comment });
      if (!annotation) return;
      // The annotation is already committed. Clear this action before excerpt
      // work so an excerpt failure cannot cause a retry to duplicate the mark.
      setSelection(null); setComment('');
    } catch (error) { onMessage(`PDF 标记处理失败：${String(error)}`); }
    finally { savingRef.current = false; setSavingAnnotation(false); }
  }
  async function saveRegion(doOcr = false) {
    if (!pdfId || !selection?.[0] || savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    try {
      if (!regionOperation.current) {
        const context = captureExcerpt(); if (!context) return;
        const rect = { ...selection[0] };
        const annotation: PdfAnnotation = { id: crypto.randomUUID(), type: 'region', anchor: { pdfId, page, rects: [{ ...rect }], rotation }, color: '#e4c95b', createdAt: new Date().toISOString() };
        regionOperation.current = { doOcr, action: createPdfRegionAction({ context, annotation,
          crop: () => cropPng(rect),
          attachment: (sourcePath, data) => reader().saveAttachment({ sourcePath, data, extension: 'png' }),
          save: item => onMeta(meta => ({ ...meta, page, annotations: meta.annotations.some(old => old.id === item.id) ? meta.annotations : [...meta.annotations, item] })),
          saveText: (item, text) => onMeta(meta => ({ ...meta, annotations: meta.annotations.map(old => old.id === item.id ? { ...old, ocrText: text } : old) })),
        }) };
      }
      const operation = regionOperation.current;
      const outcome = await operation.action.run();
      if (regionOperation.current !== operation) return;
      setRegionResult(outcome);
      if (!outcome.done) { if (outcome.error) onMessage(outcome.error); return; }
      if (operation.doOcr) {
        const expectedData = pdfData;
        const { jobId } = await reader().startOcr({ image: await operation.action.bytes(), languages: ['chi_sim', 'chi_tra', 'eng'] });
        if (!mountedRef.current || latestPdfData.current !== expectedData) {
          void reader().cancelOcr(jobId).catch(() => {});
          return;
        }
        const nextOcr = { jobId, action: operation.action, annotation: operation.action.annotation, imagePath: operation.action.annotation.attachment || '', progress: 0, status: '正在准备识别', text: '' };
        ocrRef.current = nextOcr;
        ocrTextAction.current = null;
        setOcr(nextOcr);
      }
      regionOperation.current = null; setRegionResult(null); setSelection(null);
    } catch (error) { onMessage(`框选处理失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { savingRef.current = false; setSavingAnnotation(false); }
  }
  async function acceptOcr() {
    if (!ocr || !pdfId || savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    try {
      const current = ocr;
      if (!ocrTextAction.current) ocrTextAction.current = current.action.createTextAction(current.text);
      const outcome = await ocrTextAction.current();
      if (outcome.done) { setOcr(null); ocrTextAction.current = null; }
      else { setOcr(value => value?.jobId === current.jobId ? { ...value, result: outcome } : value); if (outcome.error) onMessage(outcome.error); }
    } catch (error) { onMessage(`识别文字摘录失败：${String(error)}`); }
    finally { savingRef.current = false; setSavingAnnotation(false); }
  }

  async function closeOcr() {
    if (!ocr || savingRef.current) return;
    const current = ocr;
    savingRef.current = true; setSavingAnnotation(true);
    try {
      if (current.status !== 'done' && !current.error) await reader().cancelOcr(current.jobId);
      setOcr(value => value?.jobId === current.jobId ? null : value);
    } catch (error) { onMessage(`取消识别失败，请重试：${String(error)}`); }
    finally { savingRef.current = false; setSavingAnnotation(false); }
  }

  function renderRegionActions(): React.ReactNode {
    if (regionResult?.retry) return <><span role="status">{regionResult.error}</span><button disabled={savingAnnotation} onClick={() => void saveRegion()}>{regionResult.saved ? '重试摘录' : '重试操作'}</button></>;
    return <><button disabled={savingAnnotation} onClick={() => void saveRegion(false)}>保存图片摘录</button><button className="primary" disabled={savingAnnotation} onClick={() => void saveRegion(true)}>识别文字并摘录</button></>;
  }

  return <section className="pdf-page-content">
    <div className="pdf-page-inner"><div className="pdf-stage"><div className="canvas-holder" ref={holder} data-rotation={rotation} style={pageSize ? { width: `${pageSize.width}px`, height: `${pageSize.height}px` } : undefined} onPointerDown={event => { if (savingRef.current) return; if (tool === 'region') { dragStart.current = point(event); setSelection(null); } else if (tool === 'note') { const at = point(event); setSelection([{ x: at.x, y: at.y, w: .025, h: .025 }]); } }} onPointerUp={finishRegion}>
      <canvas ref={canvas}/><div ref={textLayer} className="textLayer" data-text-revision={textRevision}/><div className="pdf-search-layer" aria-hidden="true">{searchRects.map((rect, index) => <span className="pdf-search-hit" key={index} style={rect}/>)}</div>
      <div className={'draw-layer ' + (tool === 'region' || tool === 'note' ? 'interactive' : '')}>
        {savedHighlightRects.map((rect, index) => <span aria-hidden="true" className="pdf-saved-highlight" key={`saved-${index}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}/>) }
        {cleanedAnnotations.flatMap(({ annotation, rects }) => rects.map((rect, index) => {
          const className = `annotation ${annotation.type} ${targetActive ? 'flash' : ''}`;
          const style = { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` };
          return index === 0 ? <button disabled={deleting} type="button" aria-label="查看 PDF 标记" data-annotation-id={annotation.id} title={annotation.text || annotation.comment || annotation.anchor.quote || '标记'} className={className} style={style} key={`${annotation.id}-${index}`} onClick={() => onShowAnnotation(annotation.id)}><span className="sr-only">查看标记</span></button> : <span aria-hidden="true" data-annotation-id={annotation.id} className={className} style={style} key={`${annotation.id}-${index}`}/>;
        }))}
        {textSelection?.rects.map((rect, index) => <span aria-hidden="true" className="pdf-text-selection" key={index} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}/>) }
        {selection?.map((rect, index) => <div className="selection-box" key={index} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}/>) }
      </div>{loading && <div className="loading">正在载入页面…</div>}
    </div>
    {selectionActionsMotion.present && selectionForMotion && <div ref={selectionActionsMotion.ref as React.RefObject<HTMLDivElement | null>} className="selection-actions" aria-hidden={!selection}>{tool === 'region' ? renderRegionActions() : <><input autoFocus disabled={savingAnnotation} value={comment} onChange={event => setComment(event.target.value)} placeholder="写下批注"/><button className="primary" disabled={savingAnnotation || !comment.trim()} onClick={() => void saveHighlight()}>保存批注</button></>}<button disabled={savingAnnotation} onClick={() => { setSelection(null); regionOperation.current = null; setRegionResult(null); }}>取消</button></div>}
    {!!pageAnnotations.length && <aside className="annotation-list"><b>本页标记</b>{pageAnnotations.map(annotation => <div key={annotation.id}><span>{annotation.type === 'highlight' ? '高亮' : annotation.type === 'region' ? '框选' : '批注'} · {annotation.anchor.quote || annotation.text || annotation.ocrText || '第 ' + page + ' 页'}</span><button disabled={deleting} onClick={() => onShowAnnotation(annotation.id)}>查看</button></div>)}</aside>}
    </div>
    </div>
    {ocr && <DialogFrame className="ocr-dialog" labelledBy={ocrTitleId} busy={savingAnnotation} onCancel={() => void closeOcr()}
      returnFocus={() => holder.current?.closest<HTMLElement>('.pdf-pane') || null}>
      <div className="dialog-head"><h2 id={ocrTitleId}>扫描文字识别</h2><button aria-label="关闭扫描文字识别" title="关闭（Esc）" disabled={savingAnnotation} onClick={() => void closeOcr()}><X/></button></div>
      {ocr.status !== 'done' && !ocr.error ? <>
        <p>{ocr.status} · {Math.round(ocr.progress * 100)}%</p><progress aria-label="文字识别进度" max="1" value={ocr.progress}/>
        <div className="dialog-actions"><button disabled={savingAnnotation} onClick={() => void closeOcr()}>取消识别</button></div>
      </> : ocr.error ? <><p>识别失败：{ocr.error}</p><p>图片摘录已经保留。</p></> : <>
        <p>请核对并修改识别结果，再插入笔记。</p>
        <textarea aria-label="识别文字" disabled={savingAnnotation || !!ocr.result?.saved} value={ocr.text} onChange={event => { ocrTextAction.current = null; setOcr({ ...ocr, text: event.target.value, result: undefined }); }}/>
        {ocr.result?.error && <p role="status">{ocr.result.error}</p>}
        <div className="dialog-actions"><button disabled={savingAnnotation} onClick={() => void closeOcr()}>只保留图片</button><button className="primary" disabled={savingAnnotation} onClick={() => void acceptOcr()}>{ocr.result?.saved ? '重试摘录' : '确认并插入文字'}</button></div>
      </>}
    </DialogFrame>}
  </section>;
});
