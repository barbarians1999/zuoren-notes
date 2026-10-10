import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OutlinePanel } from '../OutlinePanel';
import { BookOpen, ChevronLeft, ChevronRight, Copy, Crop, List, Highlighter, Maximize2, MessageSquare, Minimize2, MousePointer2, Search, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
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
import { createPdfRegionAction, type PdfExcerptContext, type PdfRegionAction } from './pdfRegionAction';
import type { ExcerptFlowResult } from './excerptFlow';
import { groupedPdfImages, paintPdfAppearance, type PdfRaster } from './pdfAppearance';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
// PDF.js 6 loads JBIG2/OpenJPEG/ICC decoders on demand.  The desktop build
// runs from a file:// URL, so leaving wasmUrl unset makes the fallback module
// resolve as a bare (and invalid) module specifier.  Keep the decoder bundle
// beside the app's renderer assets and give PDF.js an explicit directory URL.
const pdfWasmUrl = new URL('pdfjs/wasm/', document.baseURI).toString();
type PdfTool = 'select' | 'highlight' | 'region' | 'note';
export function PdfPane({ dark, pdf, page, setPage, scale, setScale, fullscreen, onToggleFullscreen, onMeta, captureExcerpt, onTextAction, canExcerpt, target, onMessage }: { dark: boolean; pdf: ActivePdf | null; page: number; setPage: (page: number) => void; scale: number; setScale: (scale: number) => void; fullscreen: boolean; onToggleFullscreen: () => void; onMeta: (change: (current: PdfMeta) => PdfMeta) => Promise<boolean>; captureExcerpt: (source: ActivePdf) => PdfExcerptContext | null; onTextAction: PdfTextActionHandler; canExcerpt: boolean; target: PdfAnchor | null; onMessage: (message: string) => void }) {
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
  const pane = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null), pageInput = useRef<HTMLInputElement>(null);
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
  const showAnnotation = (id: string) => { textSelection.clear(); if (pdf) setAnnotationMenu({ id, key: pdf.data }); };
  const scroll = useRef<HTMLDivElement>(null), lastPage = useRef(0), searchGeneration = useRef(0);
  const zoomAnchor = useRef<{ page: number; ratio: number; scale: number; token: number } | null>(null);
  const zoomToken = useRef(0), restoringZoom = useRef(false);
  const pageTextCache = useRef(new Map<number, string>());
  const pageTextErrors = useRef(new Set<number>());
  const latest = useRef({ pdf, onMeta }); latest.current = { pdf, onMeta };
  // Undo belongs to the document, not a virtualized page that may unmount.
  const [deletedAnnotation, setDeletedAnnotation] = useState<{ annotation: PdfAnnotation; index: number; path: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletionLock = useRef<object | null>(null);
  useEffect(() => { setDeletedAnnotation(null); }, [pdf?.path, pdf?.meta.id]);
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
    setLoadedDocument(null); setPages(0); setToc([]); setSearchMatches([]); setSearchIndex(-1); setSearching(false); setSearchStatus({ processed: 0, totalPages: 0, totalMatches: 0, errors: 0, truncated: false }); pageTextCache.current.clear(); pageTextErrors.current.clear(); lastPage.current = 0; zoomToken.current += 1; zoomAnchor.current = null; restoringZoom.current = false; searchGeneration.current += 1;
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
    const visible = [...host.querySelectorAll<HTMLElement>('[data-pdf-page]')].find(item => item.getBoundingClientRect().bottom > probe);
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
    scroll.current?.querySelector<HTMLElement>('[data-pdf-page="' + next + '"]')?.scrollIntoView({ block: 'start' });
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
      if (!origin || !pane.current?.contains(origin)) return;
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
  return <section className={'pane pdf-pane' + (textSelection.draft ? ' pdf-text-selected' : '')} ref={pane} tabIndex={-1} onPointerDownCapture={event => { if (!(event.target instanceof Element) || !event.target.closest('button, input, textarea')) pane.current?.focus({ preventScroll: true }); }} onKeyDown={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Escape') { textSelection.clear(); setAnnotationMenu(null); event.preventDefault(); event.stopPropagation(); return; }
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'PageDown' || event.key === 'ArrowRight') { event.preventDefault(); jump(page + 1); }
    if (event.key === 'PageUp' || event.key === 'ArrowLeft') { event.preventDefault(); jump(page - 1); }
    if (event.key === 'Home') { event.preventDefault(); jump(1); }
    if (event.key === 'End' && pages) { event.preventDefault(); jump(pages); }
  }}>
    <div className="pane-toolbar pdf-navigation" role="group" aria-label="PDF 阅读工具" title={pdf?.name || 'PDF 阅读工具'}>
      <button data-pdf-outline-toggle className="icon-button" aria-pressed={showToc} aria-label={showToc ? '收起 PDF 大纲' : '展开 PDF 大纲'} title={pdf ? `${pdf.name}\n${showToc ? '收起大纲' : '展开大纲'}` : '展开大纲'} onClick={() => setShowToc(value => !value)}><List size={17}/></button>
      <div className="toolbar-group pdf-page-navigation">
        <button className="icon-button" title="上一页（← / PageUp）" aria-label="上一页" onClick={() => jump(page - 1)}><ChevronLeft size={18}/></button>
        <span className="page-control"><span className="page-word">第</span><input ref={pageInput} aria-label="当前页码" inputMode="numeric" value={pageDraft} onChange={event => setPageDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitPageDraft(); } else if (event.key === 'Escape') { event.preventDefault(); setPageDraft(String(page)); (event.target as HTMLInputElement).blur(); } }} onBlur={() => setPageDraft(String(page))}/><span>/ {pages || '…'}<span className="page-word"> 页</span></span></span>
        <button className="icon-button" title="下一页（→ / PageDown）" aria-label="下一页" onClick={() => jump(page + 1)}><ChevronRight size={18}/></button>
      </div>
      <div className="pdf-tools" role="toolbar" aria-label="PDF 标记工具">
        <button aria-label="选择" title="选择文本" aria-pressed={tool === 'select'} className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}><MousePointer2 size={16}/><span>选择</span></button>
        <button aria-label="文字高亮" title="文字高亮" aria-pressed={tool === 'highlight'} className={tool === 'highlight' ? 'on' : ''} onClick={() => setTool('highlight')}><Highlighter size={16}/><span>文字高亮</span></button>
        <button aria-label="框选" title="框选" aria-pressed={tool === 'region'} className={tool === 'region' ? 'on' : ''} onClick={() => setTool('region')}><Crop size={16}/><span>框选</span></button>
        <button aria-label="批注" title="批注" aria-pressed={tool === 'note'} className={tool === 'note' ? 'on' : ''} onClick={() => setTool('note')}><MessageSquare size={16}/><span>批注</span></button>
      </div>
      <span className="toolbar-spacer"/>
      <button className="icon-button" aria-label="在 PDF 中查找" title="在 PDF 中查找（Ctrl+F）" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }}><Search size={16}/></button>
      <div className="toolbar-group zoom-control"><button className="icon-button" title="缩小" aria-label="缩小" onClick={() => requestScale((zoomAnchor.current?.scale ?? scale) - .15)}><ZoomOut size={17}/></button><span>{Math.round(scale * 100)}%</span><button className="icon-button" title="放大" aria-label="放大" onClick={() => requestScale((zoomAnchor.current?.scale ?? scale) + .15)}><ZoomIn size={17}/></button><button className="icon-button" aria-pressed={fullscreen} title={fullscreen ? '退出全屏阅读' : '进入全屏阅读'} aria-label={fullscreen ? '退出全屏阅读' : '进入全屏阅读'} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></div>
    </div>
    {searchOpen && <div className="pdf-find-bar" role="search" aria-label="查找当前 PDF"><Search size={15}/><input ref={searchInput} aria-label="PDF 查找文本" placeholder="在这份 PDF 中查找" value={searchText} onChange={event => setSearchText(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); setSearchText(''); pane.current?.focus(); } else if (event.key === 'Enter' && searchMatches.length) setSearchIndex(index => stepMatchIndex(searchMatches.length, index, event.shiftKey ? -1 : 1)); }}/><span className="pdf-find-progress" aria-live="polite">{searching ? `已检索 ${searchStatus.processed}/${searchStatus.totalPages} 页` : searchStatus.errors ? `${searchStatus.errors} 页无法提取文字` : ''}</span><span className="find-count" aria-live="polite">{searching ? `${searchStatus.totalMatches} 项` : searchStatus.totalMatches ? (searchStatus.truncated ? `${searchIndex + 1} / 5000 · 共 ${searchStatus.totalMatches}` : `${searchIndex + 1} / ${searchStatus.totalMatches}`) : '0 / 0'}</span><button className={searchCase ? 'selected' : ''} aria-label="PDF 搜索区分大小写" aria-pressed={searchCase} title="区分大小写" onClick={() => setSearchCase(value => !value)}>Aa</button><button aria-label="上一个 PDF 匹配" disabled={!searchMatches.length} onClick={() => setSearchIndex(index => stepMatchIndex(searchMatches.length, index, -1))}>↑</button><button aria-label="下一个 PDF 匹配" disabled={!searchMatches.length} onClick={() => setSearchIndex(index => stepMatchIndex(searchMatches.length, index, 1))}>↓</button><button aria-label="关闭 PDF 查找" title="关闭（Esc）" onClick={() => { setSearchOpen(false); setSearchText(''); pane.current?.focus(); }}>×</button></div>}

    <div className="pdf-reader-body">
      <div className="pdf-canvas-wrap continuous-pdf" ref={scroll} onScroll={() => {
        if (restoringZoom.current) return;
        const host = scroll.current; if (!host) return;
        const top = host.getBoundingClientRect().top;
        const visible = [...host.querySelectorAll<HTMLElement>('[data-pdf-page]')].find(element => element.getBoundingClientRect().bottom > top + 80);
        const number = Number(visible?.dataset.pdfPage); if (number && number !== lastPage.current) { lastPage.current = number; setPage(number); }
      }}>
        {!pdf ? <div className="empty-state"><BookOpen size={28}/><p>打开 PDF 或 EPUB 开始阅读</p></div> : !document ? <div className="empty-state">正在载入 PDF…</div> : Array.from({ length: pages }, (_, index) => <PdfPageSlot key={pdf.path + index} document={document} number={index+1} scale={scale} size={size} root={scroll} pinned={textSelection.pins.includes(index + 1)}><PdfPage dark={dark} document={document} pdf={pdf} page={index + 1} scale={scale} onMeta={onMeta} onShowAnnotation={showAnnotation} deleting={deleting} captureExcerpt={captureExcerpt} target={target} onMessage={onMessage} tool={tool} textSelection={textSelection.draft?.pages.find(part => part.page === index + 1) || null} search={currentSearch?.page === index + 1 ? { query: searchText.trim(), occurrence: currentSearch.occurrence, caseSensitive: searchCase } : null}/></PdfPageSlot>)}
      </div>
      <OutlinePanel open={showToc} label="PDF 大纲" className="pdf-outline" emptyText={pdf ? '正在读取大纲…' : '请先打开 PDF。'}
        introduction={pages > 0 && !toc.length ? '这份 PDF 没有内置目录，可按页跳转。' : undefined}
        returnFocus={() => pane.current?.querySelector('[data-pdf-outline-toggle]') || null}
        items={toc.length ? toc.map((item, index) => ({ id: String(index), label: item.title, depth: item.depth })) :
          Array.from({ length: pages }, (_, index) => ({ id: String(index), label: `第 ${index + 1} 页`, depth: 0, active: page === index + 1 }))}
        onSelect={item => { if (toc.length) void goToDestination(toc[Number(item.id)].dest); else jump(Number(item.id) + 1); }}/>
    </div>
    {textSelection.draft && <PdfPopover root={pane} anchor={() => visibleRect('.pdf-text-selection')} className="selection-actions pdf-text-actions">
      <button aria-label="复制 PDF 选中文字" onClick={() => void textSelection.copy()}><Copy size={14}/>复制</button>
      {textSelection.result?.retry ? <><span role="status">{textSelection.result.saved ? '高亮已保存，摘录待重试' : '操作未完成'}</span><button disabled={textSelection.busy} onClick={() => void textSelection.act('excerpt')}>{textSelection.result.saved ? '重试摘录' : '重试操作'}</button></> : <>
        <button disabled={textSelection.busy} onClick={() => void textSelection.act('highlight')}><Highlighter size={14}/>高亮</button>
        <button disabled={textSelection.busy || !canExcerpt} title={!canExcerpt ? '请先打开可写入的笔记并处理保存或恢复冲突' : '将选中文字插入当前笔记'} onClick={() => void textSelection.act('excerpt')}>摘录到当前笔记</button>
        {tool === 'highlight' && <button disabled={textSelection.busy || !canExcerpt} onClick={() => void textSelection.act('highlight-and-excerpt')}>高亮并摘录</button>}
      </>}
      <button aria-label="取消 PDF 文字选区" onClick={textSelection.clear}><X size={14}/></button>
    </PdfPopover>}
    {menuAnnotation && <PdfPopover root={pane} anchor={() => visibleRect(`[data-annotation-id="${CSS.escape(menuAnnotation.id)}"]`)} className="selection-actions pdf-annotation-menu">
      <span>{menuAnnotation.type === 'highlight' ? '已保存高亮' : menuAnnotation.type === 'note' ? '批注' : '图片摘录'}</span>
      {menuAnnotation.text && <span>{menuAnnotation.text}</span>}
      <button disabled={deleting} aria-label="删除 PDF 标记" onClick={() => void removeAnnotation(menuAnnotation.id)}><Trash2 size={14}/>删除</button>
      <button aria-label="关闭 PDF 标记菜单" onClick={() => setAnnotationMenu(null)}><X size={14}/></button>
    </PdfPopover>}
    {deletedAnnotation && sameDocument(deletedAnnotation.path, deletedAnnotation.annotation.anchor.pdfId) && <div className="inline-undo" role="status">已删除一条 PDF 标记<button disabled={deleting} onClick={() => void undoDelete()}>撤销</button><button disabled={deleting} aria-label="关闭撤销提示" onClick={() => setDeletedAnnotation(null)}>×</button></div>}
  </section>;
}

