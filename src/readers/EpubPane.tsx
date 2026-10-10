import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, List, Search, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { OutlinePanel } from '../OutlinePanel';
import type { EpubAnchor, EpubAnnotation, EpubMeta } from '../types';
import { NOTE_BODY_FONTS, EPUB_MIN_SPREAD_WIDTH, type ActiveEpub, type FlatNavItem, type NoteBodyFont } from '../readerContext';
import ePub, { EpubCFI, type Book, type Location, type NavItem, type Rendition } from 'epubjs';
import { annotationExcerpt, updateAnnotationComment } from '../epubAnnotationActions.cjs';
import { THEMES, type ThemeName } from '../appearanceTheme.cjs';
import { EpubSearchPanel } from './EpubSearchPanel';
import type { EpubSearchResult } from './epubSearch';
import type { ExcerptFlowResult } from './excerptFlow';
import noteLocalFontsCss from '../noteLocalFonts.css?inline';
import headingFontUrl from '../assets/SourceHanSerifSC-VF.woff2?url';
function flattenToc(items: NavItem[], depth = 0): FlatNavItem[] {
  return items.flatMap(item => [{ href: item.href, label: item.label.trim(), depth }, ...flattenToc(item.subitems || [], depth + 1)]);
}

function textLocationTarget(rendition: Rendition, anchor: string) {
  if (!anchor.startsWith('epubcfi(')) return anchor;
  try {
    const cfi = new EpubCFI(anchor), range = rendition.getRange(anchor)?.cloneRange();
    if (!range) return anchor;
    range.collapse(true);
    const node = range.startContainer, offset = range.startOffset;
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.length) return anchor;
    // epub.js expands a point CFI to the next space. In Chinese that can mean
    // an entire paragraph spanning columns, whose union bounds target an
    // earlier page. Use one character for display only; stored CFIs stay intact.
    if (offset < node.textContent.length) range.setEnd(node, offset + 1);
    else range.setStart(node, Math.max(0, offset - 1));
    return new EpubCFI(range, cfi.base).toString();
  } catch { return anchor; }
}

async function displayLocation(rendition: Rendition, anchor?: string, current = () => true) {
  if (!current()) return;
  await rendition.display(anchor ? textLocationTarget(rendition, anchor) : undefined);
  // On first load the target's document is not available until display resolves.
  if (anchor && current()) {
    const precise = textLocationTarget(rendition, anchor);
    if (precise !== anchor) await rendition.display(precise);
  }
}

function visibleTextAnchor(rendition: Rendition, host: HTMLElement, fallback: string) {
  const viewport = host.getBoundingClientRect();
  const contents = rendition.getContents() as unknown as { document: Document; cfiFromRange: (range: Range) => string }[];
  for (const frame of host.querySelectorAll('iframe')) {
    const document = frame.contentDocument, box = frame.getBoundingClientRect();
    const content = contents.find(item => item.document === document);
    if (!document || !content) continue;
    const style = frame.contentWindow?.getComputedStyle(document.body);
    const padding = parseFloat(style?.paddingLeft || '32');
    // epub.js maps Chinese runs without spaces as one word. Its page-start CFI
    // can therefore point outside the visible page. Capture an actual visible
    // caret instead of preserving that approximate paragraph boundary.
    for (let y = 40; y < Math.min(viewport.height, 240); y += 24) {
      for (const x of [padding + 2, viewport.width / 2, viewport.width - padding - 2]) {
        const range = document.caretRangeFromPoint(viewport.left - box.left + x, viewport.top - box.top + y);
        if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !range.startContainer.textContent?.trim()) continue;
        const point = range.cloneRange(), node = range.startContainer;
        const offset = Math.min(range.startOffset, (node.textContent?.length || 1) - 1);
        point.setStart(node, offset); point.setEnd(node, offset + 1);
        const rect = point.getBoundingClientRect();
        if (box.left + rect.left < viewport.left || box.left + rect.right > viewport.right ||
          box.top + rect.top < viewport.top || box.top + rect.bottom > viewport.bottom) continue;
        point.collapse(true);
        return content.cfiFromRange(point);
      }
    }
  }
  return fallback;
}

