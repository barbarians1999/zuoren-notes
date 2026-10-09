import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { EpubAnchor, EpubAnnotation, EpubMeta } from '../types';
import { NOTE_BODY_FONTS, EPUB_MIN_SPREAD_WIDTH, type ActiveEpub, type FlatNavItem, type NoteBodyFont } from '../readerContext';
import ePub, { type Book, type Location, type NavItem, type Rendition } from 'epubjs';
import { annotationExcerpt, updateAnnotationComment } from '../epubAnnotationActions.cjs';
import { THEMES, type ThemeName } from '../appearanceTheme.cjs';
import { EpubSearchPanel } from './EpubSearchPanel';
import type { EpubSearchResult } from './epubSearch';
import type { ExcerptFlowResult } from './excerptFlow';
function flattenToc(items: NavItem[], depth = 0): FlatNavItem[] {
  return items.flatMap(item => [{ href: item.href, label: item.label.trim(), depth }, ...flattenToc(item.subitems || [], depth + 1)]);
}

const EPUB_THEME_STYLE_ID = 'zuoren-notes-epub-theme';
function epubThemeCss(theme: ThemeName, fontFamily: string) {
  const { colors, colorScheme } = THEMES[theme];
  return `
    :root { color-scheme: ${colorScheme}; }
    html, body { background: ${colors.surface} !important; color: ${colors.text} !important; }
    body { max-width: 880px; margin: 0 auto !important; padding: 32px clamp(22px, 4vw, 56px) 72px !important; font-family: ${fontFamily} !important; line-height: 1.95 !important; letter-spacing: .015em; }
    body, p, li, dt, dd, blockquote, table, th, td, h1, h2, h3, h4, h5, h6 { font-family: ${fontFamily} !important; }
    p, li, dt, dd, table, th, td { color: ${colors.text} !important; }
    span { color: inherit !important; }
    h1, h2, h3, h4, h5, h6 { color: ${colors.heading} !important; line-height: 1.35 !important; }
    h1 { margin: .15em 0 .8em !important; font-size: 2em !important; }
    h2 { margin: 1.6em 0 .65em !important; font-size: 1.48em !important; }
    h3 { margin: 1.4em 0 .55em !important; font-size: 1.2em !important; }
    p { margin: .72em 0 !important; }
    blockquote { margin: 1.2em 0 !important; padding-left: 1em !important; border-left: 3px solid ${colors['quote-line']} !important; color: ${colors.quote} !important; }
    a { color: ${colors.link} !important; text-underline-offset: 3px; }
    code, pre { font-family: "Cascadia Code", ui-monospace, monospace !important; color: ${colors.text} !important; background: ${colors['code-bg']} !important; }
    th, td { border-color: ${colors.line} !important; }
    th { background: ${colors['surface-muted']} !important; }
    mark { background: ${colors['mark-bg']} !important; color: ${colors['mark-text']} !important; }
    img, svg { max-width: 100% !important; height: auto !important; }
    hr { border-color: ${colors.line} !important; }
  `;
}

