import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowLeftRight, BookOpen, ChevronLeft, ChevronRight, Columns2, Copy, Crop, List, FileText, Folder, FolderOpen, FolderPlus, FolderTree, Highlighter, Maximize2, MessageSquare, Minimize2, Minus, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Square, Sun, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { EpubAnchor, EpubAnnotation, EpubMeta, MarkdownScrollMemory, NoteRead, PdfAnchor, PdfAnnotation, PdfMeta, PdfRect, ReaderAnchor, RecoveryCheckResult, RecoveryV1, SaveNoteResult, WorkspaceFile } from '../types';
import { reader, resolveLocal, NOTE_BODY_FONTS, EPUB_MIN_SPREAD_WIDTH, type ActivePdf, type ActiveEpub, type FlatNavItem, type OcrDialog, type NoteMode, type NoteBodyFont, type SaveLabel, type FindCommand } from '../readerContext';
import ePub, { type Book, type Location, type NavItem, type Rendition } from 'epubjs';
import readingFontUrl from '../assets/ZhaoyeFangSong.ttf?url';
import { annotationExcerpt, updateAnnotationComment } from '../epubAnnotationActions.cjs';
function flattenToc(items: NavItem[], depth = 0): FlatNavItem[] {
  return items.flatMap(item => [{ href: item.href, label: item.label.trim(), depth }, ...flattenToc(item.subitems || [], depth + 1)]);
}

const EPUB_THEME_STYLE_ID = 'zuoren-notes-epub-theme';
function epubThemeCss(theme: 'light' | 'dark', fontFamily: string) {
  const dark = theme === 'dark';
  const background = dark ? '#171d19' : '#ffffff';
  const text = dark ? '#dfe7e1' : '#242925';
  const heading = dark ? '#b8d8c8' : '#1d3d30';
  const muted = dark ? '#aebbb3' : '#58645d';
  const link = dark ? '#83bfa1' : '#1d6549';
  const codeBackground = dark ? '#101512' : '#f5f6f4';
  return `
    @font-face { font-family: "Zhaoye Reading"; src: url("${readingFontUrl}") format("truetype"); font-weight: 400; font-style: normal; font-display: swap; }
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    html, body { background: ${background} !important; color: ${text} !important; }
    body { max-width: 880px; margin: 0 auto !important; padding: 32px clamp(22px, 4vw, 56px) 72px !important; font-family: ${fontFamily} !important; line-height: 1.95 !important; letter-spacing: .015em; }
    body, p, li, dt, dd, blockquote, table, th, td, h1, h2, h3, h4, h5, h6 { font-family: ${fontFamily} !important; }
    h1, h2, h3, h4, h5, h6 { color: ${heading} !important; line-height: 1.35 !important; }
    h1 { margin: .15em 0 .8em !important; font-size: 2em !important; }
    h2 { margin: 1.6em 0 .65em !important; font-size: 1.48em !important; }
    h3 { margin: 1.4em 0 .55em !important; font-size: 1.2em !important; }
    p { margin: .72em 0 !important; }
    blockquote { margin: 1.2em 0 !important; padding-left: 1em !important; border-left: 3px solid ${dark ? '#668c79' : '#8bb29f'} !important; color: ${muted} !important; }
    a { color: ${link} !important; text-underline-offset: 3px; }
    code, pre { font-family: "Cascadia Code", ui-monospace, monospace !important; color: ${text} !important; background: ${codeBackground} !important; }
    img, svg { max-width: 100% !important; height: auto !important; }
    hr { border-color: ${dark ? '#3a463f' : '#dfe3df'} !important; }
  `;
}

