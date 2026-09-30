import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowLeftRight, BookOpen, ChevronLeft, ChevronRight, Columns2, Copy, Crop, List, FileText, Folder, FolderOpen, FolderPlus, FolderTree, Highlighter, Maximize2, MessageSquare, Minimize2, Minus, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Square, Sun, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { EpubAnchor, EpubAnnotation, EpubMeta, MarkdownScrollMemory, NoteRead, PdfAnchor, PdfAnnotation, PdfMeta, PdfRect, ReaderAnchor, RecoveryCheckResult, RecoveryV1, SaveNoteResult, WorkspaceFile } from '../types';
import { reader, resolveLocal, NOTE_BODY_FONTS, EPUB_MIN_SPREAD_WIDTH, type ActivePdf, type ActiveEpub, type FlatNavItem, type OcrDialog, type NoteMode, type NoteBodyFont, type SaveLabel, type FindCommand } from '../readerContext';
import * as pdfjsLib from 'pdfjs-dist';
import type { OcrProgress } from '../types';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { findPdfPageMatches, pdfPageText, type PdfSearchMatch } from '../pdfSearch';
import { stepMatchIndex } from '../findReplace';
import { domRangeForMatch, findDomMatch } from '../editor/domFind';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
// PDF.js 6 loads JBIG2/OpenJPEG/ICC decoders on demand.  The desktop build
// runs from a file:// URL, so leaving wasmUrl unset makes the fallback module
// resolve as a bare (and invalid) module specifier.  Keep the decoder bundle
// beside the app's renderer assets and give PDF.js an explicit directory URL.
const pdfWasmUrl = new URL('pdfjs/wasm/', document.baseURI).toString();
type PdfTool = 'select' | 'highlight' | 'region' | 'note';
export function PdfPane({ pdf, page, setPage, scale, setScale, fullscreen, onToggleFullscreen, onMeta, notePath, onExcerpt, target, onMessage }: { pdf: ActivePdf | null; page: number; setPage: (page: number) => void; scale: number; setScale: (scale: number) => void; fullscreen: boolean; onToggleFullscreen: () => void; onMeta: (change: (current: PdfMeta) => PdfMeta) => Promise<boolean>; notePath: string | null; onExcerpt: (asset: string | null, anchor: PdfAnchor, quote?: string) => Promise<void>; target: PdfAnchor | null; onMessage: (message: string) => void }) {
  const [document, setDocument] = useState<any>(null);
  const [pages, setPages] = useState(0), [tool, setTool] = useState<PdfTool>('select');
  const [pageDraft, setPageDraft] = useState(String(page));
  const [toc, setToc] = useState<{ title: string; depth: number; dest: any }[]>([]), [showToc, setShowToc] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false), [searchText, setSearchText] = useState('');
  const [searchCase, setSearchCase] = useState(false), [searching, setSearching] = useState(false);
  const [searchMatches, setSearchMatches] = useState<PdfSearchMatch[]>([]), [searchIndex, setSearchIndex] = useState(-1);
  const [searchStatus, setSearchStatus] = useState({ processed: 0, totalPages: 0, totalMatches: 0, errors: 0, truncated: false });
  const [size, setSize] = useState({ width: 595, height: 842 });
  const pane = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null), pageInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null), lastPage = useRef(0), searchGeneration = useRef(0);
  const zoomAnchor = useRef<{ page: number; ratio: number; scale: number; token: number } | null>(null);
  const zoomToken = useRef(0), restoringZoom = useRef(false);
  const pageTextCache = useRef(new Map<number, string>());
  const pageTextErrors = useRef(new Set<number>());
  const latest = useRef({ pdf, onMeta }); latest.current = { pdf, onMeta };
  useEffect(() => {
    setDocument(null); setPages(0); setToc([]); setSearchMatches([]); setSearchIndex(-1); setSearching(false); setSearchStatus({ processed: 0, totalPages: 0, totalMatches: 0, errors: 0, truncated: false }); pageTextCache.current.clear(); pageTextErrors.current.clear(); lastPage.current = 0; zoomToken.current += 1; zoomAnchor.current = null; restoringZoom.current = false; searchGeneration.current += 1;
    if (!pdf) return;
    let disposed = false;
    const bytes = pdf.data instanceof Uint8Array ? new Uint8Array(pdf.data) : new Uint8Array(pdf.data as ArrayBufferLike);
    const task = pdfjsLib.getDocument({ data: bytes, wasmUrl: pdfWasmUrl, useWasm: true });
    void task.promise.then(async doc => {
      const first = await doc.getPage(1); const viewport = first.getViewport({ scale: 1 });
      if (disposed) return;
      setSize({ width: viewport.width, height: viewport.height }); setDocument(doc); setPages(doc.numPages);
      const flatten = (items: any[], depth = 0): { title: string; depth: number; dest: any }[] => items.flatMap(item => [{ title: item.title, depth, dest: item.dest }, ...flatten(item.items || [], depth + 1)]);
      const outline = await doc.getOutline(); if (!disposed) setToc(flatten(outline || []));
    }).catch(error => { if (!disposed) onMessage('PDF 无法显示：' + error.message); });
    return () => { disposed = true; void task.destroy(); };
  }, [pdf?.path]);
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
      if (event.isComposing || event.keyCode === 229 || !event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== 'f') return;
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
    const flush = () => { const current = latest.current; if (current.pdf) void current.onMeta(meta => ({ ...meta, page })); };
    const timer = window.setTimeout(flush, 450);
    window.addEventListener('reader-flush', flush);
    return () => { clearTimeout(timer); window.removeEventListener('reader-flush', flush); };
  }, [page, pages, pdf?.path]);
  async function goToDestination(dest: any) {
    try {
      const resolved = typeof dest === 'string' ? await document.getDestination(dest) : dest;
      if (!resolved) return;
      const index = typeof resolved[0] === 'number' ? resolved[0] : await document.getPageIndex(resolved[0]); jump(index + 1);
    } catch (error) { onMessage('目录位置无法读取：' + String(error)); }
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
  return <section className="pane pdf-pane" ref={pane} tabIndex={-1} onPointerDownCapture={() => pane.current?.focus({ preventScroll: true })} onKeyDown={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'PageDown' || event.key === 'ArrowRight') { event.preventDefault(); jump(page + 1); }
    if (event.key === 'PageUp' || event.key === 'ArrowLeft') { event.preventDefault(); jump(page - 1); }
    if (event.key === 'Home') { event.preventDefault(); jump(1); }
    if (event.key === 'End' && pages) { event.preventDefault(); jump(pages); }
  }}>
    <div className="pane-toolbar pdf-navigation"><button className="icon-button" aria-label={showToc ? '收起 PDF 目录' : '展开 PDF 目录'} title="PDF 目录" onClick={() => setShowToc(value => !value)}><List size={17}/></button><div className="toolbar-group"><button className="icon-button" title="上一页（← / PageUp）" aria-label="上一页" onClick={() => jump(page - 1)}><ChevronLeft size={18}/></button><span className="page-control"><span>第</span><input ref={pageInput} aria-label="当前页码" inputMode="numeric" value={pageDraft} onChange={event => setPageDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitPageDraft(); } else if (event.key === 'Escape') { event.preventDefault(); setPageDraft(String(page)); (event.target as HTMLInputElement).blur(); } }} onBlur={() => setPageDraft(String(page))}/><span>/ {pages || '…'} 页</span></span><button className="icon-button" title="下一页（→ / PageDown）" aria-label="下一页" onClick={() => jump(page + 1)}><ChevronRight size={18}/></button></div><span className="toolbar-spacer"/><span className="keyboard-hints" aria-label="PDF 快捷键">←→ / PageUp PageDown</span><button className="icon-button" aria-label="在 PDF 中查找" title="在 PDF 中查找（Ctrl+F）" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }}><Search size={16}/></button><div className="toolbar-group zoom-control"><button className="icon-button" title="缩小" aria-label="缩小" onClick={() => requestScale((zoomAnchor.current?.scale ?? scale) - .15)}><ZoomOut size={17}/></button><span>{Math.round(scale * 100)}%</span><button className="icon-button" title="放大" aria-label="放大" onClick={() => requestScale((zoomAnchor.current?.scale ?? scale) + .15)}><ZoomIn size={17}/></button><button className="icon-button" aria-pressed={fullscreen} title={fullscreen ? '退出全屏阅读' : '进入全屏阅读'} aria-label={fullscreen ? '退出全屏阅读' : '进入全屏阅读'} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></div></div>
    {searchOpen && <div className="pdf-find-bar" role="search" aria-label="查找当前 PDF"><Search size={15}/><input ref={searchInput} aria-label="PDF 查找文本" placeholder="在这份 PDF 中查找" value={searchText} onChange={event => setSearchText(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); setSearchText(''); pane.current?.focus(); } else if (event.key === 'Enter' && searchMatches.length) setSearchIndex(index => stepMatchIndex(searchMatches.length, index, event.shiftKey ? -1 : 1)); }}/><span className="pdf-find-progress" aria-live="polite">{searching ? `已检索 ${searchStatus.processed}/${searchStatus.totalPages} 页` : searchStatus.errors ? `${searchStatus.errors} 页无法提取文字` : ''}</span><span className="find-count" aria-live="polite">{searching ? `${searchStatus.totalMatches} 项` : searchStatus.totalMatches ? (searchStatus.truncated ? `${searchIndex + 1} / 5000 · 共 ${searchStatus.totalMatches}` : `${searchIndex + 1} / ${searchStatus.totalMatches}`) : '0 / 0'}</span><button className={searchCase ? 'selected' : ''} aria-label="PDF 搜索区分大小写" aria-pressed={searchCase} title="区分大小写" onClick={() => setSearchCase(value => !value)}>Aa</button><button aria-label="上一个 PDF 匹配" disabled={!searchMatches.length} onClick={() => setSearchIndex(index => stepMatchIndex(searchMatches.length, index, -1))}>↑</button><button aria-label="下一个 PDF 匹配" disabled={!searchMatches.length} onClick={() => setSearchIndex(index => stepMatchIndex(searchMatches.length, index, 1))}>↓</button><button aria-label="关闭 PDF 查找" title="关闭（Esc）" onClick={() => { setSearchOpen(false); setSearchText(''); pane.current?.focus(); }}>×</button></div>}
    <div className="pdf-tools" role="toolbar" aria-label="PDF 标记工具"><button aria-pressed={tool === 'select'} className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}>选择</button><button aria-pressed={tool === 'highlight'} className={tool === 'highlight' ? 'on' : ''} onClick={() => setTool('highlight')}><Highlighter size={16}/>文字高亮</button><button aria-pressed={tool === 'region'} className={tool === 'region' ? 'on' : ''} onClick={() => setTool('region')}><Crop size={16}/>框选</button><button aria-pressed={tool === 'note'} className={tool === 'note' ? 'on' : ''} onClick={() => setTool('note')}><MessageSquare size={16}/>批注</button></div>

    <div className="pdf-reader-body">
      {showToc && <aside className="pdf-outline" aria-label="PDF 目录"><div className="outline-title">目录</div>{toc.length ? toc.map((item,index) => <button key={index} style={{ paddingLeft: 10 + item.depth * 12 }} title={item.title} onClick={() => void goToDestination(item.dest)}>{item.title}</button>) : <><p>这份 PDF 没有内置目录，可按页跳转。</p>{Array.from({ length: pages },(_,index) => <button key={index} onClick={() => jump(index + 1)}>第 {index + 1} 页</button>)}</>}</aside>}
      <div className="pdf-canvas-wrap continuous-pdf" ref={scroll} onScroll={() => {
        if (restoringZoom.current) return;
        const host = scroll.current; if (!host) return;
        const top = host.getBoundingClientRect().top;
        const visible = [...host.querySelectorAll<HTMLElement>('[data-pdf-page]')].find(element => element.getBoundingClientRect().bottom > top + 80);
        const number = Number(visible?.dataset.pdfPage); if (number && number !== lastPage.current) { lastPage.current = number; setPage(number); }
      }}>
        {!pdf ? <div className="empty-state"><BookOpen size={28}/><p>打开 PDF 或 EPUB 开始阅读</p></div> : !document ? <div className="empty-state">正在载入 PDF…</div> : Array.from({ length: pages }, (_, index) => <PdfPageSlot key={pdf.path + index} document={document} number={index+1} scale={scale} size={size} root={scroll}><PdfPage document={document} pdf={pdf} page={index + 1} setPage={setPage} scale={scale} setScale={setScale} onMeta={onMeta} notePath={notePath} onExcerpt={onExcerpt} target={target} onMessage={onMessage} tool={tool} search={currentSearch?.page === index + 1 ? { query: searchText.trim(), occurrence: currentSearch.occurrence, caseSensitive: searchCase } : null}/></PdfPageSlot>)}
      </div>
    </div>
  </section>;
}