function applyEpubTheme(contentsOrView: any, theme: ThemeName, fontFamily: string) {
  const contents = contentsOrView?.document ? contentsOrView : contentsOrView?.contents;
  const document = contents?.document as Document | undefined;
  if (!document?.head) return;
  let style = document.getElementById(EPUB_THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = EPUB_THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = epubThemeCss(theme, fontFamily);
}

export function EpubPane({ epub, theme, noteBodyFont, onMeta, onMessage, onExcerpt, onSelectionAction, excerptTarget, target }: { epub: ActiveEpub; theme: ThemeName; noteBodyFont: NoteBodyFont; onMeta: (change: (current: EpubMeta) => EpubMeta) => Promise<boolean>; onMessage: (message: string) => void; onExcerpt: (anchor: EpubAnchor, quote: string, comment: string) => Promise<ExcerptFlowResult>; onSelectionAction: (annotation: EpubAnnotation, excerpt: boolean) => Promise<ExcerptFlowResult>; excerptTarget: string | null; target: EpubAnchor | null }) {
  const host = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const metaRef = useRef(epub.meta);
  const readingPosition = useRef({ cfi: epub.meta.cfi, progress: epub.meta.progress, fontSize: epub.meta.fontSize });
  const generationRef = useRef(0);
  const savingRef = useRef(false);
  const selectionActionGeneration = useRef(0);
  const [selectionFlow, setSelectionFlow] = useState<ExcerptFlowResult | null>(null);
  const selectionAnnotation = useRef<EpubAnnotation | null>(null);
  const [annotationFlows, setAnnotationFlows] = useState<Record<string, ExcerptFlowResult>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const searchHighlight = useRef<string | null>(null), searchJumpToken = useRef(0);
  const showSearchRef = useRef(() => {});
  showSearchRef.current = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => host.current?.parentElement?.querySelector<HTMLInputElement>('[aria-label="EPUB 搜索文本"]')?.focus());
  };
  const metaWriter = useRef(onMeta); metaWriter.current = onMeta;
  useEffect(() => {
    const flush = () => {
      // display() can finish before epub.js emits its RAF-delayed relocation.
      // Capture the visible CFI synchronously before main awaits this write.
      try {
        // epub.js types expose the deprecated flat shape; runtime returns Location.
        const location = renditionRef.current?.currentLocation() as unknown as Location | undefined;
        if (location?.start?.cfi) readingPosition.current = { ...readingPosition.current, cfi: location.start.cfi };
      } catch { /* retain the last confirmed position while layout is unavailable */ }
      const position = { ...readingPosition.current };
      void metaWriter.current(current => ({ ...current, ...position }));
    };
    window.addEventListener('reader-flush', flush);
    return () => window.removeEventListener('reader-flush', flush);
  }, [epub.path]);
  const [toc, setToc] = useState<FlatNavItem[]>([]);
  const [currentHref, setCurrentHref] = useState('');
  const [chapter, setChapter] = useState('');
  const [progress, setProgress] = useState(epub.meta.progress || 0);
  const [fontSize, setFontSize] = useState(epub.meta.fontSize || 100);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Pick<EpubAnnotation, 'cfiRange' | 'quote' | 'chapterHref' | 'chapterLabel'> | null>(null);
  const [comment, setComment] = useState('');
  const [annotationsOpen, setAnnotationsOpen] = useState(() => (epub.meta.annotations?.length || 0) > 0);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState('');
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [deletedAnnotation, setDeletedAnnotation] = useState<{ annotation: EpubAnnotation; index: number } | null>(null);
  const epubStyleRef = useRef({ theme, fontFamily: NOTE_BODY_FONTS[noteBodyFont] });
  epubStyleRef.current = { theme, fontFamily: NOTE_BODY_FONTS[noteBodyFont] };

  useEffect(() => { metaRef.current = epub.meta; }, [epub.meta]);
  useEffect(() => {
    if (!deletedAnnotation || savingAnnotation) return;
    const timer = window.setTimeout(() => setDeletedAnnotation(null), 7000);
    return () => window.clearTimeout(timer);
  }, [deletedAnnotation, savingAnnotation]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    const generation = ++generationRef.current;
    let locationsReady = false;
    let relocated: ((location: Location) => void) | null = null;
    let selectedListener: ((cfiRange: string, contents: any) => void) | null = null;
    let flat: FlatNavItem[] = [];
    const pageInputDocuments = new Set<Document>();
    let navigationLocked = false;
    let navigationReleaseTimer = 0;
    const previousTabIndex = element.getAttribute('tabindex');
    element.tabIndex = -1;
    setLoading(true); setToc([]); setCurrentHref(''); setChapter('');
    setSelection(null); setComment('');
    setProgress(epub.meta.progress || 0); setFontSize(epub.meta.fontSize || 100);
    metaRef.current = epub.meta;
    element.replaceChildren();

    const source = epub.data.slice().buffer as ArrayBuffer;
    const book = ePub(source, { replacements: 'blobUrl' });
    const rendition = book.renderTo(element, { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', minSpreadWidth: EPUB_MIN_SPREAD_WIDTH, allowScriptedContent: false });
    const navigatePage = (direction: 'next' | 'prev') => {
      if (disposed || navigationLocked) return;
      navigationLocked = true;
      const request = direction === 'next' ? rendition.next() : rendition.prev();
      void request.catch(() => undefined).finally(() => {
        if (!disposed) element.focus({ preventScroll: true });
        window.clearTimeout(navigationReleaseTimer);
        navigationReleaseTimer = window.setTimeout(() => { navigationLocked = false; }, 180);
      });
    };
    const handlePageKeyDown = (event: KeyboardEvent) => {
      if ((event.key === 'F6' || event.key === 'F11') && !event.repeat && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && event.currentTarget !== element) {
        event.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: event.key })); return;
      }
      if (!event.defaultPrevented && !event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation(); showSearchRef.current(); return;
      }
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); event.stopPropagation();
      navigatePage(event.key === 'ArrowRight' ? 'next' : 'prev');
    };
    const bindPageKeyNavigation = (contentsOrView: any) => {
      const contents = contentsOrView?.document ? contentsOrView : contentsOrView?.contents;
      const document = contents?.document as Document | undefined;
      if (!document || pageInputDocuments.has(document)) return;
      document.addEventListener('keydown', handlePageKeyDown, true);
      document.addEventListener('wheel', handleWheel, { passive: false });
      pageInputDocuments.add(document);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (Math.abs(delta) < 8) return;
      event.preventDefault();
      navigatePage(delta > 0 ? 'next' : 'prev');
    };
    element.addEventListener('keydown', handlePageKeyDown, true);
    element.addEventListener('wheel', handleWheel, { passive: false });
    const applyCurrentTheme = (contentsOrView: any) => {
      const style = epubStyleRef.current;
      bindPageKeyNavigation(contentsOrView);
      applyEpubTheme(contentsOrView, style.theme, style.fontFamily);
    };
    rendition.hooks.content.register(applyCurrentTheme);
    rendition.hooks.render.register(applyCurrentTheme);
    bookRef.current = book; renditionRef.current = rendition;
    selectedListener = (cfiRange, contents) => {
      if (disposed || generationRef.current !== generation || typeof cfiRange !== 'string') return;
      try {
        const quote = String(contents?.range?.(cfiRange)?.toString?.() || '').trim().slice(0, 20000);
        if (!quote) return;
        const href = String(contents?.section?.href || currentHref || '').split('#')[0];
        const item = flat.find(entry => entry.href.split('#')[0] === href);
        setSelection({ cfiRange, quote, chapterHref: href || undefined, chapterLabel: item?.label || chapter || undefined });
        selectionActionGeneration.current += 1;
        setComment(''); setSelectionFlow(null); selectionAnnotation.current = null;
      } catch { /* an incomplete or invalid iframe range is not actionable */ }
    };
    rendition.on('selected', selectedListener);
    rendition.themes.fontSize(`${epub.meta.fontSize || 100}%`);

    let resizeFrame = 0;
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (!bounds || bounds.width < 1 || bounds.height < 1 || disposed) return;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const manager = (rendition as Rendition & { manager?: { resize?: (width: number, height: number) => void } }).manager;
        if (!disposed && manager?.resize) {
          try { rendition.resize(Math.round(bounds.width), Math.round(bounds.height)); } catch { /* ePub may be between view unload/load */ }
        }
      });
    });
    resizeObserver?.observe(element);

    void (async () => {
      try {
        const [navigation, spine] = await Promise.all([book.loaded.navigation, book.loaded.spine]);
        if (disposed) return;
        flat = flattenToc(navigation.toc || []);
        setToc(flat);
        relocated = (location: Location) => {
          if (disposed || generationRef.current !== generation || !location?.start) return;
          const href = location.start.href || '';
          const normalized = href.split('#')[0];
          const item = flat.find(entry => entry.href.split('#')[0] === normalized);
          const displayed = location.start.displayed;
          const pageFraction = displayed?.total > 0 ? Math.max(0, displayed.page - 1) / displayed.total : 0;
          const tocIndex = Math.max(0, flat.findIndex(entry => entry.href.split('#')[0] === normalized));
          const sectionIndex = Number.isFinite(location.start.index) ? Math.max(0, location.start.index) : tocIndex;
          const chapterEstimate = (sectionIndex + pageFraction) / Math.max(1, spine.length);
          const measured = locationsReady && location.start.cfi ? book.locations.percentageFromCfi(location.start.cfi) : chapterEstimate;
          const nextProgress = Number.isFinite(measured) ? Math.min(1, Math.max(0, measured)) : 0;
          setCurrentHref(item?.href || href); setChapter(item?.label || '正文'); setProgress(nextProgress);
          const position = { cfi: location.start.cfi || '', progress: nextProgress };
          readingPosition.current = { ...readingPosition.current, ...position };
          void metaWriter.current(current => ({ ...current, ...position }));
        };
        rendition.on('relocated', relocated);
        const initialTarget = target?.epubId === epub.meta.id ? target.cfiRange : epub.meta.cfi || undefined;
        let usedFallback = false;
        try { await rendition.display(initialTarget); }
        catch (error) {
          if (disposed || generationRef.current !== generation) return;
          if (!initialTarget) throw error;
          // A stale CFI or deleted chapter must not make an intact book blank.
          // Only persist the fallback after display succeeds and relocates.
          await rendition.display();
          usedFallback = true;
        }
        if (!disposed && generationRef.current === generation) {
          const location = rendition.currentLocation() as unknown as Location | undefined;
          if (location?.start?.cfi) relocated(location);
          if (usedFallback) onMessage('原阅读位置已失效，已返回电子书起始章节。');
          for (const annotation of epub.meta.annotations || []) {
            try { rendition.annotations.highlight(annotation.cfiRange, { annotationId: annotation.id }, undefined, 'zhaoye-epub-highlight', { fill: '#e4c95b', 'fill-opacity': '0.42', 'mix-blend-mode': 'multiply' }); } catch { /* one stale CFI must not block the book */ }
          }
          setLoading(false);
        }
        void book.locations.generate(1500).then(() => { if (generationRef.current !== generation) return; locationsReady = true; return rendition.reportLocation(); }).catch(() => undefined);
      } catch (error) {
        if (!disposed) { setLoading(false); onMessage(`EPUB 无法显示：${error instanceof Error ? error.message : String(error)}`); }
      }
    })();

    return () => {
      disposed = true;
      searchJumpToken.current++; searchHighlight.current = null;
      if (generationRef.current === generation) generationRef.current++;
      window.clearTimeout(navigationReleaseTimer);
      element.removeEventListener('keydown', handlePageKeyDown, true);
      element.removeEventListener('wheel', handleWheel);
      for (const document of pageInputDocuments) {
        document.removeEventListener('keydown', handlePageKeyDown, true);
        document.removeEventListener('wheel', handleWheel);
      }
      pageInputDocuments.clear();
      if (previousTabIndex === null) element.removeAttribute('tabindex');
      else element.setAttribute('tabindex', previousTabIndex);
      rendition.hooks.content.deregister(applyCurrentTheme);
      rendition.hooks.render.deregister(applyCurrentTheme);
      resizeObserver?.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (relocated) rendition.off('relocated', relocated);
      if (selectedListener) rendition.off('selected', selectedListener);
      try { rendition.destroy(); } catch { /* already destroyed */ }
      try { book.destroy(); } catch { /* already destroyed */ }
      if (renditionRef.current === rendition) renditionRef.current = null;
      if (bookRef.current === book) bookRef.current = null;
      element.replaceChildren();
    };
  // The reader must stay mounted while only progress metadata changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epub.path]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    const contents = rendition.getContents() as unknown as any[];
    for (const content of Array.isArray(contents) ? contents : [contents]) applyEpubTheme(content, theme, NOTE_BODY_FONTS[noteBodyFont]);
  }, [theme, noteBodyFont]);

  useEffect(() => {
    if (!target || target.epubId !== epub.meta.id || loading) return;
    const rendition = renditionRef.current;
    const generation = generationRef.current;
    if (!rendition) return;
    void rendition.display(target.cfiRange).then(() => {
      if (generationRef.current !== generation) return;
      setFlashId(target.annotationId || epub.meta.annotations.find(item => item.cfiRange === target.cfiRange)?.id || null);
      window.setTimeout(() => setFlashId(value => value === target.annotationId ? null : value), 3500);
    }).catch(() => onMessage('无法定位这条 EPUB 标注。'));
  }, [target, epub.meta.id, loading]);

  async function saveSelection(excerpt: boolean) {
    if (!selection || savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    try {
      const generation = generationRef.current, actionGeneration = selectionActionGeneration.current;
      let outcome: ExcerptFlowResult, annotation = selectionAnnotation.current;
      if (selectionFlow?.retry) outcome = await selectionFlow.retry();
      else {
        const now = new Date().toISOString();
        annotation = {
          id: crypto.randomUUID(), kind: 'highlight', cfiRange: selection.cfiRange, quote: selection.quote,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...(selection.chapterHref ? { chapterHref: selection.chapterHref } : {}),
          ...(selection.chapterLabel ? { chapterLabel: selection.chapterLabel } : {}),
          createdAt: now, updatedAt: now,
        };
        selectionAnnotation.current = annotation;
        outcome = await onSelectionAction(annotation, excerpt);
      }
      if (generationRef.current !== generation) return;
      if (outcome.saved && !selectionFlow?.saved && annotation) renditionRef.current?.annotations.highlight(annotation.cfiRange, { annotationId: annotation.id }, undefined, 'zhaoye-epub-highlight', { fill: '#e4c95b', 'fill-opacity': '0.42', 'mix-blend-mode': 'multiply' });
      if (selectionActionGeneration.current !== actionGeneration) return;
      if (outcome.done) { setSelection(null); setComment(''); setSelectionFlow(null); selectionAnnotation.current = null; setDeleteConfirm(null); }
      else { setSelectionFlow(outcome); if (outcome.error) onMessage(outcome.error); }
    } catch (error) { onMessage(`EPUB 标注保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { savingRef.current = false; setSavingAnnotation(false); }
  }

  async function confirmDelete(annotation: EpubAnnotation) {
    if (savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    const previousMeta = metaRef.current;
    try {
      if (!(await onMeta(current => ({ ...current, annotations: current.annotations.filter(item => item.id !== annotation.id) })))) return;
      renditionRef.current?.annotations.remove(annotation.cfiRange, 'highlight');
      setDeleteConfirm(null); if (flashId === annotation.id) setFlashId(null);
      setDeletedAnnotation({ annotation, index: previousMeta.annotations.findIndex(item => item.id === annotation.id) });
    } finally { savingRef.current = false; setSavingAnnotation(false); }
  }

  async function saveAnnotationComment(annotation: EpubAnnotation) {
    if (savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    const commentText = editingComment.trim();
    const updatedAt = new Date().toISOString();
    try {
      if (!(await onMeta(current => ({ ...current, annotations: updateAnnotationComment(current.annotations, annotation.id, commentText, updatedAt) })))) return;
      setEditingAnnotation(null); setEditingComment('');
    } catch (error) { onMessage(`EPUB 批注保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { savingRef.current = false; setSavingAnnotation(false); }
  }

  async function excerptAnnotation(annotation: EpubAnnotation) {
    if (savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    try {
      const pending = annotationFlows[annotation.id];
      const excerpt = annotationExcerpt(epub.meta.id, annotation);
      const outcome = pending?.retry ? await pending.retry() : await onExcerpt(excerpt.anchor, excerpt.quote, excerpt.comment);
      setAnnotationFlows(current => {
        const next = { ...current };
        if (outcome.done) delete next[annotation.id]; else next[annotation.id] = outcome;
        return next;
      });
      if (outcome.error) onMessage(outcome.error);
    } catch (error) { onMessage(`无法插入 EPUB 摘录：${error instanceof Error ? error.message : String(error)}`); }
    finally { savingRef.current = false; setSavingAnnotation(false); }
  }

  async function jumpAnnotation(annotation: EpubAnnotation) {
    const generation = generationRef.current;
    try {
      await renditionRef.current?.display(annotation.cfiRange);
      if (generationRef.current === generation) { setFlashId(annotation.id); window.setTimeout(() => setFlashId(value => value === annotation.id ? null : value), 3500); }
    } catch { onMessage('无法定位这条 EPUB 标注。'); }
  }
  async function undoDelete() {
    if (!deletedAnnotation || savingRef.current) return;
    savingRef.current = true; setSavingAnnotation(true);
    try {
      if (!(await onMeta(current => {
        if (current.annotations.some(item => item.id === deletedAnnotation.annotation.id)) return current;
        const annotations = [...current.annotations];
        annotations.splice(Math.max(0, Math.min(deletedAnnotation.index, annotations.length)), 0, deletedAnnotation.annotation);
        return { ...current, annotations };
      }))) return;
      renditionRef.current?.annotations.highlight(deletedAnnotation.annotation.cfiRange, { annotationId: deletedAnnotation.annotation.id }, undefined, 'zhaoye-epub-highlight', { fill: '#e4c95b', 'fill-opacity': '0.42', 'mix-blend-mode': 'multiply' });
      setDeletedAnnotation(null);
    } finally { savingRef.current = false; setSavingAnnotation(false); }
  }

  function changeFont(next: number) {
    const value = Math.min(180, Math.max(70, next));
    setFontSize(value); renditionRef.current?.themes.fontSize(`${value}%`);
    readingPosition.current = { ...readingPosition.current, fontSize: value };
    void onMeta(current => ({ ...current, fontSize: value }));
  }
  function display(target: string) {
    if (target) { setLoading(true); void renditionRef.current?.display(target).finally(() => setLoading(false)); }
  }

  function clearSearchHighlight() {
    searchJumpToken.current++;
    if (searchHighlight.current) {
      try { renditionRef.current?.annotations.remove(searchHighlight.current, 'underline'); } catch { /* a disposed view has no search mark */ }
      searchHighlight.current = null;
    }
  }
  async function jumpSearch(result: EpubSearchResult): Promise<boolean> {
    clearSearchHighlight();
    const rendition = renditionRef.current, generation = generationRef.current, token = searchJumpToken.current;
    if (!rendition || loading) return false;
    try {
      await rendition.display(result.cfi);
      if (generationRef.current !== generation || searchJumpToken.current !== token) return false;
      // A separate annotation type cannot replace the user's saved highlights.
      rendition.annotations.underline(result.cfi, {}, undefined, 'zuoren-epub-search-hit', { stroke: THEMES[theme].colors.accent, 'stroke-width': '3', 'stroke-opacity': '1' });
      searchHighlight.current = result.cfi;
      return true;
    } catch {
      if (generationRef.current === generation && searchJumpToken.current === token) onMessage('无法定位这个 EPUB 搜索结果。');
      return false;
    }
  }
  function closeSearch() {
    clearSearchHighlight(); setSearchOpen(false); host.current?.focus({ preventScroll: true });
  }

  return <section className="pane epub-pane" onKeyDownCapture={event => {
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopPropagation(); showSearchRef.current();
    }
  }}>
    <div className="pane-toolbar epub-navigation">
      <button className="icon-button" title="上一节" aria-label="上一节" onClick={() => void renditionRef.current?.prev()}><ChevronLeft size={18}/></button>
      <select aria-label="EPUB 目录" value={toc.some(item => item.href === currentHref) ? currentHref : ''} onChange={event => display(event.target.value)}><option value="">目录</option>{toc.map(item => <option key={`${item.href}-${item.label}`} value={item.href}>{'　'.repeat(Math.min(3, item.depth))}{item.label}</option>)}</select>
      <span className="epub-chapter" title={chapter}>{chapter || (loading ? '正在打开…' : '正文')}</span>
      <button className="icon-button" title="下一节" aria-label="下一节" onClick={() => void renditionRef.current?.next()}><ChevronRight size={18}/></button>
      <span className="toolbar-spacer"/><span className="keyboard-hints" aria-label="EPUB 快捷键">←→ / 滚轮翻页</span>
      <button className="icon-button" aria-label="在 EPUB 中查找" title="全书搜索（Ctrl+F）" onClick={() => showSearchRef.current()}><Search size={16}/></button>
      <div className="toolbar-group epub-font-control"><button title="减小字号" aria-label="减小字号" onClick={() => changeFont(fontSize - 10)}>A−</button><span>{fontSize}%</span><button title="增大字号" aria-label="增大字号" onClick={() => changeFont(fontSize + 10)}>A＋</button></div>
    </div>
    <div className="epub-reader-shell"><div ref={host} className="epub-viewer"/>{loading && <div className="loading epub-loading">正在载入电子书…</div>}
      {searchOpen && <EpubSearchPanel data={epub.data} toc={toc} onNavigate={jumpSearch} onClose={closeSearch} onClear={clearSearchHighlight}/>}
      {selection && <div className="epub-selection-actions" role="group" aria-label="处理选中文本"><span title={selection.quote}>{selection.quote.slice(0, 72)}{selection.quote.length > 72 ? '…' : ''}</span>{selectionFlow ? <><span className="epub-flow-status" role="status">{selectionFlow.error || '操作尚未完成'}</span><button className="primary" disabled={savingAnnotation || !selectionFlow.retry} onClick={() => void saveSelection(false)}>{selectionFlow.saved ? '重试摘录' : '重试保存'}</button></> : <><input aria-label="EPUB 批注" maxLength={10000} value={comment} onChange={event => setComment(event.target.value)} placeholder="可选批注"/><button className="primary" disabled={savingAnnotation} onClick={() => void saveSelection(false)}>高亮</button><button disabled={savingAnnotation} onClick={() => void saveSelection(!!excerptTarget)}>{excerptTarget ? `批注并${excerptTarget}` : '批注'}</button></>}<button disabled={savingAnnotation} onClick={() => { selectionActionGeneration.current += 1; setSelection(null); setComment(''); setSelectionFlow(null); selectionAnnotation.current = null; }}>取消</button></div>}
    </div>
    <div className="epub-foot"><span>{chapter || '电子书'}</span><progress aria-label="阅读进度" max="1" value={progress}/><span>{Math.round(progress * 100)}%</span></div>
    <aside className="epub-annotation-panel"><button className="epub-annotation-toggle" aria-expanded={annotationsOpen} onClick={() => setAnnotationsOpen(value => !value)}>标注（{epub.meta.annotations.length}）{annotationsOpen ? '　收起' : '　展开'}</button>
      {annotationsOpen && <div className="epub-annotation-list">{epub.meta.annotations.map(annotation => <div className={'epub-annotation-item ' + (flashId === annotation.id ? 'current' : '')} key={annotation.id}>
        {editingAnnotation === annotation.id ? <div className="epub-annotation-edit"><textarea autoFocus aria-label="编辑批注" maxLength={10000} value={editingComment} onChange={event => setEditingComment(event.target.value)} placeholder="可选批注"/><div className="epub-annotation-actions"><button className="primary" disabled={savingAnnotation} onClick={() => void saveAnnotationComment(annotation)}>保存</button><button disabled={savingAnnotation} onClick={() => { setEditingAnnotation(null); setEditingComment(''); }}>取消</button></div></div> : <>
          <button className="epub-annotation-quote" title="跳转到这条标注" onClick={() => void jumpAnnotation(annotation)}><span>{annotation.quote}</span>{annotation.comment && <small>{annotation.comment}</small>}</button>
          <div className="epub-annotation-actions">
            {excerptTarget && <button aria-label={annotationFlows[annotation.id]?.retry ? '重试摘录' : excerptTarget} disabled={savingAnnotation} title={annotationFlows[annotation.id]?.retry ? '重试摘录' : excerptTarget} onClick={() => void excerptAnnotation(annotation)}>{annotationFlows[annotation.id]?.retry ? '重试摘录' : '摘录'}</button>}
            <button disabled={savingAnnotation} aria-label="编辑批注" title="编辑批注" onClick={() => { setDeleteConfirm(null); setEditingAnnotation(annotation.id); setEditingComment(annotation.comment || ''); }}>编辑</button>
            {deleteConfirm === annotation.id ? <div className="epub-delete-confirm"><button disabled={savingAnnotation} onClick={() => void confirmDelete(annotation)}>确认删除</button><button disabled={savingAnnotation} onClick={() => setDeleteConfirm(null)}>取消</button></div> : <button className="epub-delete-button" aria-label="删除标注" title="删除标注" disabled={savingAnnotation} onClick={() => setDeleteConfirm(annotation.id)}>删除</button>}
          </div>
        </>}
        {annotationFlows[annotation.id]?.error && <small className="epub-flow-status" role="status">{annotationFlows[annotation.id].error}</small>}
      </div>)}{!epub.meta.annotations.length && <small className="epub-annotation-empty">还没有标注</small>}</div>}
    </aside>
    {deletedAnnotation && <div className="inline-undo" role="status">已删除一条标注<button onClick={() => void undoDelete()} disabled={savingAnnotation}>撤销</button><button aria-label="关闭撤销提示" onClick={() => setDeletedAnnotation(null)}>×</button></div>}
  </section>;
}
