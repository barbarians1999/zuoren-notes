import { PdfPane } from './readers/PdfPane';
import { EpubPane } from './readers/EpubPane';
import { NotePane } from './editor/NotePane';
import { SecondaryNote } from './workspace/SecondaryNote';
import { ConflictDialog, UnsavedDialog } from './workspace/DocumentDialogs';
import { reader, resolveLocal, NOTE_BODY_FONTS, type Layout, type NoteMode, type ThemePreference, type NoteBodyFont, type SaveLabel, type ActivePdf, type ActiveEpub, type FileContextMenu, type InlineEntryEdit, type FindCommand } from './readerContext';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, ArrowLeft, ArrowLeftRight, BookOpen, ChevronLeft, ChevronRight, Columns2, Copy, Crop, List, FileText, Folder, FolderOpen, FolderPlus, FolderTree, Highlighter, Maximize2, MessageSquare, Minimize2, Minus, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Square, Sun, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useNoteSession } from './workspace/useNoteSession';
import { diagnostics } from './diagnostics.cjs';
import { LatestRequest } from './asyncRequest.cjs';
import { MetadataWriter } from './metadataWriter.cjs';
import { findLiteralMatches, stepMatchIndex, type LiteralMatch } from './findReplace';
import type { DirectoryListing, EpubAnchor, EpubAnnotation, EpubMeta, MarkdownScrollMemory, NoteRead, OcrProgress, PdfAnchor, PdfAnnotation, PdfMeta, PdfRect, ReaderAnchor, ReaderSessionV2, RecoveryCheckResult, RecoveryV1, SaveNoteResult, SearchResult, WorkspaceDirectoryEntry, WorkspaceFile } from './types';
import { decodeReaderAnchor, encodeReaderAnchor, formatEpubAnchor, isEpubAnchor } from './readerAnchor.cjs';
import { resolveScrollTop, upsertScrollMemory } from './sessionState.cjs';
import { MutationBarrier, remapDescendantPath, sameOrDescendantPath } from './fileOperations.cjs';
import { sameNoteContent } from './noteContent.cjs';
import './styles.css';

Object.defineProperty(window, 'readerDiagnostics', { configurable: true, value: Object.freeze({ snapshot: () => diagnostics.snapshot() }) });

const readThemePreference = (): ThemePreference => {
  const saved = window.localStorage.getItem('zhaoye-theme');
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
};
const readNoteBodyFont = (): NoteBodyFont => {
  try {
    const saved = window.localStorage.getItem('zhaoye-note-font');
    return saved === 'default' || saved === 'fangsong' || saved === 'songti' ? saved : 'fangsong';
  } catch { return 'fangsong'; }
};
const initialThemePreference = readThemePreference();
document.documentElement.dataset.theme = initialThemePreference === 'system'
  ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : initialThemePreference;