function PdfPageSlot({ document, number, scale, size, root, pinned, children }: { document: any; number: number; scale: number; size: { width: number; height: number }; root: React.RefObject<HTMLDivElement | null>; pinned: boolean; children: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false), [actual, setActual] = useState(size);
  useEffect(() => {
    let disposed = false;
    const observer = new IntersectionObserver(entries => {
      if (disposed || !entries[0]) return;
      setVisible(entries[0].isIntersecting);
      if (!entries[0].isIntersecting) return;
      void (async () => {
        try {
          const page = await document.getPage(number);
          if (disposed) return;
          const viewport = page.getViewport({ scale: 1 });
          setActual({ width: viewport.width, height: viewport.height });
        } catch { /* Rendering reports read failures; sizing retains its placeholder after cancellation. */ }
      })();
    }, { root: root.current, rootMargin: '900px' });
    if (host.current) observer.observe(host.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [document, number]);
  return <div className="pdf-page-slot" ref={host} data-pdf-page={number} style={{ width: actual.width * scale, minHeight: actual.height * scale }}><span className="pdf-page-label">{number}</span>{visible || pinned ? children : <div style={{ height: actual.height * scale }}/>}</div>;
}

function PdfPage({ dark, pdf, page, scale, onMeta, onShowAnnotation, deleting, captureExcerpt, target, onMessage, document: sharedDocument, tool, textSelection, search }: { dark: boolean; document: any; tool: PdfTool; pdf: ActivePdf | null; page: number; scale: number; onMeta: (change: (current: PdfMeta) => PdfMeta) => Promise<boolean>; onShowAnnotation: (id: string) => void; deleting: boolean; captureExcerpt: (source: ActivePdf) => PdfExcerptContext | null; target: PdfAnchor | null; onMessage: (message: string) => void; textSelection: PdfSelectedPage | null; search: { query: string; occurrence: number; caseSensitive: boolean } | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const raster = useRef<PdfRaster | null>(null);
  const night = useRef(dark); night.current = dark;
  useLayoutEffect(() => {
    if (canvas.current && raster.current) paintPdfAppearance(canvas.current, raster.current, dark);
  }, [dark]);
  const textLayer = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const pdfDocument = useRef<any>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [textRevision, setTextRevision] = useState(0);
  const [searchRects, setSearchRects] = useState<{ left: number; top: number; width: number; height: number }[]>([]);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);

  const [selection, setSelection] = useState<PdfRect[] | null>(null);
  const [comment, setComment] = useState('');
  const [ocr, setOcr] = useState<(OcrDialog & { action: PdfRegionAction; result?: ExcerptFlowResult }) | null>(null);
  const regionOperation = useRef<{ action: PdfRegionAction; doOcr: boolean } | null>(null);
  const [regionResult, setRegionResult] = useState<ExcerptFlowResult | null>(null);
  const ocrTextAction = useRef<(() => Promise<ExcerptFlowResult>) | null>(null);
  const savingRef = useRef(false);
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  useEffect(() => { setSelection(null); setComment(''); dragStart.current = null; regionOperation.current = null; setRegionResult(null); }, [tool, pdf?.data]);

  pdfDocument.current = sharedDocument;
  useEffect(() => {
    const document = pdfDocument.current; if (!document || !canvas.current || !textLayer.current) return;
    let cancelled = false;
    let renderTask: any, textTask: InstanceType<typeof pdfjsLib.TextLayer> | undefined;
    setLoading(true);
    void (async () => {
      try {
        const pdfPage = await document.getPage(Math.min(page, document.numPages));
        if (cancelled || !canvas.current) return;
        setRotation((((pdfPage.rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270);
        const viewport = pdfPage.getViewport({ scale });
        if (cancelled || !canvas.current) return;
        const outputScale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const currentCanvas = canvas.current!; currentCanvas.width = Math.ceil(viewport.width * outputScale); currentCanvas.height = Math.ceil(viewport.height * outputScale);
        currentCanvas.style.width = `${viewport.width}px`; currentCanvas.style.height = `${viewport.height}px`;
        // Render offscreen so night mode never flashes a white page. Theme
        // changes repaint only the display canvas, not text/selection layers.
        const source = window.document.createElement('canvas');
        source.width = currentCanvas.width; source.height = currentCanvas.height;
        const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
        renderTask = pdfPage.render({ canvas: source, canvasContext: source.getContext('2d')!, viewport, transform, recordImages: true });
        await renderTask.promise;
        if (cancelled || canvas.current !== currentCanvas || !textLayer.current) return;
        const operators = await pdfPage.getOperatorList();
        if (cancelled || canvas.current !== currentCanvas || !textLayer.current) return;
        raster.current = { source, images: [...pdfPage.imageCoordinates || [], ...groupedPdfImages(operators, viewport, pdfjsLib.OPS)] };
        paintPdfAppearance(currentCanvas, raster.current, night.current);
        const layer = textLayer.current!; layer.replaceChildren(); layer.style.width = `${viewport.width}px`; layer.style.height = `${viewport.height}px`;
        layer.style.setProperty('--scale-factor', String(viewport.scale));
        layer.style.setProperty('--total-scale-factor', String(viewport.scale));
        const text = await pdfPage.getTextContent();
        if (cancelled || textLayer.current !== layer) return;
        textTask = new pdfjsLib.TextLayer({ textContentSource: text, container: layer, viewport });
        await textTask.render();
        if (!cancelled) setTextRevision(value => value + 1);
      } catch (error: any) { if (!cancelled && error?.name !== 'RenderingCancelledException') onMessage(`页面显示失败：${error?.message || error}`); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; renderTask?.cancel?.(); textTask?.cancel(); raster.current = null; };
  }, [pdf?.path, page, scale, sharedDocument]);

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

  const pageAnnotations = pdf?.meta.annotations.filter(annotation => annotation.anchor.page === page) || [];
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
    if (!pdf || !selection?.length) return null;
    const annotation: PdfAnnotation = { id: crypto.randomUUID(), type, anchor: { pdfId: pdf.meta.id, page, rects: selection, rotation }, color: '#e4c95b', createdAt: new Date().toISOString(), ...options };
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
    if (!pdf || !selection?.[0] || savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    try {
      if (!regionOperation.current) {
        const context = captureExcerpt(pdf); if (!context) return;
        const rect = { ...selection[0] };
        const annotation: PdfAnnotation = { id: crypto.randomUUID(), type: 'region', anchor: { pdfId: pdf.meta.id, page, rects: [{ ...rect }], rotation }, color: '#e4c95b', createdAt: new Date().toISOString() };
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
        const { jobId } = await reader().startOcr({ image: await operation.action.bytes(), languages: ['chi_sim', 'chi_tra', 'eng'] });
        ocrTextAction.current = null;
        setOcr({ jobId, action: operation.action, annotation: operation.action.annotation, imagePath: operation.action.annotation.attachment || '', progress: 0, status: '正在准备识别', text: '' });
      }
      regionOperation.current = null; setRegionResult(null); setSelection(null);
    } catch (error) { onMessage(`框选处理失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { savingRef.current = false; setSavingAnnotation(false); }
  }
  async function acceptOcr() {
    if (!ocr || !pdf || savingRef.current) return;
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

  function renderRegionActions(): React.ReactNode {
    if (regionResult?.retry) return <><span role="status">{regionResult.error}</span><button disabled={savingAnnotation} onClick={() => void saveRegion()}>{regionResult.saved ? '重试摘录' : '重试操作'}</button></>;
    return <><button disabled={savingAnnotation} onClick={() => void saveRegion(false)}>保存图片摘录</button><button className="primary" disabled={savingAnnotation} onClick={() => void saveRegion(true)}>识别文字并摘录</button></>;
  }

  return <section className="pdf-page-content">
    <div className="pdf-page-inner">{!pdf ? <div className="empty-state"><span className="empty-icon"><BookOpen size={28}/></span><p>打开 PDF 或 EPUB 开始阅读</p><small>文件会留在原来的磁盘位置</small></div> : <div className="pdf-stage"><div className="canvas-holder" ref={holder} data-rotation={rotation} style={{ width: canvas.current?.style.width, height: canvas.current?.style.height }} onPointerDown={event => { if (savingRef.current) return; if (tool === 'region') { dragStart.current = point(event); setSelection(null); } else if (tool === 'note') { const at = point(event); setSelection([{ x: at.x, y: at.y, w: .025, h: .025 }]); } }} onPointerUp={finishRegion}>
      <canvas ref={canvas}/><div ref={textLayer} className="textLayer" data-text-revision={textRevision}/><div className="pdf-search-layer" aria-hidden="true">{searchRects.map((rect, index) => <span className="pdf-search-hit" key={index} style={rect}/>)}</div>
      <div className={'draw-layer ' + (tool === 'region' || tool === 'note' ? 'interactive' : '')}>
        {visiblePdfHighlightRects(pageAnnotations.filter(item => item.type === 'highlight').flatMap(item => item.anchor.rects.map(rect => ({ ...rect, angle: item.anchor.rotation }))), textSelection?.rects || [], parseFloat(canvas.current?.style.width || '') || 595 * scale, parseFloat(canvas.current?.style.height || '') || 842 * scale).map((rect, index) => <span aria-hidden="true" className="pdf-saved-highlight" key={`saved-${index}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}/>) }
        {pageAnnotations.flatMap(annotation => cleanPdfRects(annotation.anchor.rects.map(rect => ({ ...rect, angle: annotation.anchor.rotation })), parseFloat(canvas.current?.style.width || '') || 595 * scale, parseFloat(canvas.current?.style.height || '') || 842 * scale).map((rect, index) => {
          const className = `annotation ${annotation.type} ${target && target.pdfId === annotation.anchor.pdfId && target.page === annotation.anchor.page ? 'flash' : ''}`;
          const style = { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` };
          return index === 0 ? <button disabled={deleting} type="button" aria-label="查看 PDF 标记" data-annotation-id={annotation.id} title={annotation.text || annotation.comment || annotation.anchor.quote || '标记'} className={className} style={style} key={`${annotation.id}-${index}`} onClick={() => onShowAnnotation(annotation.id)}><span className="sr-only">查看标记</span></button> : <span aria-hidden="true" data-annotation-id={annotation.id} className={className} style={style} key={`${annotation.id}-${index}`}/>;
        }))}
        {textSelection?.rects.map((rect, index) => <span aria-hidden="true" className="pdf-text-selection" key={index} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}/>) }
        {selection?.map((rect, index) => <div className="selection-box" key={index} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}/>) }
      </div>{loading && <div className="loading">正在载入页面…</div>}
    </div>
    {selection && <div className="selection-actions">{tool === 'region' ? renderRegionActions() : <><input autoFocus disabled={savingAnnotation} value={comment} onChange={event => setComment(event.target.value)} placeholder="写下批注"/><button className="primary" disabled={savingAnnotation || !comment.trim()} onClick={() => void saveHighlight()}>保存批注</button></>}<button disabled={savingAnnotation} onClick={() => { setSelection(null); regionOperation.current = null; setRegionResult(null); }}>取消</button></div>}
    {!!pageAnnotations.length && <aside className="annotation-list"><b>本页标记</b>{pageAnnotations.map(annotation => <div key={annotation.id}><span>{annotation.type === 'highlight' ? '高亮' : annotation.type === 'region' ? '框选' : '批注'} · {annotation.anchor.quote || annotation.text || annotation.ocrText || '第 ' + page + ' 页'}</span><button disabled={deleting} onClick={() => onShowAnnotation(annotation.id)}>查看</button></div>)}</aside>}
    </div>}
    </div>
    {ocr && <div className="modal-backdrop"><div className="dialog ocr-dialog" role="dialog" aria-label="扫描文字识别"><div className="dialog-head"><h2>扫描文字识别</h2><button disabled={savingAnnotation} onClick={() => setOcr(null)}><X/></button></div>{ocr.status !== 'done' && !ocr.error ? <><p>{ocr.status} · {Math.round(ocr.progress * 100)}%</p><progress max="1" value={ocr.progress}/><div className="dialog-actions"><button onClick={() => { void reader().cancelOcr(ocr.jobId); setOcr(null); }}>取消识别</button></div></> : ocr.error ? <><p>识别失败：{ocr.error}</p><p>图片摘录已经保留。</p></> : <><p>请核对并修改识别结果，再插入笔记。</p><textarea disabled={savingAnnotation || !!ocr.result?.saved} value={ocr.text} onChange={event => { ocrTextAction.current = null; setOcr({ ...ocr, text: event.target.value, result: undefined }); }}/>{ocr.result?.error && <p role="status">{ocr.result.error}</p>}<div className="dialog-actions"><button disabled={savingAnnotation} onClick={() => setOcr(null)}>只保留图片</button><button className="primary" disabled={savingAnnotation} onClick={() => void acceptOcr()}>{ocr.result?.saved ? '重试摘录' : '确认并插入文字'}</button></div></>}</div></div>}
  </section>;
}