const EPUB_THEME_STYLE_ID = 'zuoren-notes-epub-theme';
function epubThemeCss(theme: ThemeName, fontFamily: string, readingSize: number) {
  const { colors, colorScheme } = THEMES[theme];
  return `
    ${noteLocalFontsCss}
    @font-face { font-family: "Zhaoye Heading"; src: url("${new URL(headingFontUrl, document.baseURI).href}") format("woff2"); font-style: normal; font-weight: 200 900; font-display: swap; }
    :root { color-scheme: ${colorScheme}; }
    html, body { background: ${colors.surface} !important; color: ${colors.text} !important; }
    body { max-width: 880px; margin: 0 auto !important; padding: 32px clamp(22px, 4vw, 56px) 72px !important; font-family: ${fontFamily} !important; font-size: ${readingSize}px !important; line-height: 1.95 !important; letter-spacing: .015em; }
    p, li, dt, dd, blockquote, table, th, td { font-size: 1em !important; }
    body, p, li, dt, dd, blockquote, table, th, td { font-family: ${fontFamily} !important; }
    p, li, dt, dd, table, th, td { color: ${colors.text} !important; }
    span { color: inherit !important; }
    h1, h2, h3, h4, h5, h6 { font-family: "Zhaoye Heading", "Source Han Serif SC", "SimSun", "Songti SC", "STSong", serif !important; color: ${colors.heading} !important; line-height: 1.35 !important; }
    :is(h1, h2, h3, h4, h5, h6) * { font-family: inherit !important; }
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

function applyEpubTheme(contentsOrView: any, theme: ThemeName, fontFamily: string, readingSize: number) {
  const contents = contentsOrView?.document ? contentsOrView : contentsOrView?.contents;
  const document = contents?.document as Document | undefined;
  if (!document?.head) return;
  let style = document.getElementById(EPUB_THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = EPUB_THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = epubThemeCss(theme, fontFamily, readingSize);
}

export function EpubPane({ epub, theme, noteBodyFont, readingSize, headerTarget, active, closing, onActivate, onClose, onMeta, onMessage, onExcerpt, onSelectionAction, excerptTarget, target }: { epub: ActiveEpub; theme: ThemeName; noteBodyFont: NoteBodyFont; readingSize: number; headerTarget: HTMLElement | null; active: boolean; closing: boolean; onActivate: () => void; onClose: () => void; onMeta: (change: (current: EpubMeta) => EpubMeta) => Promise<boolean>; onMessage: (message: string) => void; onExcerpt: (anchor: EpubAnchor, quote: string, comment: string) => Promise<ExcerptFlowResult>; onSelectionAction: (annotation: EpubAnnotation, excerpt: boolean) => Promise<ExcerptFlowResult>; excerptTarget: string | null; target: EpubAnchor | null }) {
  const host = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const metaRef = useRef(epub.meta);
  const readingPosition = useRef({ cfi: epub.meta.cfi, progress: epub.meta.progress, fontSize: epub.meta.fontSize });
  const generationRef = useRef(0);
  const interactions = useRef({ onActivate, onClose, closing, dismissOutline: (): boolean => false });
  const navigateRef = useRef<(direction: 'next' | 'prev') => void>(() => {});
  const appliedTarget = useRef<EpubAnchor | null>(null);
  // Layout changes retain one semantic text point, not the rounded start of
  // each newly paginated page. Explicit navigation releases it.
  const positionAnchor = useRef<string | null>(null);
  const reflow = useRef<{ anchor: string; token: number } | null>(null);
  const reflowToken = useRef(0);
  const [reflowing, setReflowing] = useState(false);
  const [outline, setOutline] = useState(false);
  interactions.current = { onActivate, onClose, closing, dismissOutline: () => {
    if (!outline) return false;
    setOutline(false); return true;
  } };
  const savingRef = useRef(false);
  const selectionActionGeneration = useRef(0);
  const [selectionFlow, setSelectionFlow] = useState<ExcerptFlowResult | null>(null);
  const selectionAnnotation = useRef<EpubAnnotation | null>(null);
  const [annotationFlows, setAnnotationFlows] = useState<Record<string, ExcerptFlowResult>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const searchHighlight = useRef<string | null>(null), searchJumpToken = useRef(0);
  const showSearchRef = useRef(() => {});
  showSearchRef.current = () => {
    setOutline(false);
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
        const cfi = reflow.current?.anchor || positionAnchor.current || (renditionRef.current && host.current ? visibleTextAnchor(renditionRef.current, host.current, location?.start?.cfi || '') : location?.start?.cfi);
        if (cfi) readingPosition.current = { ...readingPosition.current, cfi };
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
  const epubStyleRef = useRef({ theme, fontFamily: NOTE_BODY_FONTS[noteBodyFont], readingSize });
  const appliedTypography = useRef({ fontFamily: NOTE_BODY_FONTS[noteBodyFont], readingSize });
  epubStyleRef.current = { theme, fontFamily: NOTE_BODY_FONTS[noteBodyFont], readingSize };

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
    let resizeRestoreToken = 0;
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
    metaRef.current = epub.meta;
    element.replaceChildren();

    const source = epub.data.slice().buffer as ArrayBuffer;
    const book = ePub(source, { replacements: 'blobUrl' });
    const rendition = book.renderTo(element, { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', minSpreadWidth: EPUB_MIN_SPREAD_WIDTH, allowScriptedContent: false });
    const navigatePage = (direction: 'next' | 'prev') => {
      if (disposed || navigationLocked || reflow.current || interactions.current.closing) return;
      positionAnchor.current = null;
      navigationLocked = true;
      const request = direction === 'next' ? rendition.next() : rendition.prev();
      void request.catch(() => undefined).finally(() => {
        if (!disposed) element.focus({ preventScroll: true });
        window.clearTimeout(navigationReleaseTimer);
        navigationReleaseTimer = window.setTimeout(() => { navigationLocked = false; }, 180);
      });
    };
    navigateRef.current = navigatePage;
    const handlePageKeyDown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !event.isComposing && event.key === 'Escape' && interactions.current.dismissOutline()) {
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (!event.defaultPrevented && !event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault(); event.stopPropagation(); interactions.current.onClose(); return;
      }
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
      document.addEventListener('pointerdown', activateReader, true);
      document.addEventListener('focusin', activateReader, true);
      document.addEventListener('click', followBookLink, true);
      pageInputDocuments.add(document);
    };
    const activateReader = () => interactions.current.onActivate();
    const followBookLink = (event: MouseEvent) => {
      if ((event.target as Element)?.closest?.('a[href]')) positionAnchor.current = null;
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
      applyEpubTheme(contentsOrView, style.theme, style.fontFamily, style.readingSize);
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

    let resizeFrame = 0;
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (!bounds || bounds.width < 1 || bounds.height < 1 || disposed || interactions.current.closing) return;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const manager = (rendition as Rendition & { manager?: { resize?: (width: number, height: number) => void } }).manager;
        if (!disposed && !interactions.current.closing && manager?.resize) {
          try {
            const anchor = reflow.current?.anchor || positionAnchor.current || readingPosition.current.cfi;
            if (anchor) positionAnchor.current = anchor;
            resizeRestoreToken++;
            // The bundled runtime supports a CFI resize target; its published
            // declaration still describes the older two-argument API.
            (rendition as Rendition & { resize: (width: number, height: number, cfi?: string) => void })
              .resize(Math.round(bounds.width), Math.round(bounds.height), anchor ? textLocationTarget(rendition, anchor) : undefined);
          } catch { /* ePub may be between view unload/load */ }
        }
      });
    });
    resizeObserver?.observe(element);
    const restoreRenderedPosition = (_section: unknown, view: any) => {
      const anchor = positionAnchor.current, token = resizeRestoreToken;
      if (!anchor || reflow.current) return;
      void Promise.resolve(view?.contents?.document?.fonts?.ready).then(async () => {
        if (disposed || interactions.current.closing || token !== resizeRestoreToken || positionAnchor.current !== anchor || reflow.current) return;
        // New iframe views receive the app stylesheet after epub.js first
        // positions them. Remeasure that final typography before relocating.
        view.expand();
        await displayLocation(rendition, anchor, () => !disposed && token === resizeRestoreToken && positionAnchor.current === anchor && !reflow.current && !interactions.current.closing);
      }).catch(() => { if (!disposed) onMessage('阅读区域调整后的定位失败，请重新选择章节。'); });
    };
    rendition.on('rendered', restoreRenderedPosition);

    void (async () => {
      try {
        const [navigation, spine] = await Promise.all([book.loaded.navigation, book.loaded.spine]);
        if (disposed) return;
        flat = flattenToc(navigation.toc || []);
        setToc(flat);
        relocated = (location: Location) => {
          if (disposed || generationRef.current !== generation || reflow.current || !location?.start) return;
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
          setCurrentHref(item?.href || href); setChapter(item?.label || '正文');
          const position = { cfi: positionAnchor.current || visibleTextAnchor(rendition, element, location.start.cfi || ''), progress: nextProgress };
          readingPosition.current = { ...readingPosition.current, ...position };
          void metaWriter.current(current => ({ ...current, ...position }));
        };
        rendition.on('relocated', relocated);
        const initialTarget = target?.epubId === epub.meta.id ? target.cfiRange : epub.meta.cfi || undefined;
        let usedFallback = false;
        try { await displayLocation(rendition, initialTarget, () => !disposed && generationRef.current === generation); }
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
      reflowToken.current++; reflow.current = null; positionAnchor.current = null; navigateRef.current = () => {};
      searchJumpToken.current++; searchHighlight.current = null;
      if (generationRef.current === generation) generationRef.current++;
      window.clearTimeout(navigationReleaseTimer);
      element.removeEventListener('keydown', handlePageKeyDown, true);
      element.removeEventListener('wheel', handleWheel);
      for (const document of pageInputDocuments) {
        document.removeEventListener('keydown', handlePageKeyDown, true);
        document.removeEventListener('wheel', handleWheel);
        document.removeEventListener('pointerdown', activateReader, true);
        document.removeEventListener('focusin', activateReader, true);
        document.removeEventListener('click', followBookLink, true);
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
      rendition.off('rendered', restoreRenderedPosition);
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
    const typography = { fontFamily: NOTE_BODY_FONTS[noteBodyFont], readingSize };
    const changed = appliedTypography.current.fontFamily !== typography.fontFamily || appliedTypography.current.readingSize !== readingSize;
    appliedTypography.current = typography;
    const anchor = reflow.current?.anchor || positionAnchor.current || (host.current ? visibleTextAnchor(rendition, host.current, readingPosition.current.cfi) : readingPosition.current.cfi);
    const token = ++reflowToken.current;
    const needsReflow = !!anchor && (changed || !!reflow.current);
    if (needsReflow) { positionAnchor.current = anchor; reflow.current = { anchor, token }; setReflowing(true); }
    const contents = rendition.getContents() as unknown as any[];
    for (const content of Array.isArray(contents) ? contents : [contents]) applyEpubTheme(content, theme, typography.fontFamily, readingSize);
    if (!needsReflow) return;
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await Promise.all((Array.isArray(contents) ? contents : [contents]).map(content => content?.document?.fonts?.ready));
          if (generation !== generationRef.current || token !== reflowToken.current) return;
          (rendition.views() as unknown as { forEach: (callback: (view: { expand: () => void }) => void) => void })?.forEach(view => view.expand());
          await displayLocation(rendition, anchor, () => generation === generationRef.current && token === reflowToken.current);
          if (generation !== generationRef.current || token !== reflowToken.current) return;
          reflow.current = null; setReflowing(false);
          readingPosition.current = { ...readingPosition.current, cfi: anchor };
          void metaWriter.current(current => ({ ...current, cfi: anchor }));
        } catch (error) {
          if (generation !== generationRef.current || token !== reflowToken.current) return;
          reflow.current = null; setReflowing(false);
          onMessage(`字号调整后的阅读位置恢复失败：${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [theme, noteBodyFont, readingSize]);

  useEffect(() => {
    if (!target) { appliedTarget.current = null; return; }
    if (!target || target.epubId !== epub.meta.id || loading || reflowing) return;
    if (appliedTarget.current === target) return;
    const rendition = renditionRef.current;
    const generation = generationRef.current;
    if (!rendition) return;
    appliedTarget.current = target;
    positionAnchor.current = null;
    void displayLocation(rendition, target.cfiRange).then(() => {
      if (generationRef.current !== generation) return;
      setFlashId(target.annotationId || epub.meta.annotations.find(item => item.cfiRange === target.cfiRange)?.id || null);
      window.setTimeout(() => setFlashId(value => value === target.annotationId ? null : value), 3500);
    }).catch(() => onMessage('无法定位这条 EPUB 标注。'));
  }, [target, epub.meta.id, loading, reflowing]);

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
    if (reflow.current || closing) return;
    positionAnchor.current = null;
    const generation = generationRef.current;
    try {
      if (renditionRef.current) await displayLocation(renditionRef.current, annotation.cfiRange);
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

  function display(target: string) {
    if (target && !reflow.current && !closing) {
      positionAnchor.current = null;
      const generation = generationRef.current;
      setLoading(true);
      void renditionRef.current?.display(target).catch(() => { if (generation === generationRef.current) onMessage('无法定位这个 EPUB 章节。'); })
        .finally(() => { if (generation === generationRef.current) setLoading(false); });
    }
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
    if (!rendition || loading || reflow.current || closing) return false;
    positionAnchor.current = null;
    try {
      await displayLocation(rendition, result.cfi);
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

  return <section className="pane epub-pane" inert={closing} data-reflowing={reflowing} data-current-chapter={chapter} onPointerDownCapture={onActivate} onFocusCapture={onActivate} onKeyDownCapture={event => {
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === 'Escape' && outline) {
      event.preventDefault(); event.stopPropagation(); setOutline(false); return;
    }
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
      event.preventDefault(); event.stopPropagation(); onClose(); return;
    }
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopPropagation(); showSearchRef.current();
    }
  }}>
    {headerTarget && createPortal(<div className="epub-navigation" data-reader-controls="epub" aria-label="EPUB 标签与操作">
      <div className="document-tab-strip reader-tab-strip" role="tablist" aria-label="阅读资料标签">
        <div className={'document-tab active reader-tab ' + (active ? 'foreground-tab' : '')} data-reader-tab="epub">
          <button role="tab" aria-selected={active} title={epub.path} disabled={closing} onClick={() => { onActivate(); host.current?.focus({ preventScroll: true }); }}><BookOpen size={14}/><span className="tab-file-name">{epub.name}</span></button>
          <button aria-label={'关闭 ' + epub.name} title="关闭资料（Ctrl+W）" disabled={closing} onClick={onClose}><X size={13}/></button>
        </div>
      </div>
      <div className="epub-header-actions">
        <button className="workspace-icon-action" title="上一页（←／滚轮向上）" aria-label="上一页" disabled={loading || reflowing || closing} onClick={() => navigateRef.current('prev')}><ChevronLeft size={17}/></button>
        <button className="workspace-icon-action" title="下一页（→／滚轮向下）" aria-label="下一页" disabled={loading || reflowing || closing} onClick={() => navigateRef.current('next')}><ChevronRight size={17}/></button>
        <button className="workspace-icon-action" aria-label="在 EPUB 中查找" title="全书搜索（Ctrl+F）" disabled={closing} onClick={() => showSearchRef.current()}><Search size={15}/></button>
        <button data-outline-toggle className={'workspace-icon-action ' + (outline ? 'active' : '')} aria-label={outline ? '收起 EPUB 大纲' : '展开 EPUB 大纲'} title={`${outline ? '收起大纲' : '展开大纲'}${chapter ? ` · ${chapter}` : ''}`} aria-pressed={outline} aria-expanded={outline} disabled={closing} onClick={() => { if (!outline && searchOpen) closeSearch(); setOutline(value => !value); }}><List size={17}/></button>
      </div>
    </div>, headerTarget)}
    <div className="epub-content-row"><div className="epub-reader-shell"><div ref={host} className="epub-viewer"/>{loading && <div className="loading epub-loading">正在载入电子书…</div>}
      {searchOpen && <EpubSearchPanel data={epub.data} toc={toc} onNavigate={jumpSearch} onClose={closeSearch} onClear={clearSearchHighlight}/>}
      {selection && <div className="epub-selection-actions" role="group" aria-label="处理选中文本"><span title={selection.quote}>{selection.quote.slice(0, 72)}{selection.quote.length > 72 ? '…' : ''}</span>{selectionFlow ? <><span className="epub-flow-status" role="status">{selectionFlow.error || '操作尚未完成'}</span><button className="primary" disabled={savingAnnotation || !selectionFlow.retry} onClick={() => void saveSelection(false)}>{selectionFlow.saved ? '重试摘录' : '重试保存'}</button></> : <><input aria-label="EPUB 批注" maxLength={10000} value={comment} onChange={event => setComment(event.target.value)} placeholder="可选批注"/><button className="primary" disabled={savingAnnotation} onClick={() => void saveSelection(false)}>高亮</button><button disabled={savingAnnotation} onClick={() => void saveSelection(!!excerptTarget)}>{excerptTarget ? `批注并${excerptTarget}` : '批注'}</button></>}<button disabled={savingAnnotation} onClick={() => { selectionActionGeneration.current += 1; setSelection(null); setComment(''); setSelectionFlow(null); selectionAnnotation.current = null; }}>取消</button></div>}
    </div><OutlinePanel open={outline} label="EPUB 大纲" className="epub-outline" emptyText={loading ? '正在读取目录…' : '这本电子书没有提供目录。'}
      returnFocus={() => headerTarget?.querySelector('[data-outline-toggle]') || null}
      items={toc.map((item, index) => ({ id: String(index), label: item.label, depth: item.depth, active: item.href === currentHref }))}
      onSelect={item => { const entry = toc[Number(item.id)]; if (entry) display(entry.href); }}/></div>
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