function App() {
  const [layout, setLayout] = useState<Layout>('split');
  const [sidebar, setSidebar] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [windowState, setWindowState] = useState({ maximized: false, fullscreen: false });
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialThemePreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const [readingSize, setReadingSize] = useState(() => {
    const saved = Number(window.localStorage.getItem('zhaoye-reading-size'));
    return Number.isFinite(saved) && saved >= 14 && saved <= 28 ? saved : 18;
  });
  const [noteBodyFont, setNoteBodyFont] = useState<NoteBodyFont>(readNoteBodyFont);
  const [splitAt, setSplitAt] = useState(52);
  const [root, setRootState] = useState('');
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [directory, setDirectory] = useState<DirectoryListing | null>(null);
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activePdf, setActivePdf] = useState<ActivePdf | null>(null);
  const [activeEpub, setActiveEpub] = useState<ActiveEpub | null>(null);
  const [noteTabs, setNoteTabs] = useState<WorkspaceFile[]>([]);
  const [secondNote, setSecondNote] = useState<NoteRead | null>(null);
  const [secondNoteMode, setSecondNoteMode] = useState<NoteMode>('edit');
  const secondSave = useRef<() => Promise<boolean>>(async () => true);
  const secondInsertExcerpt = useRef<(block: string) => boolean>(() => false);
  const primaryInsertExcerpt = useRef<(block: string) => boolean>(() => false);
  const [noteMode, setNoteMode] = useState<NoteMode>('edit');
  const [message, setMessage] = useState('');
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [target, setTarget] = useState<ReaderAnchor | null>(null);
  const [closing, setClosing] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [secondRecoveryId, setSecondRecoveryId] = useState<string | null>(null);
  const [recoveryConflict, setRecoveryConflict] = useState<{ note: NoteRead; recovery: RecoveryV1; recoveryId: string } | null>(null);
  const [secondRecoveryCheck, setSecondRecoveryCheck] = useState<RecoveryCheckResult | undefined>(undefined);
  const [activeNotePane, setActiveNotePane] = useState<FindCommand['pane'] | null>(null);
  const [swappingNotes, setSwappingNotes] = useState(false);
  const [scrollMemory, setScrollMemory] = useState<MarkdownScrollMemory[]>([]);
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [findCommand, setFindCommand] = useState<FindCommand | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenu | null>(null);
  const [unsavedAction, setUnsavedAction] = useState<{ description: string; action: () => Promise<void> } | null>(null);
  const [inlineEntryEdit, setInlineEntryEdit] = useState<InlineEntryEdit | null>(null);
  const findCommandSequence = useRef(0);
  const openSequence = useRef(0);
  const directoryRequest = useRef(new LatestRequest()), searchRequest = useRef(new LatestRequest());
  const setRoot = useCallback((value: string) => { directoryRequest.current.invalidate(); searchRequest.current.invalidate(); setRootState(value); }, []);
  const setQuery = useCallback((value: string) => { searchRequest.current.invalidate(); setQueryState(value); setResults([]); }, []);
  const activeEpubRef = useRef<ActiveEpub | null>(null);
  const pdfWriter = useRef(new MetadataWriter<PdfMeta>()), epubWriter = useRef(new MetadataWriter<EpubMeta>());
  const epubSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pdfSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const settingsRef = useRef<HTMLDivElement>(null);
  const fileContextMenuRef = useRef<HTMLDivElement>(null);
  const inlineEntryInputRef = useRef<HTMLInputElement>(null);
  const mutationBarrier = useRef(new MutationBarrier());
  const primarySession = useNoteSession({ pane: 'primary', ready: sessionReady, recoveryPending: !!recoveryConflict,
    recoveryId, barrier: mutationBarrier.current, onMessage: setMessage });
  const { note, setNote, text: noteText, setText: setNoteText, replaceText: replaceNoteText,
    label: saveLabel, setLabel: setSaveLabel, conflict, setConflict, editorRevision, noteRef, textRef,
    conflictRef: primaryConflict, save: saveCurrent, flushRecovery: flushPrimaryRecovery } = primarySession;
  const excerptContext = useRef({ activePdf, secondNote, secondRecoveryId });
  excerptContext.current = { activePdf, secondNote, secondRecoveryId };
  const openEntryRef = useRef<(file: WorkspaceFile, options?: { replaceCurrentNote?: boolean; skipUnsavedPrompt?: boolean }) => Promise<void>>(async () => {});

  // A successful rename/delete leaves a short-lived barrier so delayed work
  // for the old document cannot recreate it. Once a path is explicitly
  // opened again, it belongs to a new document instance and the old barrier
  // must no longer apply.
  function releaseMutationBarrier(path: string) { mutationBarrier.current.release(path); }

  useEffect(() => { activeEpubRef.current = activeEpub; }, [activeEpub]);

  useEffect(() => {
    window.localStorage.setItem('zhaoye-reading-size', String(readingSize));
  }, [readingSize]);

  useEffect(() => {
    try { window.localStorage.setItem('zhaoye-note-font', noteBodyFont); }
    catch { setMessage('正文字体已更改，但无法保存；下次启动时可能恢复原设置。'); }
  }, [noteBodyFont]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent | MediaQueryList) => setSystemDark(event.matches);
    update(query);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const resolvedTheme = themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference;

  useEffect(() => {
    window.localStorage.setItem('zhaoye-theme', themePreference);
    document.documentElement.dataset.theme = resolvedTheme;
  }, [themePreference, resolvedTheme]);

  useEffect(() => {
    const unsubscribe = reader().onWindowState(setWindowState);
    void reader().getWindowState().then(setWindowState);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !event.ctrlKey || event.metaKey || event.altKey) return;
      const mode = event.key.toLowerCase() === 'f' ? 'find' : event.key.toLowerCase() === 'h' ? 'replace' : null;
      if (!mode) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.note-pane[data-pane-id]') : null;
      const pane = target?.dataset.paneId;
      if (pane !== 'primary' && pane !== 'secondary') return;
      event.preventDefault();
      event.stopPropagation();
      setActiveNotePane(pane);
      setFindCommand({ pane, mode, sequence: ++findCommandSequence.current });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeNotePane]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!fileContextMenu) return;
    requestAnimationFrame(() => fileContextMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    const closeOutside = (event: PointerEvent) => {
      if (!fileContextMenuRef.current?.contains(event.target as Node)) setFileContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setFileContextMenu(null); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
      const items = [...(fileContextMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])];
      if (!items.length) return;
      const index = items.indexOf(window.document.activeElement as HTMLButtonElement);
      event.preventDefault();
      if (event.key === 'Enter') { (window.document.activeElement as HTMLButtonElement | null)?.click(); return; }
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    };
    const closeOnNavigation = () => setFileContextMenu(null);
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnNavigation);
    window.addEventListener('blur', closeOnNavigation);
    window.addEventListener('scroll', closeOnNavigation, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnNavigation);
      window.removeEventListener('blur', closeOnNavigation);
      window.removeEventListener('scroll', closeOnNavigation, true);
    };
  }, [fileContextMenu]);

  useEffect(() => {
    if (!inlineEntryEdit) return;
    const frame = window.requestAnimationFrame(() => {
      inlineEntryInputRef.current?.focus();
      inlineEntryInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inlineEntryEdit?.kind, inlineEntryEdit?.entry?.path, inlineEntryEdit?.error]);

  const loadDirectory = useCallback(async (workspaceRoot: string, path: string) => {
    const current = directoryRequest.current.begin();
    setFileContextMenu(null);
    setInlineEntryEdit(null);
    try {
      const listing = await reader().listDirectory({ root: workspaceRoot, directory: path });
      if (current()) setDirectory(listing);
    } catch (error) { if (current()) throw error; }
  }, []);

  const sessionSnapshot = useCallback((): ReaderSessionV2 => ({
    version: 2,
    root: root || null,
    currentDirectory: directory?.directory || null,
    layout,
    sidebar,
    splitAt,
    noteTabs: noteTabs.map(tab => tab.path).slice(-100),
    primaryNote: note ? { path: note.path, mode: noteMode, recoveryId: recoveryId || crypto.randomUUID() } : null,
    secondaryNote: secondNote ? { path: secondNote.path, mode: secondNoteMode, recoveryId: secondRecoveryId || crypto.randomUUID() } : null,
    activePdf: activePdf ? { path: activePdf.path, page: Math.max(1, page), scale } : null,
    activeEpub: activeEpub?.path || null,
    scrollMemory,
  }), [root, directory, layout, sidebar, splitAt, noteTabs, note, noteMode, recoveryId, secondNote, secondNoteMode, secondRecoveryId, activePdf, page, scale, activeEpub, scrollMemory]);

  const rememberScroll = useCallback((entry: MarkdownScrollMemory) => {
    setScrollMemory(current => upsertScrollMemory(current, entry));
  }, []);

  const saveSessionNow = useCallback(async () => {
    try { await reader().saveSession(sessionSnapshot()); return true; }
    catch (error) { setMessage(`工作现场保存失败：${error instanceof Error ? error.message : String(error)}`); return false; }
  }, [sessionSnapshot]);

  useEffect(() => {
    void (async () => {
      const fromPath = (path: string): WorkspaceFile => ({ path, name: path.split(/[\\/]/).pop() || path, relative: path, type: /\.pdf$/i.test(path) ? 'pdf' : /\.epub$/i.test(path) ? 'epub' : 'md' });
      const warn = (text: string) => setMessage(previous => previous ? `${previous}；${text}` : text);
      try {
        const launch = await reader().getLaunchItems();
        const settings = await reader().getSettings();
        if (settings.warning) warn(settings.warning);
        const session = !launch.root && !launch.files.length ? settings.session : null;
        const launchRecovery = launch.files[0]?.type === 'md'
          ? [settings.session?.primaryNote, settings.session?.secondaryNote].find(item => item?.path === launch.files[0].path)
          : undefined;
        const savedRoot = session?.root || settings.roots?.[0] || '';
        if (launch.root) {
          setRoot(launch.root); setFiles(launch.files); await loadDirectory(launch.root, launch.root);
        } else if (savedRoot) {
          try {
            const listing = await reader().listWorkspace(savedRoot);
            setRoot(savedRoot); setFiles(listing.files);
            const currentDirectory = session?.currentDirectory || savedRoot;
            try { await loadDirectory(savedRoot, currentDirectory); } catch { await loadDirectory(savedRoot, savedRoot); warn('上次打开的文件夹已失效，已回到资料根目录'); }
          } catch { warn('上次资料文件夹不可用，已跳过'); }
        }
        if (launch.files.length) {
          setFiles(previous => [...launch.files, ...previous.filter(old => !launch.files.some(item => item.path === old.path))]);
          if (launchRecovery && launch.files[0].type === 'md') {
            const file = launch.files[0];
            try {
              const loaded = await reader().readNote(file.path);
              setNote(loaded); setNoteTabs([file]); setNoteMode(launchRecovery.mode);
              setRecoveryId(launchRecovery.recoveryId); replaceNoteText(loaded.content); setLayout('note');
              try {
                const recovery = await reader().checkRecovery({ sourcePath: loaded.path, recoveryId: launchRecovery.recoveryId });
                if (recovery.status === 'recoverable') { replaceNoteText(recovery.recovery.content); setSaveLabel('编辑中'); }
                else if (recovery.status === 'conflict') setRecoveryConflict({ note: recovery.note, recovery: recovery.recovery, recoveryId: launchRecovery.recoveryId });
                else if (recovery.status === 'corrupt') warn(`恢复稿损坏但已保留：${file.name}`);
              } catch { warn(`无法读取笔记恢复稿：${file.name}`); }
            } catch { warn(`启动笔记不可用：${file.name}`); }
          } else await openEntry(launch.files[0]);
        } else if (session) {
          setSidebar(session.sidebar); setSplitAt(session.splitAt);
          setScrollMemory(session.version === 2 ? session.scrollMemory : []);
          const restoredTabs: WorkspaceFile[] = [];
          for (const filePath of session.noteTabs) {
            try { await reader().readNote(filePath); restoredTabs.push(fromPath(filePath)); }
            catch { warn(`笔记标签已失效，已跳过：${fromPath(filePath).name}`); }
          }
          setNoteTabs(restoredTabs);
          if (!savedRoot && settings.recentFiles?.length) setFiles(settings.recentFiles.map(fromPath));

          if (session.primaryNote) {
            try {
              const loaded = await reader().readNote(session.primaryNote.path);
              // Hydrate text together with the disk snapshot, before any
              // asynchronous recovery lookup can expose this document.
              replaceNoteText(loaded.content);
              setNote(loaded); setNoteMode(session.primaryNote.mode); setRecoveryId(session.primaryNote.recoveryId);
              if (!restoredTabs.some(tab => tab.path === loaded.path)) setNoteTabs(tabs => [...tabs, fromPath(loaded.path)]);
              try {
                const recovery = await reader().checkRecovery({ sourcePath: loaded.path, recoveryId: session.primaryNote.recoveryId });
                if (recovery.status === 'recoverable') { replaceNoteText(recovery.recovery.content); setSaveLabel('编辑中'); }
                else if (recovery.status === 'conflict') setRecoveryConflict({ note: recovery.note, recovery: recovery.recovery, recoveryId: session.primaryNote.recoveryId });
                else if (recovery.status === 'corrupt') warn(`恢复稿损坏但已保留：${fromPath(loaded.path).name}`);
              } catch { warn(`无法读取笔记恢复稿：${fromPath(loaded.path).name}`); }
            } catch { warn(`上次笔记不可用，已跳过：${fromPath(session.primaryNote.path).name}`); }
          }
          if (session.secondaryNote) {
            try {
              const loaded = await reader().readNote(session.secondaryNote.path);
              try { setSecondRecoveryCheck(await reader().checkRecovery({ sourcePath: loaded.path, recoveryId: session.secondaryNote.recoveryId })); }
              catch { warn(`无法读取右栏笔记恢复稿：${fromPath(loaded.path).name}`); }
              // Do not mount an autosaving pane until its recovery check settles.
              setSecondNote(loaded); setSecondRecoveryId(session.secondaryNote.recoveryId);
              setSecondNoteMode(session.secondaryNote.mode);
              if (!restoredTabs.some(tab => tab.path === loaded.path)) setNoteTabs(tabs => [...tabs, fromPath(loaded.path)]);
            } catch { warn(`上次右栏笔记不可用，已跳过：${fromPath(session.secondaryNote.path).name}`); }
          }
          if (session.activePdf) {
            try {
              const loaded = await reader().openPdf(session.activePdf.path);
              setActivePdf({ path: loaded.path, name: fromPath(loaded.path).name, data: loaded.data, meta: loaded.meta });
              setPage(session.activePdf.page || loaded.meta.page || 1); setScale(session.activePdf.scale);
            } catch { warn(`上次 PDF 不可用，已跳过：${fromPath(session.activePdf.path).name}`); }
          } else if (session.activeEpub) {
            try {
              const loaded = await reader().openEpub(session.activeEpub);
              const epub = { path: loaded.path, name: fromPath(loaded.path).name, data: loaded.data, meta: loaded.meta };
              activeEpubRef.current = epub; setActiveEpub(epub);
              if (loaded.warnings?.length) warn(loaded.warnings.join('；'));
            } catch { warn(`上次 EPUB 不可用，已跳过：${fromPath(session.activeEpub).name}`); }
          }
          setLayout(session.layout);
        } else if (settings.recentFiles?.length && !savedRoot) setFiles(settings.recentFiles.map(fromPath));
      } catch (error) { setMessage(`恢复上次位置失败：${error instanceof Error ? error.message : String(error)}`); }
      finally { setSessionReady(true); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDirectory]);

  useEffect(() => {
    let opening = Promise.resolve();
    return reader().onOpenLaunchItems(items => {
      opening = opening.then(async () => {
        if (items.root) {
          setRoot(items.root); setFiles(items.files); setResults([]); setQuery('');
          await loadDirectory(items.root, items.root);
        } else if (items.files.length) {
          setFiles(previous => [...items.files, ...previous.filter(old => !items.files.some(item => item.path === old.path))]);
        }
        if (items.files[0]) await openEntryRef.current(items.files[0], { skipUnsavedPrompt: true });
      }).catch(error => setMessage(`无法打开：${error instanceof Error ? error.message : String(error)}`));
    });
  }, [loadDirectory]);

  useEffect(() => {
    if (!sessionReady) return;
    const timeout = window.setTimeout(() => void saveSessionNow(), 300);
    return () => window.clearTimeout(timeout);
  }, [sessionReady, saveSessionNow]);

  const finishClosing = useCallback(async () => {
    setClosing(true);
    window.dispatchEvent(new Event('reader-flush'));
    const okay = await saveCurrent() && await secondSave.current();
    let readersSaved = true;
    try { await Promise.all([pdfSaveQueue.current, epubSaveQueue.current]); }
    catch { readersSaved = false; setMessage('阅读进度或标注尚未保存成功，请重试后关闭。'); setClosing(false); }
    const sessionSaved = await saveSessionNow();
    if (okay && readersSaved && sessionSaved && !primaryConflict.current) reader().confirmClose();
  }, [saveCurrent, saveSessionNow]);
  useEffect(() => reader().onAppClosing(finishClosing), [finishClosing]);

  async function openEntry(file: WorkspaceFile, options: { replaceCurrentNote?: boolean; skipUnsavedPrompt?: boolean } = {}) {
    if (file.type === 'md' && file.path === noteRef.current?.path) { setLayout('note'); return; }
    const request = ++openSequence.current;
    const proceed = async () => {
    const replacedNotePath = options.replaceCurrentNote ? noteRef.current?.path : undefined;
    try {
      window.dispatchEvent(new Event('reader-flush'));
      await Promise.all([pdfSaveQueue.current, epubSaveQueue.current]);
      if (request !== openSequence.current) return;
      if (file.type === 'md') {
        if (file.path === secondNote?.path) { setLayout('note'); return; }
        const loaded = await reader().readNote(file.path);
        if (request !== openSequence.current) return;
        releaseMutationBarrier(loaded.path);
        setNoteTabs(tabs => {
          if (!options.replaceCurrentNote) return tabs.some(tab => tab.path === file.path) ? tabs : [...tabs, file];
          const remaining = tabs.filter(tab => tab.path !== replacedNotePath && tab.path !== file.path);
          return [...remaining, file];
        });
        setNoteMode('edit');
        setRecoveryId(crypto.randomUUID()); setRecoveryConflict(null);
        setNote(loaded); replaceNoteText(loaded.content); setSaveLabel('已保存'); setLayout('note');
      } else if (file.type === 'pdf') {
        const loaded = await reader().openPdf(file.path);
        if (request !== openSequence.current) return;
        setActivePdf({ path: loaded.path, name: file.name, data: loaded.data, meta: loaded.meta });
        activeEpubRef.current = null; setActiveEpub(null);
        setPage(loaded.meta.page || 1); setLayout(noteRef.current ? 'split' : 'read');
      } else {
        const loaded = await reader().openEpub(file.path);
        if (request !== openSequence.current) return;
        const epub = { path: loaded.path, name: file.name, data: loaded.data, meta: loaded.meta };
        activeEpubRef.current = epub; setActiveEpub(epub);
        if (loaded.warnings?.length) setMessage(loaded.warnings.join('；'));
        setActivePdf(null);
        setLayout(noteRef.current ? 'split' : 'read');
      }
    } catch (error) { setMessage(`无法打开：${error instanceof Error ? error.message : String(error)}`); }
    };
    if (noteRef.current && !sameNoteContent(textRef.current, noteRef.current.content) && options.skipUnsavedPrompt) {
      if (!(await saveCurrent())) return;
    } else if (noteRef.current && !sameNoteContent(textRef.current, noteRef.current.content)) {
      setUnsavedAction({ description: `切换到“${file.name}”`, action: proceed });
      return;
    }
    await proceed();
  }
  openEntryRef.current = openEntry;
  async function openWorkspace() {
    const selected = await reader().chooseWorkspace();
    if (selected) { setRoot(selected.path); setFiles(selected.files); setResults([]); setQuery(''); await loadDirectory(selected.path, selected.path); }
  }
  function beginInline(kind: 'note' | 'folder', parentPath = directory?.directory || root) {
    if (!parentPath) { setMessage('请先打开资料文件夹'); return; }
    setSidebar(true); setFileContextMenu(null); setInlineEntryEdit({ kind, parentPath, value: kind === 'note' ? '新笔记.md' : '新建文件夹' });
  }
  function beginRename(entry: WorkspaceDirectoryEntry) {
    setFileContextMenu(null); setInlineEntryEdit({ kind: 'rename', entry, parentPath: pathDir(entry.path), value: entry.kind === 'file' ? entry.name.replace(/\.(md|markdown|pdf|epub)$/i, '') : entry.name });
  }
  async function commitInline() {
    const edit = inlineEntryEdit; if (!edit || edit.busy) return;
    const parentPath = edit.parentPath || directory?.directory || root; if (!parentPath) return;
    setInlineEntryEdit({ ...edit, busy: true, error: undefined });
    try {
      if (edit.kind === 'rename' && edit.entry) {
        const oldPath = edit.entry.path, startDirectory = directory?.directory || root;
        if (!(await saveCurrent()) || !(await secondSave.current())) { setInlineEntryEdit({ ...edit, busy: false }); return; }
        mutationBarrier.current.block(oldPath);
        const renamed = await reader().renameEntry({ path: edit.entry.path, name: edit.value });
        const newPath = renamed.path;
        const remap = (value: string) => remapDescendantPath(value, oldPath, newPath);
        setNoteTabs(tabs => tabs.map(tab => ({ ...tab, path: remap(tab.path), name: remap(tab.path).split(/[\\/]/).pop() || tab.name })));
        if (noteRef.current && sameOrDescendantPath(noteRef.current.path, oldPath)) { const next = { ...noteRef.current, path: remap(noteRef.current.path) }; setNote(next); }
        if (secondNote && sameOrDescendantPath(secondNote.path, oldPath)) setSecondNote(current => current ? { ...current, path: remap(current.path) } : current);
        setFiles(items => items.map(item => ({ ...item, path: remap(item.path), name: remap(item.path).split(/[\\/]/).pop() || item.name })));
        if (activePdf && sameOrDescendantPath(activePdf.path, oldPath)) setActivePdf(value => value ? { ...value, path: remap(value.path) } : value);
        if (activeEpub && sameOrDescendantPath(activeEpub.path, oldPath)) { const next = { ...activeEpub, path: remap(activeEpub.path) }; activeEpubRef.current = next; setActiveEpub(next); }
        if (directory && sameOrDescendantPath(directory.directory, oldPath)) setDirectory(value => value ? { ...value, directory: remap(value.directory), parent: value.parent ? remap(value.parent) : null, breadcrumbs: value.breadcrumbs.map(item => ({ ...item, path: remap(item.path) })) } : value);
        setScrollMemory(items => items.map(item => sameOrDescendantPath(item.path, oldPath) ? { ...item, path: remap(item.path) } : item));
        setInlineEntryEdit(null); try { await loadDirectory(root, sameOrDescendantPath(startDirectory, oldPath) ? remap(startDirectory) : startDirectory); } catch (error) { setMessage(`刷新目录失败：${error instanceof Error ? error.message : String(error)}`); }
      } else if (edit.kind === 'note') {
        const loaded = await reader().createNoteAt({ directory: parentPath, name: edit.value, initialContent: '# 新笔记\n\n' });
        setInlineEntryEdit(null); await loadDirectory(root, parentPath); await openEntry({ path: loaded.path, name: loaded.path.split(/[\\/]/).pop() || edit.value, relative: loaded.path, type: 'md' });
      } else {
        await reader().createFolderAt({ directory: parentPath, name: edit.value }); setInlineEntryEdit(null); await loadDirectory(root, parentPath);
      }
    } catch (error) { if (edit.entry) releaseMutationBarrier(edit.entry.path); setInlineEntryEdit({ ...edit, busy: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  function pathDir(value: string) { return value.replace(/[\\/][^\\/]*$/, '') || value; }
  async function deleteEntry(entry: WorkspaceDirectoryEntry) {
    setFileContextMenu(null); if (!window.confirm(`确定将“${entry.name}”移到回收站吗？`)) return;
    const oldPath = entry.path, startDirectory = directory?.directory || root;
    if (!(await saveCurrent()) || !(await secondSave.current())) return;
    mutationBarrier.current.block(oldPath);
    try { await reader().trashEntry(oldPath); const affected = (value: string) => sameOrDescendantPath(value, oldPath); if (note?.path && affected(note.path)) { setNote(null); replaceNoteText(''); setRecoveryId(null); } if (secondNote?.path && affected(secondNote.path)) { setSecondNote(null); setSecondRecoveryId(null); } setNoteTabs(tabs => tabs.filter(tab => !affected(tab.path))); setFiles(items => items.filter(item => !affected(item.path))); setScrollMemory(items => items.filter(item => !affected(item.path))); if (activePdf?.path && affected(activePdf.path)) setActivePdf(null); if (activeEpub?.path && affected(activeEpub.path)) { activeEpubRef.current = null; setActiveEpub(null); } try { await loadDirectory(root, startDirectory); } catch (error) { setMessage(`刷新目录失败：${error instanceof Error ? error.message : String(error)}`); } }
    catch (error) { releaseMutationBarrier(oldPath); setMessage(`删除失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { /* retain successful tombstone; remove only on backend failure */ }
  }
  async function openFiles() {
    const selected = await reader().chooseFiles();
    setNoteTabs(tabs => [...tabs, ...selected.filter(file => file.type === 'md' && !tabs.some(tab => tab.path === file.path))]);
    if (selected.length) { setFiles(previous => [...selected, ...previous.filter(old => !selected.some(item => item.path === old.path))]); await openEntry(selected[0]); }
  }
  async function newNote() {
    if (!(await saveCurrent())) return;
    const loaded = await reader().createNote({ suggestedName: '新笔记.md', initialContent: '# 新笔记\n\n' });
    if (!loaded) return;
    releaseMutationBarrier(loaded.path);
    setNoteTabs(tabs => [...tabs, { path: loaded.path, name: loaded.path.split(/[\\/]/).pop() || '新笔记.md', relative: loaded.path, type: 'md' }]);
    setRecoveryId(crypto.randomUUID()); setRecoveryConflict(null);
    setNote(loaded); replaceNoteText(loaded.content); setSaveLabel('已保存'); setLayout('note');
    setFiles(previous => [{ path: loaded.path, name: loaded.path.split(/[\\/]/).pop() || '新笔记.md', relative: loaded.path, type: 'md' }, ...previous]);
    if (root && directory) {
      try { const listing = await reader().listWorkspace(root); setFiles(listing.files); await loadDirectory(root, directory.directory); } catch { /* the note may have been created outside this workspace */ }
    }
  }
  async function openBrowserEntry(entry: WorkspaceDirectoryEntry) {
    if (entry.kind === 'folder') {
      try { await loadDirectory(root, entry.path); setResults([]); }
      catch (error) { setMessage(`无法打开文件夹：${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    await openEntry(entry, { replaceCurrentNote: true });
  }
  async function openNoteInSecondary(file: WorkspaceFile) {
    if (file.type !== 'md') return;
    if (!noteRef.current) { await openEntry(file, { replaceCurrentNote: true }); setMessage('这份笔记已在左栏打开；再右键另一份笔记即可对照。'); return; }
    if (noteRef.current.path === file.path) { setActiveNotePane('primary'); setMessage('这份笔记已经在左栏打开。'); return; }
    if (secondNote?.path === file.path) { setActiveNotePane('secondary'); setLayout('note'); return; }
    if (secondNote && !(await secondSave.current())) return;
    try {
      const loaded = await reader().readNote(file.path);
      setSecondNote(loaded); setSecondRecoveryId(crypto.randomUUID()); setSecondRecoveryCheck(undefined); setSecondNoteMode('edit'); setActiveNotePane('secondary'); setLayout('note');
      setNoteTabs(tabs => tabs.some(tab => tab.path === file.path) ? tabs : [...tabs, file]);
    } catch (error) { setMessage(`无法在右栏打开：${error instanceof Error ? error.message : String(error)}`); }
  }
  async function swapNotePanes() {
    if (!noteRef.current || !secondNote || swappingNotes) return;
    setSwappingNotes(true);
    try {
      if (!(await saveCurrent()) || !(await secondSave.current())) return;
      const leftPath = noteRef.current.path, rightPath = secondNote.path;
      const [nextLeft, nextRight] = await Promise.all([reader().readNote(rightPath), reader().readNote(leftPath)]);
      const oldLeftMode = noteMode, oldRightMode = secondNoteMode;
      setNote(nextLeft); replaceNoteText(nextLeft.content); setNoteMode(oldRightMode); setRecoveryId(crypto.randomUUID()); setRecoveryConflict(null); setSaveLabel('已保存');
      setSecondNote(nextRight); setSecondNoteMode(oldLeftMode); setSecondRecoveryId(crypto.randomUUID()); setSecondRecoveryCheck(undefined); setActiveNotePane(pane => pane === 'primary' ? 'secondary' : 'primary');
    } catch (error) { setMessage(`无法交换左右笔记：${error instanceof Error ? error.message : String(error)}`); }
    finally { setSwappingNotes(false); }
  }
  function reorderNoteTab(movedPath: string, targetPath: string, after: boolean) {
    if (movedPath === targetPath) return;
    setNoteTabs(tabs => {
      const moved = tabs.find(tab => tab.path === movedPath);
      if (!moved) return tabs;
      const remaining = tabs.filter(tab => tab.path !== movedPath);
      const targetIndex = remaining.findIndex(tab => tab.path === targetPath);
      if (targetIndex < 0) return tabs;
      remaining.splice(targetIndex + (after ? 1 : 0), 0, moved);
      return remaining;
    });
  }
  async function runSearch() {
    const current = searchRequest.current.begin();
    if (!root || !query.trim()) { setResults([]); return; }
    try { const results = await reader().search({ root, query }); if (current()) setResults(results); }
    catch (error) { if (current()) setMessage(`搜索失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  async function updateMeta(change: (current: PdfMeta) => PdfMeta) {
    const active = activePdf;
    if (!active) return false;
    const write = pdfWriter.current.write({ key: active.data, initial: active.meta, change,
      persist: meta => reader().savePdfMeta({ path: active.path, meta }),
      commit: meta => setActivePdf(current => current && current.path === active.path && current.meta.id === meta.id ? { ...current, meta } : current),
    });
    pdfSaveQueue.current = write;
    try { return await write; }
    catch (error) { setMessage(`标记保存失败：${error instanceof Error ? error.message : String(error)}`); return false; }
  }
  async function updateEpubMeta(change: (current: EpubMeta) => EpubMeta): Promise<boolean> {
    const active = activeEpub;
    if (!active) return false;
    const write = epubWriter.current.write({ key: active.data, initial: active.meta, change,
      persist: meta => reader().saveEpubMeta({ path: active.path, meta }),
      commit: meta => {
        const current = activeEpubRef.current;
        if (current?.path === active.path && current.meta.id === meta.id) {
          const next = { ...current, meta }; activeEpubRef.current = next; setActiveEpub(next);
        }
      },
    });
    epubSaveQueue.current = write;
    try { return await write; }
    catch (error) { setMessage(`EPUB 标注或阅读位置保存失败：${error instanceof Error ? error.message : String(error)}`); return false; }
  }
  async function insertExcerpt(asset: string | null, anchor: PdfAnchor, quote?: string) {
    if (!noteRef.current || !activePdf) { setMessage('请先打开或新建一份 Markdown 笔记'); return; }
    if (conflict || recoveryConflict || mutationBarrier.current.has(noteRef.current.path)) { setMessage('请先处理当前笔记的保存或恢复冲突'); return; }
    const path = noteRef.current.path, documentId = primarySession.documentId.current;
    const insert = primaryInsertExcerpt.current, opening = openSequence.current, pdf = activePdf;
    const source = await reader().makeAnchorPath({ fromFile: path, toFile: pdf.path });
    if (opening !== openSequence.current || path !== noteRef.current?.path || documentId !== primarySession.documentId.current ||
        insert !== primaryInsertExcerpt.current || pdf.meta.id !== excerptContext.current.activePdf?.meta.id || primarySession.blocked()) {
      setMessage('文件已切换，未插入过期摘录，请重新摘录。'); return;
    }
    const fullAnchor = { ...anchor, source };
    const link = `#reader-anchor-${encodeReaderAnchor(fullAnchor)}`;
    const image = asset ? `![PDF 第 ${anchor.page} 页摘录](${asset})\n\n` : '';
    const quotation = quote ? `> ${quote.replace(/\n+/g, '\n> ')}\n\n` : '';
    if (!insert(`\n\n${image}${quotation}> 来源：《${pdf.name}》 · 第 ${anchor.page} 页 · [回到原文](${link})\n`)) { setMessage('编辑器尚未就绪，请稍后重试摘录'); return; }
    setLayout('split');
  }
  async function insertEpubExcerpt(anchor: EpubAnchor, quote: string, comment: string) {
    const useSecondary = activeNotePane === 'secondary' && !!secondNote;
    const currentNotePath = useSecondary ? secondNote!.path : noteRef.current?.path;
    if (!currentNotePath) { setMessage('请先打开 Markdown 笔记，再摘录到笔记。'); return; }
    const book = activeEpubRef.current;
    if (!book || book.meta.id !== anchor.epubId) { setMessage('电子书已切换，请重新选择要摘录的原文。'); return; }
    const insert = useSecondary ? secondInsertExcerpt.current : primaryInsertExcerpt.current;
    const documentId = primarySession.documentId.current, secondaryId = secondRecoveryId, opening = openSequence.current;
    try {
      const source = await reader().makeAnchorPath({ fromFile: currentNotePath, toFile: book.path });
      if (opening !== openSequence.current || activeEpubRef.current?.path !== book.path ||
          (useSecondary ? excerptContext.current.secondNote?.path !== currentNotePath || excerptContext.current.secondRecoveryId !== secondaryId || insert !== secondInsertExcerpt.current
            : noteRef.current?.path !== currentNotePath || documentId !== primarySession.documentId.current || insert !== primaryInsertExcerpt.current || primarySession.blocked())) {
        setMessage('文件或笔记栏已切换，未插入过期摘录，请重新摘录。'); return;
      }
      const fullAnchor = { ...anchor, source };
      const link = `#reader-anchor-${encodeReaderAnchor(fullAnchor)}`;
      const quotation = quote ? `> ${quote.replace(/\n+/g, '\n> ')}\n\n` : '';
      const commentLine = comment.trim() ? `> 批注：${comment.trim().replace(/\n+/g, ' ')}\n\n` : '';
      const block = `\n\n${quotation}${commentLine}> 来源：《${formatEpubAnchor(anchor, book.name)}》 · [回到原文](${link})\n`;
      const inserted = !mutationBarrier.current.has(currentNotePath) && insert(block);
      if (!inserted) { setMessage('当前笔记栏暂不可写入摘录。'); return; }
      setLayout('split');
    } catch (error) { setMessage(`无法插入 EPUB 摘录：${error instanceof Error ? error.message : String(error)}`); }
  }
  async function jumpTo(anchor: ReaderAnchor, fromNotePath = noteRef.current?.path) {
    try {
      if (isEpubAnchor(anchor)) {
        let epub = activeEpubRef.current;
        if (!epub || epub.meta.id !== anchor.epubId) {
          let path = anchor.source && fromNotePath ? await reader().resolveAnchorPath({ fromFile: fromNotePath, storedPath: anchor.source, epubId: anchor.epubId }) : null;
          if (!path) path = await reader().chooseEpubRelocation({ epubId: anchor.epubId });
          if (!path) { setMessage('没有找到原 EPUB。请选择内容相同的电子书重新定位。'); return; }
          const loaded = await reader().openEpub(path);
          if (loaded.meta.id !== anchor.epubId) { setMessage('所选 EPUB 与摘录时的文件内容不同，未跳转。'); return; }
          epub = { path: loaded.path, name: loaded.path.split(/[\\/]/).pop() || 'EPUB', data: loaded.data, meta: loaded.meta };
          activeEpubRef.current = epub; setActiveEpub(epub); setActivePdf(null);
          if (loaded.warnings?.length) setMessage(loaded.warnings.join('；'));
        }
        setTarget(anchor); setLayout(noteRef.current || secondNote ? 'split' : 'read');
        window.setTimeout(() => setTarget(current => current === anchor ? null : current), 8000);
        return;
      }
      const pdfAnchor = anchor as PdfAnchor;
      let pdf = activePdf;
      if (!pdf || pdf.meta.id !== pdfAnchor.pdfId) {
        let path = pdfAnchor.source && fromNotePath ? await reader().resolveAnchorPath({ fromFile: fromNotePath, storedPath: pdfAnchor.source, pdfId: pdfAnchor.pdfId }) : null;
        if (!path) path = await reader().chooseRelocation({ pdfId: pdfAnchor.pdfId });
        if (!path) { setMessage('没有找到原 PDF。请选择内容相同的文件重新定位。'); return; }
        const loaded = await reader().openPdf(path);
        if (loaded.meta.id !== pdfAnchor.pdfId) { setMessage('所选 PDF 与摘录时的文件内容不同，未跳转。'); return; }
        pdf = { path: loaded.path, name: loaded.path.split(/[\\/]/).pop() || 'PDF', data: loaded.data, meta: loaded.meta };
        setActivePdf(pdf); setActiveEpub(null);
      }
      setPage(pdfAnchor.page); setTarget(pdfAnchor); setLayout('split');
      window.setTimeout(() => setTarget(current => current === pdfAnchor ? null : current), 8000);
    } catch (error) { setMessage(`无法回到原文：${error instanceof Error ? error.message : String(error)}`); }
  }
  async function saveAs() {
    if (!noteRef.current) return;
    const old = noteRef.current;
    const submitted = textRef.current;
    const loaded = await reader().saveAs({ sourcePath: old.path, suggestedName: old.path.split(/[\\/]/).pop(), content: submitted });
    if (loaded) {
      const previousPath = old.path;
      await clearRecoveryIfMatches(previousPath, recoveryId, submitted);
      releaseMutationBarrier(loaded.path);
      setNote(loaded); setRecoveryId(crypto.randomUUID()); setRecoveryConflict(null);
      setNoteTabs(tabs => [...tabs.filter(tab => tab.path !== previousPath && tab.path !== loaded.path), { path: loaded.path, name: loaded.path.split(/[\\/]/).pop() || loaded.path, relative: loaded.path, type: 'md' }]);
      replaceNoteText(loaded.content); primaryConflict.current = null; setConflict(null); setSaveLabel('已保存'); if (closing) await finishClosing();
    }
  }
  async function keepMine() {
    if (!noteRef.current || !conflict?.conflict) return;
    // Rebase on the disk snapshot the user saw, then use the normal serial save
    // gate. Another external change still produces a fresh conflict.
    noteRef.current = { ...noteRef.current, content: conflict.content, hash: conflict.hash, bom: conflict.bom, eol: conflict.eol };
    setNote(noteRef.current); primaryConflict.current = null; setConflict(null);
    if (await saveCurrent() && closing) await finishClosing();
  }
  async function useDisk() {
    if (!conflict?.conflict) return;
    await clearRecoveryIfMatches(conflict.path, recoveryId, undefined);
    setNote(conflict); replaceNoteText(conflict.content); primaryConflict.current = null; setConflict(null); setSaveLabel('已保存'); if (closing) await finishClosing();
  }
  async function clearRecoveryIfMatches(sourcePath: string, id: string | null, content: string | undefined) {
    if (!id) return;
    try {
      const result = await reader().checkRecovery({ sourcePath, recoveryId: id });
      if ((result.status === 'recoverable' || result.status === 'conflict') && (content === undefined || sameNoteContent(result.recovery.content, content))) {
        await reader().deleteRecovery({ sourcePath, recoveryId: id, draftHash: result.recovery.draftHash });
      }
    } catch { /* Keep an unreadable recovery file for the next launch. */ }
  }
  async function keepRecoveryDraft() {
    if (!recoveryConflict || !recoveryId) return;
    const { note: disk, recovery, recoveryId: id } = recoveryConflict;
    const result = await reader().saveNote({ path: disk.path, content: recovery.content, hash: disk.hash, bom: disk.bom, eol: disk.eol, recoveryId: id });
    if (result.conflict) { setRecoveryConflict({ note: result, recovery, recoveryId: id }); return; }
    const saved = { ...disk, ...result };
    setNote(saved); replaceNoteText(saved.content); setRecoveryConflict(null); setSaveLabel('已保存');
  }
  async function discardRecoveryDraft() {
    if (!recoveryConflict) return;
    await reader().deleteRecovery({ sourcePath: recoveryConflict.note.path, recoveryId: recoveryConflict.recoveryId, draftHash: recoveryConflict.recovery.draftHash });
    setNote(recoveryConflict.note); replaceNoteText(recoveryConflict.note.content); setRecoveryConflict(null); setSaveLabel('已保存');
  }
  async function saveRecoveryDraftAs() {
    if (!recoveryConflict) return;
    const saved = await reader().saveAs({ sourcePath: recoveryConflict.note.path, suggestedName: recoveryConflict.note.path.split(/[\\/]/).pop(), content: recoveryConflict.recovery.content });
    if (!saved) return;
    releaseMutationBarrier(saved.path);
    await reader().deleteRecovery({ sourcePath: recoveryConflict.note.path, recoveryId: recoveryConflict.recoveryId, draftHash: recoveryConflict.recovery.draftHash });
    setNote(saved); setRecoveryId(crypto.randomUUID()); replaceNoteText(saved.content); setRecoveryConflict(null); setSaveLabel('已保存');
  }

  async function closeNoteTab(tab: WorkspaceFile) {
    const proceed = async () => {
      if (tab.path === secondNote?.path) { if (!(await secondSave.current())) return; setSecondNote(null); }
      if (tab.path === note?.path) {
        if (!(await saveCurrent())) return;
        const next = noteTabs.find(item => item.path !== tab.path && item.path !== secondNote?.path);
        if (next) await openEntry(next); else { setNote(null); setRecoveryId(null); setRecoveryConflict(null); replaceNoteText(''); }
      }
      setNoteTabs(tabs => tabs.filter(item => item.path !== tab.path));
    };
    if (tab.path === noteRef.current?.path && !sameNoteContent(textRef.current, noteRef.current.content)) {
      setUnsavedAction({ description: `关闭“${tab.name}”`, action: proceed });
      return;
    }
    await proceed();
  }

  const visibleRecent = useMemo(() => query ? files.filter(file => file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : files, [files, query]);
  const visibleDirectory = useMemo(() => {
    const entries = directory?.entries || [];
    return query ? entries.filter(entry => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : entries;
  }, [directory, query]);
  const showContext = (event: React.MouseEvent, entry: WorkspaceDirectoryEntry) => { event.preventDefault(); event.stopPropagation(); setFileContextMenu({ entry, x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 170) }); };
  const title = [activePdf?.name || activeEpub?.name, note?.path.split(/[\\/]/).pop()].filter(Boolean).join('  ·  ') || '开始阅读与记录';
  return <div className="app" data-theme={resolvedTheme} style={{ '--reading-size': `${readingSize}px`, '--note-body-font': NOTE_BODY_FONTS[noteBodyFont], '--note-source-font': NOTE_BODY_FONTS[noteBodyFont] } as React.CSSProperties}>
    <header className="topbar">
      <button className="icon-button sidebar-toggle" aria-label={sidebar ? '收起资料栏' : '展开资料栏'} title={sidebar ? '收起资料栏' : '展开资料栏'} onClick={() => setSidebar(value => !value)}>{sidebar ? <PanelLeftClose size={18}/> : <PanelLeftOpen size={18}/>}</button>
      <nav className="layout-tabs" aria-label="工作模式">{([['read', '阅读'], ['note', '笔记'], ['split', '对照']] as const).map(([id, label]) => <button aria-pressed={layout === id} className={layout === id ? 'active' : ''} onClick={() => setLayout(id)} key={id}>{label}</button>)}</nav>
      <div className="top-actions">
        <button className="quiet-action" title={sidebar ? '收起资料栏' : '展开资料栏'} onClick={() => setSidebar(value => !value)}>{sidebar ? <PanelLeftClose size={17}/> : <PanelLeftOpen size={17}/>}<span className="action-label">资料栏</span></button>
        <div className="settings-menu" ref={settingsRef}>
          <button className="quiet-action" aria-expanded={settingsOpen} aria-haspopup="dialog" title="设置" onClick={() => setSettingsOpen(value => !value)}><Settings2 size={17}/><span className="action-label">设置</span></button>
          {settingsOpen && <div className="settings-popover" role="dialog" aria-label="阅读设置">
            <div className="settings-heading"><div><b>正文大小</b><small>用于 Markdown 编辑、预览和代码块</small></div><strong>{readingSize}px</strong></div>
            <div className="font-size-control">
              <button aria-label="减小正文字体" title="减小" disabled={readingSize <= 14} onClick={() => setReadingSize(size => Math.max(14, size - 1))}>A−</button>
              <input aria-label="正文字体大小" type="range" min="14" max="28" step="1" value={readingSize} onChange={event => setReadingSize(Number(event.target.value))}/>
              <button aria-label="增大正文字体" title="增大" disabled={readingSize >= 28} onClick={() => setReadingSize(size => Math.min(28, size + 1))}>A＋</button>
            </div>
            <button className="reset-reading-size" disabled={readingSize === 18} onClick={() => setReadingSize(18)}>恢复默认 18px</button>
            <label className="note-font-control">
              <span>正文字体</span>
              <select aria-label="Markdown 正文字体" value={noteBodyFont} onChange={event => setNoteBodyFont(event.target.value as NoteBodyFont)}>
                <option value="default">默认</option>
                <option value="fangsong">仿宋（内置）</option>
                <option value="songti">宋体</option>
              </select>
              <small>用于 Markdown 和 EPUB 正文，不影响界面和代码字体。</small>
            </label>
            <div className="settings-section">
              <span className="settings-section-title">外观</span>
              <div className="theme-options" role="group" aria-label="外观主题">
                {([
                  ['light', '浅色', <Sun size={15}/>],
                  ['dark', '深色', <Moon size={15}/>],
                  ['system', '跟随系统', <Monitor size={15}/>],
                ] as const).map(([value, label, icon]) => <button key={value} className={themePreference === value ? 'active' : ''} aria-pressed={themePreference === value} onClick={() => setThemePreference(value)}>{icon}<span>{label}</span></button>)}
              </div>
            </div>
            <div className="settings-section">
              <span className="settings-section-title">界面</span>
              <button className="settings-row" onClick={() => setSidebar(value => !value)}>{sidebar ? <PanelLeftClose size={16}/> : <PanelLeftOpen size={16}/>}<span>资料栏</span><small>{sidebar ? '已展开' : '已收起'}</small></button>
              <button className="settings-row" onClick={() => void reader().windowControl('fullscreen').then(setWindowState)}><Maximize2 size={16}/><span>全屏阅读</span><small>{windowState.fullscreen ? '退出' : '进入'}</small></button>
            </div>
            <p className="settings-shortcuts">撤销、复制、粘贴等编辑操作继续使用 Windows 常用快捷键。</p>
          </div>}
        </div>
        <button className="quiet-action" onClick={openFiles}><FolderOpen size={17}/><span className="action-label">打开文件</span></button>
        <button className="quiet-action" onClick={openWorkspace}><FolderTree size={17}/><span className="action-label">打开文件夹</span></button>
        <button className="quiet-action" onClick={() => beginInline('folder')}><FolderPlus size={17}/><span className="action-label">新建文件夹</span></button>
        <button className="new-note-action" onClick={() => beginInline('note')}><Plus size={17}/><span>新笔记</span></button>
      </div>
      <div className="window-controls" aria-label="窗口控制">
        <button aria-label="最小化窗口" title="最小化" onClick={() => void reader().windowControl('minimize')}><Minus size={16}/></button>
        <button aria-label={windowState.maximized ? '还原窗口' : '最大化窗口'} title={windowState.maximized ? '还原' : '最大化'} onClick={() => void reader().windowControl('maximize').then(setWindowState)}>{windowState.maximized ? <Copy size={13}/> : <Square size={13}/>}</button>
        <button className="window-close" aria-label="关闭窗口" title="关闭" onClick={() => void reader().windowControl('close')}><X size={17}/></button>
      </div>
    </header>
    <div className={sidebar ? 'body' : 'body sidebar-hidden'}>
      {sidebar && <aside className="sidebar">
        <div className="sidebar-head"><div><span>资料库</span><small>{files.length ? `${files.length} 个文件` : '本地文件'}</small></div></div>
        <div className="search"><Search size={16}/><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === 'Enter' && void runSearch()} placeholder="搜索文件名或笔记内容" aria-label="搜索文件名或笔记内容"/>{query && <button aria-label="清空搜索" title="清空搜索" onClick={() => { setQuery(''); setResults([]); }}><X size={14}/></button>}</div>
        {root && directory && <div className="folder-navigation">
          <button className="folder-back" aria-label="返回上一级文件夹" title="返回上一级" disabled={!directory.parent} onClick={() => directory.parent && void loadDirectory(root, directory.parent)}><ArrowLeft size={16}/></button>
          <div className="folder-address" aria-label="当前文件夹地址" title={directory.directory}><FolderOpen size={14}/><div className="folder-crumbs">{directory.breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.path}>{index > 0 && <ChevronRight size={11} className="crumb-separator"/>}<button title={crumb.path} aria-current={index === directory.breadcrumbs.length - 1 ? 'location' : undefined} onClick={() => void loadDirectory(root, crumb.path)}>{crumb.name}</button></React.Fragment>)}</div></div>
        </div>}
        <div className={'section-title ' + (root ? 'after-address' : '')}><span>{root ? '当前文件夹' : '最近文件'}</span><span>{root ? visibleDirectory.length : visibleRecent.length}</span></div>
        <div className="file-list">{inlineEntryEdit && inlineEntryEdit.kind !== 'rename' && <div className="file-row inline-entry-row"><span className={inlineEntryEdit.kind === 'folder' ? 'folder-icon' : 'file-icon md'}>{inlineEntryEdit.kind === 'folder' ? <Folder size={17}/> : 'MD'}</span><input ref={inlineEntryInputRef} className="inline-entry-input" aria-label={inlineEntryEdit.kind === 'folder' ? '新文件夹名称' : '新笔记名称'} value={inlineEntryEdit.value} disabled={inlineEntryEdit.busy} onChange={event => setInlineEntryEdit(value => value && ({ ...value, value: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter') void commitInline(); if (event.key === 'Escape') setInlineEntryEdit(null); }} />{inlineEntryEdit.error && <small className="inline-entry-error">{inlineEntryEdit.error}</small>}</div>}{root ? visibleDirectory.map(entry => {
          const activePath = entry.kind === 'file' ? entry.type === 'pdf' ? activePdf?.path : entry.type === 'epub' ? activeEpub?.path : note?.path : null;
          const renaming = inlineEntryEdit?.kind === 'rename' && inlineEntryEdit.entry?.path === entry.path;
          const body = renaming ? <><input ref={inlineEntryInputRef} className="inline-entry-input" aria-label={'重命名 ' + entry.name} value={inlineEntryEdit!.value} disabled={inlineEntryEdit!.busy} onChange={event => setInlineEntryEdit(value => value && ({ ...value, value: event.target.value }))} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') void commitInline(); if (event.key === 'Escape') setInlineEntryEdit(null); }} />{inlineEntryEdit?.error && <small className="inline-entry-error">{inlineEntryEdit.error}</small>}</> : <><span className={entry.kind === 'folder' ? 'folder-icon' : 'file-icon ' + entry.type}>{entry.kind === 'folder' ? <Folder size={17}/> : entry.type === 'pdf' ? 'PDF' : entry.type === 'epub' ? 'EPUB' : 'MD'}</span><span className="file-name">{entry.name}</span></>;
          return renaming ? <div className="file-row inline-entry-row" key={entry.path}>{body}</div> : <button title={entry.path} className={'file-row ' + (activePath === entry.path ? 'selected' : '')} key={entry.path} onContextMenu={event => showContext(event, entry)} onClick={() => void openBrowserEntry(entry)}>{body}{entry.kind === 'folder' && <ChevronRight size={14} className="folder-enter"/>}</button>;
        }) : visibleRecent.map(file => { const activePath = file.type === 'pdf' ? activePdf?.path : file.type === 'epub' ? activeEpub?.path : note?.path; return <button title={file.path} className={'file-row ' + (activePath === file.path ? 'selected' : '')} key={file.path} onContextMenu={event => showContext(event, { ...file, kind: 'file' })} onClick={() => void openEntry(file, { replaceCurrentNote: true })}><span className={'file-icon ' + file.type}>{file.type === 'pdf' ? 'PDF' : file.type === 'epub' ? 'EPUB' : 'MD'}</span><span className="file-name">{file.name}</span></button>; })}{!(root ? visibleDirectory.length : visibleRecent.length) && <div className="empty-small"><FolderOpen size={20}/><span>{root ? '这个文件夹里没有可阅读的文件' : '打开文件夹后，资料会显示在这里'}</span></div>}</div>
        {!!results.length && <><div className="section-title">搜索结果</div>{results.map(result => <button className="result-row" key={result.path} onContextMenu={event => showContext(event, { ...result, kind: 'file' })} onClick={() => void openEntry(result, { replaceCurrentNote: true })}><b>{result.name}</b><small>{result.snippet || '文件名匹配'}</small></button>)}</>}
      </aside>}
      <main className="main">
        <div className="document-tabs" role="tablist" aria-label="已打开的笔记">
          {layout !== 'note' && (activePdf || activeEpub) && <span className="reading-document" title={activePdf?.path || activeEpub?.path}><BookOpen size={14}/>{activePdf?.name || activeEpub?.name}</span>}
          {noteTabs.map(tab => <div draggable className={'document-tab ' + (note?.path === tab.path ? 'active ' : '') + (draggedTab === tab.path ? 'dragging' : '')} key={tab.path}
            onDragStart={event => { setDraggedTab(tab.path); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/x-zuoren-note-tab', tab.path); }}
            onDragEnd={() => setDraggedTab(null)}
            onDragOver={event => { if (draggedTab && draggedTab !== tab.path) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
            onDrop={event => { const movedPath = event.dataTransfer.getData('text/x-zuoren-note-tab') || draggedTab; if (!movedPath) return; event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); reorderNoteTab(movedPath, tab.path, event.clientX > bounds.left + bounds.width / 2); setDraggedTab(null); }}
            onContextMenu={event => { event.preventDefault(); void openNoteInSecondary(tab); }}>
            <button role="tab" aria-selected={note?.path === tab.path} title={`${tab.path}\n右键在右栏打开`} onClick={() => void openEntry(tab)}>{tab.name}</button>
            <button aria-label={'关闭 ' + tab.name} title="关闭标签" onClick={() => void closeNoteTab(tab)}><X size={13}/></button>
          </div>)}
          <button className="icon-button" aria-label="打开更多文件" title="打开更多文件" onClick={openFiles}><Plus size={16}/></button>
          <span className="toolbar-spacer"/>
          <span className="compact-save" title="自动保存">{saveLabel}</span>
          {secondNote && <button className="icon-button" disabled={swappingNotes} aria-label="交换左右笔记" title="交换左右笔记" onClick={() => void swapNotePanes()}><ArrowLeftRight size={17}/></button>}
          <button className="icon-button" aria-label={secondNote ? '关闭笔记分屏' : '左右分屏笔记'} title={secondNote ? '关闭笔记分屏' : '左右分屏笔记'} onClick={async () => {
            if (secondNote) { if (await secondSave.current()) { setSecondNote(null); setSecondRecoveryId(null); setSecondRecoveryCheck(undefined); } return; }
            if (!(await saveCurrent())) return;
            let candidate = noteTabs.find(tab => tab.path !== note?.path) || files.find(file => file.type === 'md' && file.path !== note?.path);
            if (!candidate) candidate = (await reader().chooseFiles()).find(tab => tab.type === 'md' && tab.path !== note?.path);
            if (!candidate) { setMessage('请再打开一份不同的 Markdown 笔记，即可左右对照。'); return; }
            try { const loaded = await reader().readNote(candidate.path); setSecondNote(loaded); setSecondRecoveryId(crypto.randomUUID()); setSecondRecoveryCheck(undefined); setSecondNoteMode('edit'); setLayout('note'); const chosen = candidate; setNoteTabs(tabs => tabs.some(tab => tab.path === chosen.path) ? tabs : [...tabs, chosen]); }
            catch (error) { setMessage(String(error)); }
          }}><Columns2 size={17}/></button>
        </div>
        <div className={'panes ' + layout} style={{ '--split-at': `${splitAt}%` } as React.CSSProperties}>
          {(layout === 'read' || layout === 'split') && (activeEpub ? <EpubPane key={activeEpub.path} epub={activeEpub} theme={resolvedTheme} noteBodyFont={noteBodyFont} onMeta={updateEpubMeta} onMessage={setMessage} onExcerpt={insertEpubExcerpt} excerptTarget={activeNotePane === 'secondary' && secondNote ? '摘录到副栏' : note ? '摘录到主栏' : null} target={isEpubAnchor(target) ? target : null}/> : <PdfPane pdf={activePdf} page={page} setPage={setPage} scale={scale} setScale={setScale} fullscreen={windowState.fullscreen} onToggleFullscreen={() => { void reader().windowControl('fullscreen').then(setWindowState); }} onMeta={updateMeta} notePath={note?.path || null} onExcerpt={insertExcerpt} target={target && 'pdfId' in target ? target : null} onMessage={setMessage}/>)} 
          {layout === 'split' && <div className="splitter" role="separator" aria-label="调整阅读与笔记宽度" aria-orientation="vertical" onPointerDown={event => { const start = event.clientX; const initial = splitAt; const move = (next: PointerEvent) => setSplitAt(Math.min(75, Math.max(25, initial + (next.clientX - start) / window.innerWidth * 100))); const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); }}/>} 
          {(layout === 'note' || layout === 'split' || !!note) && <NotePane paneId="primary" onActivate={setActiveNotePane} findCommand={findCommand?.pane === 'primary' ? findCommand : null} label={saveLabel} note={note} text={noteText} setText={setNoteText} mode={noteMode} setMode={setNoteMode} onSave={() => void saveCurrent()} onJump={jumpTo} revision={editorRevision} scrollMemory={scrollMemory} onScrollMemory={rememberScroll} excerptRegister={primaryInsertExcerpt} hidden={layout === 'read'}/>} 
          {secondNote && <div className="secondary-note" style={{ display: layout === 'note' ? 'flex' : 'none' }}><SecondaryNote key={secondNote.path} initial={secondNote} initialMode={secondNoteMode} initialRecovery={secondRecoveryCheck} recoveryId={secondRecoveryId} mutationBarrier={mutationBarrier} register={secondSave} excerptRegister={secondInsertExcerpt} onJump={jumpTo} onModeChange={setSecondNoteMode} onNoteChange={(loaded, id) => { const oldPath = secondNote.path; releaseMutationBarrier(loaded.path); setSecondNote(loaded); setSecondRecoveryId(id); setSecondRecoveryCheck(undefined); setNoteTabs(tabs => [...tabs.filter(tab => tab.path !== oldPath && tab.path !== loaded.path), { path: loaded.path, name: loaded.path.split(/[\\/]/).pop() || loaded.path, relative: loaded.path, type: 'md' }]); }} choices={noteTabs.filter(tab => tab.path !== note?.path)} onChoose={async path => { if (!(await secondSave.current())) return; try { const loaded = await reader().readNote(path); releaseMutationBarrier(loaded.path); setSecondNote(loaded); setSecondRecoveryId(crypto.randomUUID()); setSecondRecoveryCheck(undefined); setSecondNoteMode('edit'); } catch (error) { setMessage(String(error)); } }} paneId="secondary" onActivate={setActiveNotePane} findCommand={findCommand?.pane === 'secondary' ? findCommand : null} scrollMemory={scrollMemory} onScrollMemory={rememberScroll}/></div>}
        </div>
      </main>
    </div>
    {fileContextMenu && <div ref={fileContextMenuRef} className="file-context-menu" role="menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }} onPointerDown={event => event.stopPropagation()}><button role="menuitem" onClick={() => { setFileContextMenu(null); void reader().showItemInFolder(fileContextMenu.entry.path); }}>打开所在路径</button>{fileContextMenu.entry.kind === 'file' && fileContextMenu.entry.type === 'md' && <button role="menuitem" onClick={() => { const entry = fileContextMenu.entry as WorkspaceFile; setFileContextMenu(null); void openEntry(entry); }}>在新标签页中打开</button>}<button role="menuitem" onClick={() => beginRename(fileContextMenu.entry)}>重命名</button><button role="menuitem" onClick={() => void deleteEntry(fileContextMenu.entry)}>移到回收站</button></div>}
    {message && <div className="toast"><span>{message}</span><button onClick={() => setMessage('')}><X size={16}/></button></div>}
    {unsavedAction && <UnsavedDialog description={unsavedAction.description} onCancel={() => setUnsavedAction(null)} onDiscard={async () => { const action = unsavedAction.action; const current = noteRef.current; const id = recoveryId; setUnsavedAction(null); if (current) { await clearRecoveryIfMatches(current.path, id, textRef.current); replaceNoteText(current.content); setSaveLabel('已保存'); } await action(); }} onSave={async () => { const action = unsavedAction.action; setUnsavedAction(null); if (await saveCurrent()) await action(); }}/>}
    {conflict?.conflict && <ConflictDialog conflict={conflict} mine={noteText} closing={closing} onMine={() => void keepMine()} onDisk={useDisk} onSaveAs={() => void saveAs()}/>}
    {recoveryConflict && <ConflictDialog conflict={{ conflict: true, ...recoveryConflict.note }} mine={recoveryConflict.recovery.content} closing={false} onMine={() => void keepRecoveryDraft()} onDisk={() => void discardRecoveryDraft()} onSaveAs={() => void saveRecoveryDraftAs()}/>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