function applyEpubTheme(contentsOrView: any, theme: 'light' | 'dark', fontFamily: string) {
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

export function EpubPane({ epub, theme, noteBodyFont, onMeta, onMessage, onExcerpt, excerptTarget, target }: { epub: ActiveEpub; theme: 'light' | 'dark'; noteBodyFont: NoteBodyFont; onMeta: (change: (current: EpubMeta) => EpubMeta) => Promise<boolean>; onMessage: (message: string) => void; onExcerpt: (anchor: EpubAnchor, quote: string, comment: string) => Promise<void>; excerptTarget: string | null; target: EpubAnchor | null }) {
  const host = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const metaRef = useRef(epub.meta);
  const readingPosition = useRef({ cfi: epub.meta.cfi, progress: epub.meta.progress, fontSize: epub.meta.fontSize });
  const generationRef = useRef(0);
  const savingRef = useRef(false);
  const metaWriter = useRef(onMeta); metaWriter.current = onMeta;
  useEffect(() => {
    const flush = () => { const position = { ...readingPosition.current }; void metaWriter.current(current => ({ ...current, ...position })); };
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
        setComment('');
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
        await rendition.display(target?.epubId === epub.meta.id ? target.cfiRange : epub.meta.cfi || undefined);
        if (!disposed && generationRef.current === generation) {
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
    const now = new Date().toISOString();
    const annotation: EpubAnnotation = {
      id: crypto.randomUUID(), kind: 'highlight', cfiRange: selection.cfiRange, quote: selection.quote,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ...(selection.chapterHref ? { chapterHref: selection.chapterHref } : {}),
      ...(selection.chapterLabel ? { chapterLabel: selection.chapterLabel } : {}),
      createdAt: now, updatedAt: now,
    };
    try {
      const generation = generationRef.current;
      if (!(await onMeta(current => ({ ...current, annotations: [...current.annotations, annotation] })))) return;
      if (generationRef.current !== generation) return;
      if (generationRef.current === generation) renditionRef.current?.annotations.highlight(annotation.cfiRange, { annotationId: annotation.id }, undefined, 'zhaoye-epub-highlight', { fill: '#e4c95b', 'fill-opacity': '0.42', 'mix-blend-mode': 'multiply' });
      setSelection(null); setDeleteConfirm(null);
      if (excerpt) await onExcerpt({ epubId: epub.meta.id, cfiRange: annotation.cfiRange, quote: annotation.quote, annotationId: annotation.id, chapterHref: annotation.chapterHref, chapterLabel: annotation.chapterLabel }, annotation.quote, annotation.comment || '');
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
    try {
      const excerpt = annotationExcerpt(epub.meta.id, annotation);
      await onExcerpt(excerpt.anchor, excerpt.quote, excerpt.comment);
    } catch (error) { onMessage(`无法插入 EPUB 摘录：${error instanceof Error ? error.message : String(error)}`); }
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

  return <section className="pane epub-pane">
    <div className="pane-toolbar epub-navigation">
      <button className="icon-button" title="上一节" aria-label="上一节" onClick={() => void renditionRef.current?.prev()}><ChevronLeft size={18}/></button>
      <select aria-label="EPUB 目录" value={toc.some(item => item.href === currentHref) ? currentHref : ''} onChange={event => display(event.target.value)}><option value="">目录</option>{toc.map(item => <option key={`${item.href}-${item.label}`} value={item.href}>{'　'.repeat(Math.min(3, item.depth))}{item.label}</option>)}</select>
      <span className="epub-chapter" title={chapter}>{chapter || (loading ? '正在打开…' : '正文')}</span>
      <button className="icon-button" title="下一节" aria-label="下一节" onClick={() => void renditionRef.current?.next()}><ChevronRight size={18}/></button>
      <span className="toolbar-spacer"/><span className="keyboard-hints" aria-label="EPUB 快捷键">←→ / 滚轮翻页</span>
      <div className="toolbar-group epub-font-control"><button title="减小字号" aria-label="减小字号" onClick={() => changeFont(fontSize - 10)}>A−</button><span>{fontSize}%</span><button title="增大字号" aria-label="增大字号" onClick={() => changeFont(fontSize + 10)}>A＋</button></div>
    </div>
    <div className="epub-reader-shell"><div ref={host} className="epub-viewer"/>{loading && <div className="loading epub-loading">正在载入电子书…</div>}
      {selection && <div className="epub-selection-actions" role="group" aria-label="处理选中文本"><span title={selection.quote}>{selection.quote.slice(0, 72)}{selection.quote.length > 72 ? '…' : ''}</span><input aria-label="EPUB 批注" maxLength={10000} value={comment} onChange={event => setComment(event.target.value)} placeholder="可选批注"/><button className="primary" disabled={savingAnnotation} onClick={() => void saveSelection(false)}>高亮</button><button disabled={savingAnnotation} onClick={() => void saveSelection(!!excerptTarget)}>{excerptTarget ? `批注并${excerptTarget}` : '批注'}</button><button disabled={savingAnnotation} onClick={() => { setSelection(null); setComment(''); }}>取消</button></div>}
    </div>
    <div className="epub-foot"><span>{chapter || '电子书'}</span><progress aria-label="阅读进度" max="1" value={progress}/><span>{Math.round(progress * 100)}%</span></div>
    <aside className="epub-annotation-panel"><button className="epub-annotation-toggle" aria-expanded={annotationsOpen} onClick={() => setAnnotationsOpen(value => !value)}>标注（{epub.meta.annotations.length}）{annotationsOpen ? '　收起' : '　展开'}</button>
      {annotationsOpen && <div className="epub-annotation-list">{epub.meta.annotations.map(annotation => <div className={'epub-annotation-item ' + (flashId === annotation.id ? 'current' : '')} key={annotation.id}>
        {editingAnnotation === annotation.id ? <div className="epub-annotation-edit"><textarea autoFocus aria-label="编辑批注" maxLength={10000} value={editingComment} onChange={event => setEditingComment(event.target.value)} placeholder="可选批注"/><div className="epub-annotation-actions"><button className="primary" disabled={savingAnnotation} onClick={() => void saveAnnotationComment(annotation)}>保存</button><button disabled={savingAnnotation} onClick={() => { setEditingAnnotation(null); setEditingComment(''); }}>取消</button></div></div> : <>
          <button className="epub-annotation-quote" title="跳转到这条标注" onClick={() => void jumpAnnotation(annotation)}><span>{annotation.quote}</span>{annotation.comment && <small>{annotation.comment}</small>}</button>
          <div className="epub-annotation-actions">
            {excerptTarget && <button aria-label={excerptTarget} disabled={savingAnnotation} title={excerptTarget} onClick={() => void excerptAnnotation(annotation)}>摘录</button>}
            <button disabled={savingAnnotation} aria-label="编辑批注" title="编辑批注" onClick={() => { setDeleteConfirm(null); setEditingAnnotation(annotation.id); setEditingComment(annotation.comment || ''); }}>编辑</button>
            {deleteConfirm === annotation.id ? <div className="epub-delete-confirm"><button disabled={savingAnnotation} onClick={() => void confirmDelete(annotation)}>确认删除</button><button disabled={savingAnnotation} onClick={() => setDeleteConfirm(null)}>取消</button></div> : <button className="epub-delete-button" aria-label="删除标注" title="删除标注" disabled={savingAnnotation} onClick={() => setDeleteConfirm(annotation.id)}>删除</button>}
          </div>
        </>}
      </div>)}{!epub.meta.annotations.length && <small className="epub-annotation-empty">还没有标注</small>}</div>}
    </aside>
    {deletedAnnotation && <div className="inline-undo" role="status">已删除一条标注<button onClick={() => void undoDelete()} disabled={savingAnnotation}>撤销</button><button aria-label="关闭撤销提示" onClick={() => setDeletedAnnotation(null)}>×</button></div>}
  </section>;
}