function PdfPageSlot({ document, number, scale, size, root, children }: { document: any; number: number; scale: number; size: { width: number; height: number }; root: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false), [actual, setActual] = useState(size);
  useEffect(() => {
    let disposed = false;
    const observer = new IntersectionObserver(entries => { setVisible(entries[0].isIntersecting); if (entries[0].isIntersecting) void document.getPage(number).then((page: any) => { if (!disposed) { const viewport = page.getViewport({ scale: 1 }); setActual({ width: viewport.width, height: viewport.height }); } }); }, { root: root.current, rootMargin: '900px' });
    if (host.current) observer.observe(host.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [document, number]);
  return <div className="pdf-page-slot" ref={host} data-pdf-page={number} style={{ width: actual.width * scale, minHeight: actual.height * scale }}><span className="pdf-page-label">{number}</span>{visible ? children : <div style={{ height: actual.height * scale }}/>}</div>;
}

function PdfPage({ pdf, page, setPage, scale, setScale, onMeta, notePath, onExcerpt, target, onMessage, document: sharedDocument, tool, search }: { document: any; tool: PdfTool; pdf: ActivePdf | null; page: number; setPage: (page: number) => void; scale: number; setScale: (scale: number) => void; onMeta: (change: (current: PdfMeta) => PdfMeta) => Promise<boolean>; notePath: string | null; onExcerpt: (asset: string | null, anchor: PdfAnchor, quote?: string) => Promise<void>; target: PdfAnchor | null; onMessage: (message: string) => void; search: { query: string; occurrence: number; caseSensitive: boolean } | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const pdfDocument = useRef<any>(null);
  const renderTask = useRef<any>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [pages, setPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [textRevision, setTextRevision] = useState(0);
  const [searchRects, setSearchRects] = useState<{ left: number; top: number; width: number; height: number }[]>([]);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);

  const [selection, setSelection] = useState<PdfRect[] | null>(null);
  const [quote, setQuote] = useState('');
  const [comment, setComment] = useState('');
  const [ocr, setOcr] = useState<OcrDialog | null>(null);
  const [deletedAnnotation, setDeletedAnnotation] = useState<{ annotation: PdfAnnotation; index: number } | null>(null);
  useEffect(() => {
    if (!deletedAnnotation) return;
    const timer = window.setTimeout(() => setDeletedAnnotation(null), 7000);
    return () => window.clearTimeout(timer);
  }, [deletedAnnotation]);

  pdfDocument.current = sharedDocument;
  useEffect(() => {
    const document = pdfDocument.current; if (!document || !canvas.current || !textLayer.current) return;
    let cancelled = false; setLoading(true);
    void (async () => {
      try {
        const pdfPage = await document.getPage(Math.min(page, document.numPages));
        setRotation((((pdfPage.rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270);
        const viewport = pdfPage.getViewport({ scale });
        if (cancelled || !canvas.current) return;
        const outputScale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const currentCanvas = canvas.current!; currentCanvas.width = Math.ceil(viewport.width * outputScale); currentCanvas.height = Math.ceil(viewport.height * outputScale);
        currentCanvas.style.width = `${viewport.width}px`; currentCanvas.style.height = `${viewport.height}px`;
        renderTask.current?.cancel?.();
        const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
        renderTask.current = pdfPage.render({ canvas: currentCanvas, canvasContext: currentCanvas.getContext('2d')!, viewport, transform });
        await renderTask.current.promise;
        if (cancelled || !textLayer.current) return;
        const layer = textLayer.current!; layer.replaceChildren(); layer.style.width = `${viewport.width}px`; layer.style.height = `${viewport.height}px`;
        layer.style.setProperty('--scale-factor', String(viewport.scale));
        layer.style.setProperty('--total-scale-factor', String(viewport.scale));
        const text = await pdfPage.getTextContent();
        const textTask = new pdfjsLib.TextLayer({ textContentSource: text, container: layer, viewport });
        await textTask.render();
        if (!cancelled) setTextRevision(value => value + 1);
      } catch (error: any) { if (error?.name !== 'RenderingCancelledException') onMessage(`页面显示失败：${error?.message || error}`); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; renderTask.current?.cancel?.(); };
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
      setSearchRects([...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
        left: rect.left - bounds.left - 2,
        top: rect.top - bounds.top,
        width: rect.width + 4,
        height: rect.height,
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
    if (tool !== 'region' || !dragStart.current) return;
    const end = point(event); const start = dragStart.current; dragStart.current = null;
    const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    if (rect.w > .006 && rect.h > .006) setSelection([rect]);
  }
  function captureTextSelection() {
    if (tool !== 'highlight' || !holder.current) return;
    const selected = window.getSelection(); if (!selected || selected.isCollapsed) return;
    const bounds = holder.current.getBoundingClientRect();
    const rects = Array.from(selected.getRangeAt(0).getClientRects()).map(rect => ({ x: (rect.left - bounds.left) / bounds.width, y: (rect.top - bounds.top) / bounds.height, w: rect.width / bounds.width, h: rect.height / bounds.height })).filter(rect => rect.w > 0 && rect.h > 0 && rect.x >= -.01 && rect.y >= -.01 && rect.x < 1 && rect.y < 1);
    if (rects.length) { setSelection(rects); setQuote(selected.toString().trim()); }
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
    const annotation: PdfAnnotation = { id: crypto.randomUUID(), type, anchor: { pdfId: pdf.meta.id, page, rects: selection, rotation, quote: quote || undefined }, color: '#e4c95b', createdAt: new Date().toISOString(), ...options };
    if (!(await onMeta(meta => ({ ...meta, page, annotations: [...meta.annotations, annotation] })))) return null;
    return annotation;
  }
  async function saveHighlight() {
    const annotation = await storeAnnotation(tool === 'note' ? 'note' : 'highlight', tool === 'note' ? { text: comment } : {});
    if (annotation && quote && notePath) await onExcerpt(null, annotation.anchor, quote);
    if (annotation) { setSelection(null); setQuote(''); setComment(''); window.getSelection()?.removeAllRanges(); }
  }
  async function saveRegion(doOcr = false) {
    if (!pdf || !selection?.[0]) return;
    try {
      const bytes = await cropPng(selection[0]);
      const sourcePath = notePath || pdf.path;
      const imagePath = await reader().saveAttachment({ sourcePath, data: bytes, extension: 'png' });
      const annotation = await storeAnnotation('region', { attachment: imagePath });
      if (!annotation) return;
      if (notePath) await onExcerpt(imagePath, annotation.anchor);
      if (doOcr) {
        const unsubscribe = reader().onOcrProgress(() => {}); unsubscribe();
        const { jobId } = await reader().startOcr({ image: bytes, languages: ['chi_sim', 'chi_tra', 'eng'] });
        setOcr({ jobId, annotation, imagePath, progress: 0, status: '正在准备识别', text: '' });
      }
      setSelection(null);
    } catch (error) { onMessage(`框选处理失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  async function acceptOcr() {
    if (!ocr || !pdf) return;
    if (!(await onMeta(meta => ({ ...meta, annotations: meta.annotations.map(annotation => annotation.id === ocr.annotation.id ? { ...annotation, ocrText: ocr.text } : annotation) })))) return;
    if (notePath && ocr.text.trim()) await onExcerpt(null, ocr.annotation.anchor, ocr.text.trim());
    setOcr(null);
  }
  async function removeAnnotation(id: string) {
    if (!pdf) return;
    const index = pdf.meta.annotations.findIndex(annotation => annotation.id === id);
    const annotation = pdf.meta.annotations[index];
    if (!annotation) return;
    if (!(await onMeta(meta => ({ ...meta, annotations: meta.annotations.filter(item => item.id !== id) })))) return;
    setDeletedAnnotation({ annotation, index });
  }
  async function undoDelete() {
    if (!pdf || !deletedAnnotation) return;
    if (await onMeta(meta => {
      const annotations = [...meta.annotations];
      annotations.splice(Math.max(0, Math.min(deletedAnnotation.index, annotations.length)), 0, deletedAnnotation.annotation);
      return { ...meta, annotations };
    })) setDeletedAnnotation(null);
  }

  return <section className="pdf-page-content">
    <div className="pdf-page-inner">{!pdf ? <div className="empty-state"><span className="empty-icon"><BookOpen size={28}/></span><p>打开 PDF 或 EPUB 开始阅读</p><small>文件会留在原来的磁盘位置</small></div> : <div className="pdf-stage"><div className="canvas-holder" ref={holder} style={{ width: canvas.current?.style.width, height: canvas.current?.style.height }} onMouseUp={captureTextSelection} onPointerDown={event => { if (tool === 'region') { dragStart.current = point(event); setSelection(null); } else if (tool === 'note') { const at = point(event); setSelection([{ x: at.x, y: at.y, w: .025, h: .025 }]); } }} onPointerUp={finishRegion}>
      <canvas ref={canvas}/><div ref={textLayer} className="textLayer"/><div className="pdf-search-layer" aria-hidden="true">{searchRects.map((rect, index) => <span className="pdf-search-hit" key={index} style={rect}/>)}</div>
      <div className={'draw-layer ' + (tool === 'region' || tool === 'note' ? 'interactive' : '')}>
        {pageAnnotations.flatMap(annotation => annotation.anchor.rects.map((rect, index) => <button title={annotation.text || annotation.comment || annotation.anchor.quote || '标记'} className={`annotation ${annotation.type} ${target && target.pdfId === annotation.anchor.pdfId && target.page === annotation.anchor.page ? 'flash' : ''}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} key={`${annotation.id}-${index}`} onClick={() => void removeAnnotation(annotation.id)}><span className="sr-only">删除标记</span></button>))}
        {selection?.map((rect, index) => <div className="selection-box" key={index} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}/>) }
      </div>{loading && <div className="loading">正在载入页面…</div>}
    </div>
    {selection && <div className="selection-actions">{tool === 'region' ? <><button onClick={() => void saveRegion(false)}>保存图片摘录</button><button className="primary" onClick={() => void saveRegion(true)}>识别文字并摘录</button></> : tool === 'note' ? <><input autoFocus value={comment} onChange={event => setComment(event.target.value)} placeholder="写下批注"/><button className="primary" disabled={!comment.trim()} onClick={() => void saveHighlight()}>保存批注</button></> : <button className="primary" onClick={() => void saveHighlight()}>保存高亮{notePath ? '并摘录' : ''}</button>}<button onClick={() => { setSelection(null); setQuote(''); }}>取消</button></div>}
    {deletedAnnotation && <div className="inline-undo" role="status">已删除一条 PDF 标记<button onClick={() => void undoDelete()}>撤销</button><button aria-label="关闭撤销提示" onClick={() => setDeletedAnnotation(null)}>×</button></div>}
    {!!pageAnnotations.length && <aside className="annotation-list"><b>本页标记</b>{pageAnnotations.map(annotation => <div key={annotation.id}><span>{annotation.type === 'highlight' ? '高亮' : annotation.type === 'region' ? '框选' : '批注'} · {annotation.anchor.quote || annotation.text || annotation.ocrText || '第 ' + page + ' 页'}</span><button onClick={() => void removeAnnotation(annotation.id)}><Trash2 size={13}/></button></div>)}</aside>}
    </div>}
    </div>
    {ocr && <div className="modal-backdrop"><div className="dialog ocr-dialog"><div className="dialog-head"><h2>扫描文字识别</h2><button onClick={() => setOcr(null)}><X/></button></div>{ocr.status !== 'done' && !ocr.error ? <><p>{ocr.status} · {Math.round(ocr.progress * 100)}%</p><progress max="1" value={ocr.progress}/><div className="dialog-actions"><button onClick={() => { void reader().cancelOcr(ocr.jobId); setOcr(null); }}>取消识别</button></div></> : ocr.error ? <><p>识别失败：{ocr.error}</p><p>图片摘录已经保留。</p></> : <><p>请核对并修改识别结果，再插入笔记。</p><textarea value={ocr.text} onChange={event => setOcr({ ...ocr, text: event.target.value })}/><div className="dialog-actions"><button onClick={() => setOcr(null)}>只保留图片</button><button className="primary" onClick={() => void acceptOcr()}>确认并插入文字</button></div></>}</div></div>}
  </section>;
}
