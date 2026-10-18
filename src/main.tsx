import { PdfPane } from './readers/PdfPane';
import { createPdfTextAction, type PdfTextActionHandler } from './readers/pdfTextAction';
import { EpubPane } from './readers/EpubPane';
import { ReaderSession } from './readers/readerSession';
import { createExcerptFlow, type ExcerptFlowFailure, type ExcerptFlowResult } from './readers/excerptFlow';
import type { PdfExcerptContext } from './readers/pdfRegionAction';
import { NoteWorkspace, documentKey, type NoteGroupId } from './workspace/noteWorkspace';
import { NoteGroupPane } from './workspace/NoteGroupPane';
import { ConflictDialog, UnsavedDialog, TrashConfirmation } from './workspace/DocumentDialogs';
import { reader, NOTE_BODY_FONTS, type Layout, type ThemePreference, type NoteBodyFont, type ActivePdf, type ActiveEpub, type FileContextMenu, type InlineEntryEdit, type FindCommand } from './readerContext';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ChevronRight, Copy, Folder, FolderOpen, FolderPlus, FolderTree, Maximize2, Minimize2, Minus, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Square, Sun, X } from 'lucide-react';
import { diagnostics } from './diagnostics.cjs';
import { LatestRequest } from './asyncRequest.cjs';
import { SessionWriter } from './sessionWriter.cjs';
import type { DirectoryListing, EpubAnchor, EpubAnnotation, MarkdownScrollMemory, PdfAnchor, PdfMeta, ReaderAnchor, ReaderSessionV3, SearchResult, WorkspaceDirectoryEntry, WorkspaceFile } from './types';
import { encodeReaderAnchor, formatEpubAnchor, isEpubAnchor } from './readerAnchor.cjs';
import { upsertScrollMemory } from './sessionState.cjs';
import { MutationBarrier, remapDescendantPath, sameOrDescendantPath } from './fileOperations.cjs';

import { THEMES, parseThemePreference, resolveTheme, themeVariables, type ThemeName } from './appearanceTheme.cjs';
import './styles.css';
import { useFullscreenChrome } from './useFullscreenChrome';
import { ReducedMotionContext, usePanelMotion, useTabMotion } from './uiMotion';
import { ContextMenu, useOverlayFocus } from './ui/overlays';
import { PaneSplitter } from './ui/PaneSplitter';
import './ui/chrome.css';

Object.defineProperty(window, 'readerDiagnostics', { configurable: true, value: Object.freeze({ snapshot: () => diagnostics.snapshot() }) });

const readThemePreference = (): ThemePreference => {
  try {
    const saved = window.localStorage.getItem('zhaoye-theme');
    return parseThemePreference(saved);
  } catch { return 'constructivist'; }
};
function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = THEMES[theme].colorScheme;
  for (const [property, value] of Object.entries(themeVariables(theme))) root.style.setProperty(property, value);
}
const readNoteBodyFont = (): NoteBodyFont => {
  try {
    const saved = window.localStorage.getItem('zhaoye-note-font');
    if (saved === 'source-han-serif') return 'songti';
    return saved === 'default' || saved === 'fangsong' || saved === 'songti' || saved === 'hanyi-shufang-55w' ? saved : 'fangsong';
  } catch { return 'fangsong'; }
};
const initialThemePreference = readThemePreference();
applyTheme(resolveTheme(initialThemePreference, window.matchMedia('(prefers-color-scheme: dark)').matches));

function App() {
  const [noteTabsTarget, setNoteTabsTarget] = useState<HTMLDivElement | null>(null);
  const [noteControlsTarget, setNoteControlsTarget] = useState<HTMLDivElement | null>(null);
  const [readerHeaderTarget, setReaderHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [activeSurface, setActiveSurface] = useState<'reader' | 'note'>('note');
  const [readerClosing, setReaderClosing] = useState(false);
  const readerCloseFlight = useRef(false);
  const [layout, setLayout] = useState<Layout>('split');
  const [sessionReady, setSessionReady] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(() => { try { return localStorage.getItem('zhaoye-reduce-motion') === 'true'; } catch { return false; } });
  const [systemReduced, setSystemReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const motionReduced = reduceMotion || systemReduced;
  const sidebarMotion = usePanelMotion(sidebar, motionReduced || !sessionReady, '-100%', 220, () => document.querySelector('.sidebar-toggle'));
  useTabMotion(noteTabsTarget, motionReduced);
  useEffect(() => { try { localStorage.setItem('zhaoye-reduce-motion', String(reduceMotion)); } catch {} }, [reduceMotion]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setSystemReduced(media.matches);
    media.addEventListener('change', changed); return () => media.removeEventListener('change', changed);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [windowState, setWindowState] = useState({ maximized: false, fullscreen: false });
  useFullscreenChrome(windowState.fullscreen);
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialThemePreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [readingSize, setReadingSize] = useState(() => {
    const saved = Number(window.localStorage.getItem('zhaoye-reading-size'));
    return Number.isFinite(saved) && saved >= 14 && saved <= 28 ? saved : 18;
  });
  const [noteBodyFont, setNoteBodyFont] = useState<NoteBodyFont>(readNoteBodyFont);
  const [splitAt, setSplitAt] = useState(52);
  const panesRef = useRef<HTMLDivElement>(null);
  const [root, setRootState] = useState('');
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [directory, setDirectory] = useState<DirectoryListing | null>(null);
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const secondInsertExcerpt = useRef<(block: string) => boolean>(() => false);
  const primaryInsertExcerpt = useRef<(block: string) => boolean>(() => false);
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState<ReaderAnchor | null>(null);
  const [closing, setClosing] = useState(false);
  const [scrollMemory, setScrollMemory] = useState<MarkdownScrollMemory[]>([]);
  const [findCommand, setFindCommand] = useState<FindCommand | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenu | null>(null);
  const [trashCandidate, setTrashCandidate] = useState<WorkspaceDirectoryEntry | null>(null);
  const [inlineEntryEdit, setInlineEntryEdit] = useState<InlineEntryEdit | null>(null);
  const findCommandSequence = useRef(0);
  // Shared layout intent only; NoteWorkspace owns independent per-group opens.
  const openSequence = useRef(0);
  const directoryRequest = useRef(new LatestRequest()), searchRequest = useRef(new LatestRequest());
  const setRoot = useCallback((value: string) => { directoryRequest.current.invalidate(); searchRequest.current.invalidate(); setRootState(value); }, []);
  const setQuery = useCallback((value: string) => { searchRequest.current.invalidate(); setQueryState(value); setResults([]); }, []);
  const sessionWriter = useRef(new SessionWriter());
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const fileMenuTrigger = useRef<HTMLElement | null>(null);
  useOverlayFocus(settingsOpen, settingsPanelRef, { kind: 'popover', onDismiss: () => setSettingsOpen(false),
    returnFocus: () => settingsRef.current?.querySelector('button') || null });
  const inlineEntryInputRef = useRef<HTMLInputElement>(null);
  const newNoteGroup = useRef<NoteGroupId>('primary');
  const mutationBarrier = useRef(new MutationBarrier());
  const workspaceRef = useRef<NoteWorkspace | null>(null);
  if (!workspaceRef.current) workspaceRef.current = new NoteWorkspace(reader, mutationBarrier.current, setMessage);
  const workspace = workspaceRef.current;
  const workspaceVersion = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const readerSessionRef = useRef<ReaderSession | null>(null);
  if (!readerSessionRef.current) readerSessionRef.current = new ReaderSession({
    openPdf: path => reader().openPdf(path), openEpub: path => reader().openEpub(path),
    savePdfMeta: input => reader().savePdfMeta(input), saveEpubMeta: input => reader().saveEpubMeta(input),
  }, setMessage);
  const readerSession = readerSessionRef.current;
  const readerSnapshot = useSyncExternalStore(readerSession.subscribe, readerSession.getSnapshot);
  const activePdf = readerSnapshot.pdf, activeEpub = readerSnapshot.epub;
  const page = readerSnapshot.page, scale = readerSnapshot.scale;
  const activeDoc = workspace.currentDocument();
  const epubVisible = !!activeEpub && layout !== 'note';

  const secondNote = workspace.currentDocument('secondary')?.note || null;
  const noteRef = { current: activeDoc?.note || null };
  const activeNotePane = workspace.activeGroup;
  const setActiveNotePane = (pane: NoteGroupId) => workspace.activate(pane);
  const conflictDoc = [workspace.blockingDocument, activeDoc, ...[...workspace.documents.values()].filter(doc => doc.recoveryConflict)].find(doc => doc?.conflict || doc?.recoveryConflict) || null;
  const modalConflict = conflictDoc?.recoveryConflict?.note || conflictDoc?.conflict;
  useEffect(() => { if (modalConflict || workspace.pendingClose) setTrashCandidate(null); }, [modalConflict, workspace.pendingClose]);
  const openEntryRef = useRef<(file: WorkspaceFile, options?: { replaceCurrentNote?: boolean; skipUnsavedPrompt?: boolean; group?: NoteGroupId; pinned?: boolean; recoveryId?: string }) => Promise<void>>(async () => {});
  useEffect(() => {
    workspace.ready = sessionReady;
    const timer = window.setInterval(() => workspace.tick(), 250);
    return () => window.clearInterval(timer);
  }, [workspace, sessionReady]);

  // A successful rename/delete leaves a short-lived barrier so delayed work
  // for the old document cannot recreate it. Once a path is explicitly
  // opened again, it belongs to a new document instance and the old barrier
  // must no longer apply.
  function releaseMutationBarrier(path: string) { mutationBarrier.current.release(path); }

  useEffect(() => {
    window.localStorage.setItem('zhaoye-reading-size', String(readingSize));
  }, [readingSize]);

  useEffect(() => {
    try { window.localStorage.setItem('zhaoye-note-font', noteBodyFont); }
    catch { setMessage('正文字体已更改，但无法保存；下次启动时可能恢复原设置。'); }
  }, [noteBodyFont]);

  useEffect(() => {
    if (themePreference !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [themePreference]);
  const resolvedTheme = resolveTheme(themePreference, systemDark);

  useLayoutEffect(() => { applyTheme(resolvedTheme); }, [resolvedTheme]);

  useEffect(() => {
    try { window.localStorage.setItem('zhaoye-theme', themePreference); }
    catch { setMessage('主题已更改，但无法保存；下次启动时可能恢复原设置。'); }
  }, [themePreference]);

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
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.note-pane[data-pane-id], [data-note-controls], [data-tabs-group]') : null;
      const pane = target?.dataset.paneId || target?.dataset.noteControls || target?.dataset.tabsGroup;
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

  const sessionSnapshot = useCallback((): ReaderSessionV3 => ({
    version: 3,
    root: root || null,
    currentDirectory: directory?.directory || null,
    layout,
    sidebar,
    splitAt,
    ...workspace.sessionFields(),
    ...readerSession.sessionFields(),
    scrollMemory,
  }), [root, directory, layout, sidebar, splitAt, workspaceVersion, readerSnapshot, scrollMemory]);

  const rememberScroll = useCallback((entry: MarkdownScrollMemory) => {
    setScrollMemory(current => upsertScrollMemory(current, entry));
  }, []);

  const saveSessionNow = useCallback(async (force = false) => {
    try { await sessionWriter.current.write(sessionSnapshot(), snapshot => reader().saveSession(snapshot), force); return true; }
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
        const launchRecovery = launch.files[0]?.type === 'md' && settings.session?.version === 3
          ? settings.session.noteDocuments.find(item => documentKey(item.path) === documentKey(launch.files[0].path))
          : [settings.session?.primaryNote, settings.session?.secondaryNote].find(item => item?.path === launch.files[0]?.path);
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
          // One initial request only: a second automatic open could override
          // a sidebar choice made while the first recovery check was pending.
          const opening = openSequence.current + 1;
          await openEntry(launch.files[0], { replaceCurrentNote: !!launch.root, recoveryId: launchRecovery?.recoveryId });
          if (!launch.root) {
            for (const file of launch.files.slice(1).filter(file => file.type === 'md')) {
              if (openSequence.current !== opening) break;
              await workspace.open(file.path, 'primary', true);
            }
            if (openSequence.current === opening && launch.files[0].type === 'md') {
              const first = workspace.groups.primary.tabs.find(tab => tab.document?.note.path === launch.files[0].path);
              if (first) workspace.activate('primary', first.id);
            }
          }
        } else if (session) {
          setSidebar(session.sidebar); setSplitAt(session.splitAt);
          setScrollMemory(session.version !== 1 ? session.scrollMemory : []);
          const restoring = openSequence.current;
          await workspace.restore(session);
          if (!savedRoot && settings.recentFiles?.length) setFiles(settings.recentFiles.map(fromPath));
          if (openSequence.current === restoring && session.activePdf) {
            try {
              const result = await readerSession.open(session.activePdf.path, 'pdf', { name: fromPath(session.activePdf.path).name, page: session.activePdf.page, scale: session.activePdf.scale });
              if (result.status === 'save-failed') warn('上次阅读状态尚未保存，已保留当前会话');
            } catch { warn(`上次 PDF 不可用，已跳过：${fromPath(session.activePdf.path).name}`); }
          } else if (openSequence.current === restoring && session.activeEpub) {
            try {
              const result = await readerSession.open(session.activeEpub, 'epub', { name: fromPath(session.activeEpub).name });
              if (result.status === 'opened' && result.warnings?.length) warn(result.warnings.join('；'));
            } catch { warn(`上次 EPUB 不可用，已跳过：${fromPath(session.activeEpub).name}`); }
          }
          if (openSequence.current === restoring) { setLayout(session.layout); setActiveSurface(session.layout === 'read' ? 'reader' : 'note'); }
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
    const release = workspace.beginCommit(); if (!release) return;
    setClosing(true);
    let confirmed = false;
    try {
      if (!(await workspace.saveAll())) return;
      if (!(await readerSession.flush())) { setMessage('阅读进度或标注尚未保存成功，请重试后关闭。'); return; }
      if (!(await saveSessionNow(true))) return;
      // Keep input frozen through the actual OS close, not just until saves return.
      reader().confirmClose(); confirmed = true;
    } catch (error) { setMessage(`关闭前保存失败，内容仍保留：${String(error)}`); }
    finally { if (!confirmed) { release(); setClosing(false); } }
  }, [workspace, readerSession, saveSessionNow]);
  useEffect(() => reader().onAppClosing(finishClosing), [finishClosing]);

  async function openEntry(file: WorkspaceFile, options: { replaceCurrentNote?: boolean; skipUnsavedPrompt?: boolean; group?: NoteGroupId; pinned?: boolean; recoveryId?: string } = {}) {
    if (workspace.committing) return;
    const group = options.group || workspace.activeGroup;
    const request = ++openSequence.current;
    if (file.type === 'md') {
      try {
        const tab = await workspace.open(file.path, group, options.pinned ?? !options.replaceCurrentNote, options.recoveryId, async () => {
          if (!(await readerSession.flush())) { setMessage('阅读进度或标注尚未保存成功，请重试后切换。'); return false; }
          releaseMutationBarrier(file.path); return true;
        });
        if (tab && request === openSequence.current) { setLayout('note'); setActiveSurface('note'); }
      }
      catch (error) { setMessage(`无法打开：${String(error)}`); }
      return;
    }
    try {
      if (request !== openSequence.current) return;
      const result = await readerSession.open(file.path, file.type, { name: file.name });
      if (request !== openSequence.current || result.status === 'superseded') return;
      if (result.status === 'save-failed') { setMessage('阅读进度或标注尚未保存成功，请重试后切换。'); return; }
      if (result.status === 'opened' && result.warnings?.length) setMessage(result.warnings.join('；'));
      setLayout(workspace.currentDocument() ? 'split' : 'read');
      setActiveSurface('reader');
    } catch (error) { setMessage(`无法打开：${String(error)}`); }
  }
  openEntryRef.current = openEntry;
  async function closeEpub() {
    const epub = readerSession.currentEpub();
    if (!epub || readerCloseFlight.current || workspace.committing) return;
    readerCloseFlight.current = true; setReaderClosing(true);
    const request = ++openSequence.current;
    try {
      if (!(await readerSession.close(epub))) {
        if (request === openSequence.current) setMessage('阅读进度或标注尚未保存成功，资料仍保留，请重试关闭。');
        return;
      }
      if (request === openSequence.current) { setTarget(null); setLayout('note'); setActiveSurface('note'); }
    } catch (error) { setMessage(`关闭资料前保存失败，资料仍保留：${String(error)}`); }
    finally { readerCloseFlight.current = false; setReaderClosing(false); }
  }
  async function changeLayout(next: Layout) {
    if (next === layout) return;
    const request = ++openSequence.current;
    if (next === 'note' && !(await readerSession.flush())) {
      setMessage('阅读进度或标注尚未保存成功，请重试后切换。');
      return;
    }
    if (request === openSequence.current) { setLayout(next); setActiveSurface(next === 'read' ? 'reader' : 'note'); }
  }
  async function openWorkspace() {
    const selected = await reader().chooseWorkspace();
    if (selected) { setRoot(selected.path); setFiles(selected.files); setResults([]); setQuery(''); await loadDirectory(selected.path, selected.path); }
  }
  function beginInline(kind: 'note' | 'folder', parentPath = directory?.directory || root) {
    if (kind === 'note') newNoteGroup.current = workspace.activeGroup;
    if (!parentPath) { setMessage('请先打开资料文件夹'); return; }
    setSidebar(true); setFileContextMenu(null); setInlineEntryEdit({ kind, parentPath, value: kind === 'note' ? '新笔记.md' : '新建文件夹' });
  }
  function beginRename(entry: WorkspaceDirectoryEntry) {
    setFileContextMenu(null); setInlineEntryEdit({ kind: 'rename', entry, parentPath: pathDir(entry.path), value: entry.kind === 'file' ? entry.name.replace(/\.(md|markdown|pdf|epub)$/i, '') : entry.name });
  }
  async function commitInline() {
    const edit = inlineEntryEdit; if (!edit || edit.busy) return;
    const targetGroup = newNoteGroup.current;
    const parentPath = edit.parentPath || directory?.directory || root; if (!parentPath) return;
    const release = edit.kind === 'rename' ? workspace.beginCommit() : undefined;
    if (release === null) return;
    setInlineEntryEdit({ ...edit, busy: true, error: undefined });
    try {
      if (edit.kind === 'rename' && edit.entry) {
        const oldPath = edit.entry.path, startDirectory = directory?.directory || root;
        if (!(await workspace.saveAll())) { setInlineEntryEdit({ ...edit, busy: false }); return; }
        if (!(await readerSession.flush())) { setMessage('阅读进度或标注尚未保存成功，请重试后重命名。'); setInlineEntryEdit({ ...edit, busy: false }); return; }
        mutationBarrier.current.block(oldPath);
        const renamed = await reader().renameEntry({ path: edit.entry.path, name: edit.value });
        const newPath = renamed.path;
        const remap = (value: string) => remapDescendantPath(value, oldPath, newPath);
        workspace.remap(oldPath, newPath);
        readerSession.remapPath(oldPath, newPath);
        setFiles(items => items.map(item => ({ ...item, path: remap(item.path), name: remap(item.path).split(/[\\/]/).pop() || item.name })));
        if (directory && sameOrDescendantPath(directory.directory, oldPath)) setDirectory(value => value ? { ...value, directory: remap(value.directory), parent: value.parent ? remap(value.parent) : null, breadcrumbs: value.breadcrumbs.map(item => ({ ...item, path: remap(item.path) })) } : value);
        setScrollMemory(items => items.map(item => sameOrDescendantPath(item.path, oldPath) ? { ...item, path: remap(item.path) } : item));
        setInlineEntryEdit(null); try { await loadDirectory(root, sameOrDescendantPath(startDirectory, oldPath) ? remap(startDirectory) : startDirectory); } catch (error) { setMessage(`刷新目录失败：${error instanceof Error ? error.message : String(error)}`); }
      } else if (edit.kind === 'note') {
        const loaded = await reader().createNoteAt({ directory: parentPath, name: edit.value, initialContent: '# 新笔记\n\n' });
        setInlineEntryEdit(null); await loadDirectory(root, parentPath); await openEntry({ path: loaded.path, name: loaded.path.split(/[\\/]/).pop() || edit.value, relative: loaded.path, type: 'md' }, { group: targetGroup });
      } else {
        await reader().createFolderAt({ directory: parentPath, name: edit.value }); setInlineEntryEdit(null); await loadDirectory(root, parentPath);
      }
    } catch (error) { if (edit.entry) releaseMutationBarrier(edit.entry.path); setInlineEntryEdit({ ...edit, busy: false, error: error instanceof Error ? error.message : String(error) }); }
    finally { release?.(); }
  }
  function pathDir(value: string) { return value.replace(/[\\/][^\\/]*$/, '') || value; }
  async function deleteEntry(entry: WorkspaceDirectoryEntry) {
    const release = workspace.beginCommit(); if (!release) return false;
    const oldPath = entry.path, startDirectory = directory?.directory || root;
    try {
      if (!(await workspace.saveAll())) return false;
      if (!(await readerSession.flush())) { setMessage('阅读进度或标注尚未保存成功，请重试后移入回收站。'); return false; }
      mutationBarrier.current.block(oldPath);
      await reader().trashEntry(oldPath); const affected = (value: string) => sameOrDescendantPath(value, oldPath); workspace.forget(oldPath); readerSession.forgetPath(oldPath); setFiles(items => items.filter(item => !affected(item.path))); setScrollMemory(items => items.filter(item => !affected(item.path))); try { await loadDirectory(root, startDirectory); } catch (error) { setMessage(`刷新目录失败：${error instanceof Error ? error.message : String(error)}`); }
      return true;
    }
    catch (error) { releaseMutationBarrier(oldPath); setMessage(`删除失败：${error instanceof Error ? error.message : String(error)}`); return false; }
    finally { release(); /* retain successful tombstone; remove only on backend failure */ }
  }
  async function openFiles(group = workspace.activeGroup) {
    const selected = await reader().chooseFiles();
    if (!selected.length) return;
    setFiles(previous => [...selected, ...previous.filter(old => !selected.some(item => item.path === old.path))]);
    for (const file of selected.filter(file => file.type === 'md')) await workspace.open(file.path, group, true);
    await openEntry(selected[0], { group });
  }
  async function openBrowserEntry(entry: WorkspaceDirectoryEntry, pinned = false) {
    if (entry.kind === 'folder') {
      try { await loadDirectory(root, entry.path); setResults([]); } catch (error) { setMessage(`无法打开文件夹：${String(error)}`); }
      return;
    }
    await openEntry(entry, { replaceCurrentNote: !pinned, pinned });
  }
  async function openNoteInSecondary(file: WorkspaceFile) {
    if (file.type !== 'md') return;
    const request = ++openSequence.current;
    const alongsideReader = !!(activePdf || activeEpub) && layout !== 'note';
    const group = alongsideReader ? workspace.activeGroup : 'secondary';
    try { releaseMutationBarrier(file.path); const tab = await workspace.open(file.path, group, true); if (tab && request === openSequence.current) setLayout(alongsideReader ? 'split' : 'note'); }
    catch (error) { setMessage(`无法在右栏打开：${String(error)}`); }
  }
  async function runSearch() {
    const current = searchRequest.current.begin();
    if (!root || !query.trim()) { setResults([]); return; }
    try { const results = await reader().search({ root, query }); if (current()) setResults(results); }
    catch (error) { if (current()) setMessage(`搜索失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  async function persistPdfChange(active: ActivePdf, change: (current: PdfMeta) => PdfMeta) {
    return readerSession.updatePdf(change, active);
  }
  function excerptTarget() {
    const target = workspace.captureExcerptTarget();
    if (!target) { setMessage('请先打开笔记并处理保存或恢复冲突。'); return null; }
    const insertRef = target.group === 'primary' ? primaryInsertExcerpt : secondInsertExcerpt;
    return { ...target, insert: (block: string) => target.valid() && insertRef.current(block) };
  }
  const onPdfTextAction: PdfTextActionHandler = async (selection, action) => {
    const pdf = readerSession.currentPdf();
    const current = () => !!pdf && readerSession.isCurrentPdf(pdf) && pdf.data === selection.documentKey && pdf.meta.id === selection.pdfId && pdf.path === selection.path;
    if (!current() || !pdf) return { done: false, saved: false, inserted: false, error: 'PDF 已切换，未处理过期选区。' };
    const target = action === 'highlight' ? null : excerptTarget();
    if (action !== 'highlight' && !target) return { done: false, saved: false, inserted: false, error: '请先打开可写入的笔记。' };
    return createPdfTextAction(selection, action, {
      sourceCurrent: current, targetCurrent: () => !!target?.valid(),
      save: annotations => persistPdfChange(pdf, meta => ({ ...meta, page, annotations: [...meta.annotations, ...annotations.filter(item => !meta.annotations.some(old => old.id === item.id))] })),
      insert: async parts => {
        if (!target || !target.valid() || !current()) return false;
        const source = await reader().makeAnchorPath({ fromFile: target.path, toFile: pdf.path });
        if (!target.valid() || !current()) return false;
        const block = parts.map(part => {
          const anchor: PdfAnchor = { pdfId: pdf.meta.id, page: part.page, rotation: part.rotation, rects: part.rects, quote: part.quote, source };
          const link = `#reader-anchor-${encodeReaderAnchor(anchor)}`;
          return `> ${part.quote.replace(/\n/g, '\n> ')}\n\n> 来源：《${pdf.name}》 · 第 ${part.page} 页 · [回到原文](${link})`;
        }).join('\n\n');
        if (!target.insert(`\n\n${block}\n`)) return false;
        workspace.pin(target.tab!); workspace.activate(target.group); setLayout('split');
        return true;
      },
    })();
  };
  const epubExcerptFailure = (failure: ExcerptFlowFailure, error?: unknown, saved = false) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (failure === 'source-changed') return saved ? 'EPUB 标注已保存，但来源已切换；请返回原书后重试摘录。' : 'EPUB 已切换，未处理过期摘录。';
    if (failure === 'target-changed') return saved ? 'EPUB 标注已保存，但目标笔记已切换；请返回原笔记后重试摘录。' : '目标笔记已切换或暂不可写入，未插入摘录。';
    if (failure === 'save-failed') return 'EPUB 标注保存失败，请重试。';
    if (failure === 'insert-failed') return saved ? 'EPUB 标注已保存，摘录未插入；可以仅重试摘录。' : 'EPUB 摘录未插入，请重试。';
    return `${saved ? 'EPUB 标注已保存，摘录未完成：' : failure === 'save-error' ? 'EPUB 标注保存失败：' : 'EPUB 摘录插入失败：'}${detail}`;
  };
  function createEpubExcerptFlow(anchor: EpubAnchor, quote: string, comment: string, save?: (book: ActiveEpub) => Promise<boolean>) {
    const book = readerSession.currentEpub();
    const sourceCurrent = () => !!book && readerSession.isCurrentEpub(book) && book.meta.id === anchor.epubId;
    const target = excerptTarget();
    const insert = async () => {
      if (!book || !target || !sourceCurrent() || !target.valid()) return false;
      const source = await reader().makeAnchorPath({ fromFile: target.path, toFile: book.path });
      if (!sourceCurrent() || !target.valid()) return false;
      const link = `#reader-anchor-${encodeReaderAnchor({ ...anchor, source })}`;
      const quotation = quote ? `> ${quote.replace(/\n+/g, '\n> ')}\n\n` : '';
      const commentLine = comment.trim() ? `> 批注：${comment.trim().replace(/\n+/g, ' ')}\n\n` : '';
      const block = `\n\n${quotation}${commentLine}> 来源：《${formatEpubAnchor(anchor, book.name)}》 · [回到原文](${link})\n`;
      if (!target.insert(block)) return false;
      workspace.pin(target.tab!); workspace.activate(target.group); setLayout('split');
      return true;
    };
    return createExcerptFlow({
      sourceCurrent,
      targetCurrent: () => !!target?.valid(),
      save: save && book ? () => save(book) : undefined,
      insert,
      message: epubExcerptFailure,
    });
  }
  async function saveEpubSelection(annotation: EpubAnnotation, excerpt: boolean): Promise<ExcerptFlowResult> {
    const book = readerSession.currentEpub();
    const anchor: EpubAnchor = { epubId: book?.meta.id || '', cfiRange: annotation.cfiRange,
      quote: annotation.quote, annotationId: annotation.id, chapterHref: annotation.chapterHref, chapterLabel: annotation.chapterLabel };
    const persistAnnotation = (source: ActiveEpub) => readerSession.updateEpub(current => current.annotations.some(item => item.id === annotation.id)
      ? current : { ...current, annotations: [...current.annotations, annotation] }, source);
    const run = excerpt
      ? createEpubExcerptFlow(anchor, annotation.quote, annotation.comment || '', persistAnnotation)
      : createExcerptFlow({
        sourceCurrent: () => !!book && readerSession.isCurrentEpub(book),
        save: () => book ? persistAnnotation(book) : Promise.resolve(false),
        message: epubExcerptFailure,
      });
    return run();
  }
  function capturePdfExcerpt(expected: ActivePdf): PdfExcerptContext | null {
    const pdf = readerSession.currentPdf();
    if (!pdf || !readerSession.isCurrentPdf(expected)) return null;
    const target = workspace.currentDocument() ? excerptTarget() : null;
    if (workspace.currentDocument() && !target) return null;
    const sourceCurrent = () => readerSession.isCurrentPdf(pdf);
    return { sourcePath: pdf.path, sourceCurrent, target: target ? {
      path: target.path, valid: target.valid,
      insert: async (asset, anchor, quote) => {
        if (!sourceCurrent() || !target.valid() || anchor.pdfId !== pdf.meta.id) return false;
        const source = await reader().makeAnchorPath({ fromFile: target.path, toFile: pdf.path });
        if (!sourceCurrent() || !target.valid()) return false;
        const link = `#reader-anchor-${encodeReaderAnchor({ ...anchor, source })}`;
        const image = asset ? `![PDF 第 ${anchor.page} 页摘录](${asset})\n\n` : '';
        const quotation = quote ? `> ${quote.replace(/\n+/g, '\n> ')}\n\n` : '';
        if (!target.insert(`\n\n${image}${quotation}> 来源：《${pdf.name}》 · 第 ${anchor.page} 页 · [回到原文](${link})\n`)) return false;
        workspace.pin(target.tab); workspace.activate(target.group); setLayout('split');
        return true;
      },
    } : null };
  }
  async function insertEpubExcerpt(anchor: EpubAnchor, quote: string, comment: string): Promise<ExcerptFlowResult> {
    const run = createEpubExcerptFlow(anchor, quote, comment);
    return run();
  }
  async function jumpTo(anchor: ReaderAnchor, fromNotePath = noteRef.current?.path) {
    const request = ++openSequence.current;
    const isCurrentRequest = () => request === openSequence.current;
    try {
      if (isEpubAnchor(anchor)) {
        let epub = readerSession.currentEpub();
        if (!epub || epub.meta.id !== anchor.epubId) {
          let path = anchor.source && fromNotePath ? await reader().resolveAnchorPath({ fromFile: fromNotePath, storedPath: anchor.source, epubId: anchor.epubId }) : null;
          if (!isCurrentRequest()) return;
          if (!path) path = await reader().chooseEpubRelocation({ epubId: anchor.epubId });
          if (!path) { setMessage('没有找到原 EPUB。请选择内容相同的电子书重新定位。'); return; }
          if (!isCurrentRequest()) return;
          const result = await readerSession.open(path, 'epub', { expectedId: anchor.epubId });
          if (!isCurrentRequest() || result.status === 'superseded') return;
          if (result.status === 'save-failed') { setMessage('阅读进度或标注尚未保存成功，请重试后跳转。'); return; }
          if (result.status === 'identity-mismatch') { setMessage('所选 EPUB 与摘录时的文件内容不同，未跳转。'); return; }
          if (result.status === 'opened' && result.warnings?.length) setMessage(result.warnings.join('；'));
          epub = readerSession.currentEpub();
        }
        if (!isCurrentRequest()) return;
        setTarget(anchor); setLayout(noteRef.current || secondNote ? 'split' : 'read'); setActiveSurface('reader');
        window.setTimeout(() => setTarget(current => current === anchor ? null : current), 8000);
        return;
      }
      const pdfAnchor = anchor as PdfAnchor;
      let pdf = activePdf;
      if (!pdf || pdf.meta.id !== pdfAnchor.pdfId) {
        let path = pdfAnchor.source && fromNotePath ? await reader().resolveAnchorPath({ fromFile: fromNotePath, storedPath: pdfAnchor.source, pdfId: pdfAnchor.pdfId }) : null;
        if (!isCurrentRequest()) return;
        if (!path) path = await reader().chooseRelocation({ pdfId: pdfAnchor.pdfId });
        if (!path) { setMessage('没有找到原 PDF。请选择内容相同的文件重新定位。'); return; }
        if (!isCurrentRequest()) return;
        const result = await readerSession.open(path, 'pdf', { expectedId: pdfAnchor.pdfId, page: pdfAnchor.page });
        if (!isCurrentRequest() || result.status === 'superseded') return;
        if (result.status === 'save-failed') { setMessage('阅读进度或标注尚未保存成功，请重试后跳转。'); return; }
        if (result.status === 'identity-mismatch') { setMessage('所选 PDF 与摘录时的文件内容不同，未跳转。'); return; }
        pdf = readerSession.currentPdf();
      }
      if (!isCurrentRequest()) return;
      readerSession.setPage(pdfAnchor.page); setTarget(pdfAnchor); setLayout('split');
      window.setTimeout(() => setTarget(current => current === pdfAnchor ? null : current), 8000);
    } catch (error) { setMessage(`无法回到原文：${error instanceof Error ? error.message : String(error)}`); }
  }
  async function resolveConflict(choice: 'mine' | 'disk' | 'copy') {
    const doc = conflictDoc; if (!doc) return;
    try {
      const okay = choice === 'mine' ? await doc.keepMine() : choice === 'disk' ? (await doc.useDisk(), true) : await workspace.saveAs(doc);
      if (okay) { workspace.blockingDocument = null; if (workspace.pendingClose) await workspace.finishPendingClose(); if (closing) await finishClosing(); workspace.notify(); }
      else { workspace.blockingDocument = doc; workspace.notify(); }
    } catch (error) { setMessage(`处理冲突失败：${String(error)}`); }
  }
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (workspace.committing) return;
      if (event.isComposing || event.keyCode === 229 || !event.ctrlKey || event.altKey || event.metaKey || document.querySelector('[role="dialog"]') || settingsOpen) return;
      if (layout === 'read') return;
      if (activeSurface === 'reader' && activeEpub && layout === 'split') {
        if (event.key.toLowerCase() === 'w' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void closeEpub(); }
        return;
      }
      if (event.key.toLowerCase() === 's' && !event.shiftKey && !event.defaultPrevented && (event.target as Element)?.closest?.('.note-workspace-bar')) {
        const doc = workspace.currentDocument(); if (doc) { event.preventDefault(); void doc.save(); }
      }
      if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); workspace.cycle(workspace.activeGroup, event.shiftKey ? -1 : 1); }
      if (event.key.toLowerCase() === 'w' && !event.shiftKey) { const tab = workspace.current(); if (tab) { event.preventDefault(); event.stopPropagation(); void workspace.close(workspace.activeGroup, tab); } }
    };
    window.addEventListener('keydown', keys, true); return () => window.removeEventListener('keydown', keys, true);
  }, [workspace, layout, settingsOpen, activeSurface, activeEpub]);

  const visibleRecent = useMemo(() => query ? files.filter(file => file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : files, [files, query]);
  const visibleDirectory = useMemo(() => {
    const entries = directory?.entries || [];
    return query ? entries.filter(entry => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : entries;
  }, [directory, query]);
  const showContext = (event: React.MouseEvent, entry: WorkspaceDirectoryEntry) => {
    event.preventDefault(); event.stopPropagation(); fileMenuTrigger.current = event.currentTarget as HTMLElement;
    const box = event.currentTarget.getBoundingClientRect();
    setFileContextMenu({ entry, x: event.clientX || box.left, y: event.clientY || box.bottom });
  };
  return <ReducedMotionContext.Provider value={motionReduced}><div className="app" inert={!sessionReady || workspace.committing} aria-busy={!sessionReady || workspace.committing} data-session-ready={sessionReady} data-motion={motionReduced ? 'reduced' : 'full'} data-theme={resolvedTheme} data-fullscreen={windowState.fullscreen} data-layout={layout} style={{ '--reading-size': `${readingSize}px`, '--note-body-font': NOTE_BODY_FONTS[noteBodyFont], '--note-source-font': NOTE_BODY_FONTS[noteBodyFont] } as React.CSSProperties}>
    {windowState.fullscreen && <div className="fullscreen-reveal-edge" aria-hidden="true"/>}
    <header className="topbar">
      <button className="icon-button sidebar-toggle" aria-label={sidebar ? '收起资料栏' : '展开资料栏'} title={sidebar ? '收起资料栏' : '展开资料栏'} onClick={() => setSidebar(value => !value)}>{sidebar ? <PanelLeftClose size={18}/> : <PanelLeftOpen size={18}/>}</button>
      <nav className="layout-tabs" aria-label="工作模式">{([['read', '阅读'], ['note', '笔记'], ['split', '对照']] as const).map(([id, label]) => <button aria-pressed={layout === id} className={layout === id ? 'active' : ''} onClick={() => void changeLayout(id)} key={id}>{label}</button>)}</nav>
      <div className="top-actions">
        <button className="quiet-action" title={sidebar ? '收起资料栏' : '展开资料栏'} onClick={() => setSidebar(value => !value)}>{sidebar ? <PanelLeftClose size={17}/> : <PanelLeftOpen size={17}/>}<span className="action-label">资料栏</span></button>
        <div className="settings-menu" ref={settingsRef}>
          <button className="quiet-action" aria-expanded={settingsOpen} aria-haspopup="dialog" title="设置" onClick={() => setSettingsOpen(value => !value)}><Settings2 size={17}/><span className="action-label">设置</span></button>
          {settingsOpen && <div ref={settingsPanelRef} className="settings-popover" role="dialog" aria-label="阅读设置" tabIndex={-1}>
            <div className="settings-heading"><div><b>正文大小</b></div><strong>{readingSize}px</strong></div>
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
                <option value="fangsong">字体管家仿宋</option>
                <option value="songti">宋体</option>
                <option value="hanyi-shufang-55w">汉仪书仿55W</option>
              </select>
            </label>
            <div className="settings-section">
              <span className="settings-section-title">外观</span>
              <div className="theme-options" role="group" aria-label="外观主题">
                {([
                  ['constructivist-paper', '纸页红', <Sun size={15}/>],
                  ['constructivist', '浅色', <Sun size={15}/>],
                  ['constructivist-dark', '深色', <Moon size={15}/>],
                  ['system', '跟随系统', <Monitor size={15}/>],
                ] as const).map(([value, label, icon]) => <button key={value} className={themePreference === value ? 'active' : ''} aria-pressed={themePreference === value} onClick={() => setThemePreference(value)}>{icon}<span>{label}</span></button>)}
              </div>
              <label className="motion-preference"><input type="checkbox" checked={motionReduced} disabled={systemReduced} onChange={event => setReduceMotion(event.target.checked)}/><span>减少动效</span>{systemReduced && <small>系统已启用</small>}</label>
            </div>
            <div className="settings-section">
              <button className="settings-row" title="F11 切换全屏；全屏时移到顶边显示工具栏，F6 聚焦工具栏" onClick={() => { setSettingsOpen(false); void reader().windowControl('fullscreen'); }}>{windowState.fullscreen ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}<span>全屏阅读</span><small>{windowState.fullscreen ? '退出' : '进入'} · F11</small></button>
            </div>
          </div>}
        </div>
        <button className="quiet-action" aria-label="打开文件" title="打开文件" onClick={() => void openFiles()}><FolderOpen size={17}/><span className="action-label">打开文件</span></button>
        <button className="quiet-action" aria-label="打开文件夹" title="打开文件夹" onClick={openWorkspace}><FolderTree size={17}/><span className="action-label">打开文件夹</span></button>
        <button className="quiet-action" aria-label="新建文件夹" title="新建文件夹" onClick={() => beginInline('folder')}><FolderPlus size={17}/><span className="action-label">新建文件夹</span></button>
        <button className="new-note-action" aria-label="新笔记" title="新建笔记" onClick={() => beginInline('note')}><Plus size={17}/><span>新笔记</span></button>
      </div>
      <div className="window-controls" aria-label="窗口控制">
        <button aria-label="最小化窗口" title="最小化" onClick={() => void reader().windowControl('minimize')}><Minus size={16}/></button>
        {windowState.fullscreen ? <button aria-label="退出全屏" title="退出全屏（F11）" onClick={() => void reader().windowControl('fullscreen')}><Minimize2 size={15}/></button> : <button aria-label={windowState.maximized ? '还原窗口' : '最大化窗口'} title={windowState.maximized ? '还原' : '最大化'} onClick={() => void reader().windowControl('maximize').then(setWindowState)}>{windowState.maximized ? <Copy size={13}/> : <Square size={13}/>}</button>}
        <button className="window-close" aria-label="关闭窗口" title="关闭" onClick={() => void reader().windowControl('close')}><X size={17}/></button>
      </div>
    </header>
    <div className={sidebarMotion.present ? 'body' : 'body sidebar-hidden'}>
      {sidebarMotion.present && <aside ref={sidebarMotion.ref} className="sidebar" aria-hidden={!sidebar}>
        <div className="search"><Search size={16}/><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === 'Enter' && void runSearch()} placeholder="搜索文件名或笔记内容" aria-label="搜索文件名或笔记内容"/>{query && <button aria-label="清空搜索" title="清空搜索" onClick={() => { setQuery(''); setResults([]); }}><X size={14}/></button>}</div>
        {root && directory && <div className="folder-navigation">
          <button className="folder-back" aria-label="返回上一级文件夹" title="返回上一级" disabled={!directory.parent} onClick={() => directory.parent && void loadDirectory(root, directory.parent)}><ArrowLeft size={16}/></button>
          <div className="folder-address" aria-label="当前文件夹地址" title={directory.directory}><FolderOpen size={14}/><div className="folder-crumbs">{directory.breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.path}>{index > 0 && <ChevronRight size={11} className="crumb-separator"/>}<button title={crumb.path} aria-current={index === directory.breadcrumbs.length - 1 ? 'location' : undefined} onClick={() => void loadDirectory(root, crumb.path)}>{crumb.name}</button></React.Fragment>)}</div></div>
        </div>}
        <div className={'section-title ' + (root ? 'after-address' : '')}><span>{root ? '当前文件夹' : '最近文件'}</span><span>{root ? visibleDirectory.length : visibleRecent.length}</span></div>
        <div className="file-list">{inlineEntryEdit && inlineEntryEdit.kind !== 'rename' && <div className="file-row inline-entry-row"><span className={inlineEntryEdit.kind === 'folder' ? 'folder-icon' : 'file-icon md'}>{inlineEntryEdit.kind === 'folder' ? <Folder size={17}/> : 'MD'}</span><input ref={inlineEntryInputRef} className="inline-entry-input" aria-label={inlineEntryEdit.kind === 'folder' ? '新文件夹名称' : '新笔记名称'} value={inlineEntryEdit.value} disabled={inlineEntryEdit.busy} onChange={event => setInlineEntryEdit(value => value && ({ ...value, value: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter') void commitInline(); if (event.key === 'Escape') setInlineEntryEdit(null); }} />{inlineEntryEdit.error && <small className="inline-entry-error">{inlineEntryEdit.error}</small>}</div>}{root ? visibleDirectory.map(entry => {
          const activePath = entry.kind === 'file' ? entry.type === 'pdf' ? activePdf?.path : entry.type === 'epub' ? activeEpub?.path : workspace.currentDocument()?.note.path : null;
          const renaming = inlineEntryEdit?.kind === 'rename' && inlineEntryEdit.entry?.path === entry.path;
          const body = renaming ? <><input ref={inlineEntryInputRef} className="inline-entry-input" aria-label={'重命名 ' + entry.name} value={inlineEntryEdit!.value} disabled={inlineEntryEdit!.busy} onChange={event => setInlineEntryEdit(value => value && ({ ...value, value: event.target.value }))} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') void commitInline(); if (event.key === 'Escape') setInlineEntryEdit(null); }} />{inlineEntryEdit?.error && <small className="inline-entry-error">{inlineEntryEdit.error}</small>}</> : <><span className={entry.kind === 'folder' ? 'folder-icon' : 'file-icon ' + entry.type}>{entry.kind === 'folder' ? <Folder size={17}/> : entry.type === 'pdf' ? 'PDF' : entry.type === 'epub' ? 'EPUB' : 'MD'}</span><span className="file-name">{entry.name}</span></>;
          return renaming ? <div className="file-row inline-entry-row" key={entry.path}>{body}</div> : <button title={entry.path} className={'file-row ' + (activePath === entry.path ? 'selected' : '')} key={entry.path} onContextMenu={event => showContext(event, entry)} onClick={event => void openBrowserEntry(entry, event.ctrlKey)} onDoubleClick={() => void openBrowserEntry(entry, true)}>{body}{entry.kind === 'folder' && <ChevronRight size={14} className="folder-enter"/>}</button>;
        }) : visibleRecent.map(file => { const activePath = file.type === 'pdf' ? activePdf?.path : file.type === 'epub' ? activeEpub?.path : workspace.currentDocument()?.note.path; return <button title={file.path} className={'file-row ' + (activePath === file.path ? 'selected' : '')} key={file.path} onContextMenu={event => showContext(event, { ...file, kind: 'file' })} onClick={event => void openEntry(file, { replaceCurrentNote: !event.ctrlKey })} onDoubleClick={() => void openEntry(file)}><span className={'file-icon ' + file.type}>{file.type === 'pdf' ? 'PDF' : file.type === 'epub' ? 'EPUB' : 'MD'}</span><span className="file-name">{file.name}</span></button>; })}{!(root ? visibleDirectory.length : visibleRecent.length) && <div className="empty-small"><FolderOpen size={20}/><span>{root ? '这个文件夹里没有可阅读的文件' : '打开文件夹后，资料会显示在这里'}</span></div>}</div>
        {!!results.length && <><div className="section-title">搜索结果</div>{results.map(result => <button className="result-row" key={result.path} onContextMenu={event => showContext(event, { ...result, kind: 'file' })} onClick={event => void openEntry(result, { replaceCurrentNote: !event.ctrlKey })} onDoubleClick={() => void openEntry(result)}><b>{result.name}</b><small>{result.snippet || '文件名匹配'}</small></button>)}</>}
      </aside>}
      <main className="main">
        <div className={'note-workspace-bar' + (epubVisible ? ' with-epub' : '') + (epubVisible && layout === 'split' ? ' reader-note-row' : '')} aria-label="资料标签与操作" style={{ ...(layout === 'read' && !epubVisible ? { display: 'none' } : {}), '--split-at': `${splitAt}%` } as React.CSSProperties}>
          <div className="reader-header-slot" ref={setReaderHeaderTarget} style={!epubVisible ? { display: 'none' } : undefined}/>
          <div className="note-header-slot" style={layout === 'read' ? { display: 'none' } : undefined}>
            <div className="document-tab-strip" ref={setNoteTabsTarget}/>
            <div className="note-controls-slot" ref={setNoteControlsTarget}/>
          </div>
        </div>
        <div ref={panesRef} className={'panes ' + layout + (layout === 'note' && workspace.groups.secondary.tabs.length ? ' dual-notes' : '')} style={{ '--split-at': `${splitAt}%` } as React.CSSProperties}>
          {(layout === 'read' || layout === 'split') && (activeEpub ? <EpubPane key={activeEpub.path} epub={activeEpub} theme={resolvedTheme} noteBodyFont={noteBodyFont} readingSize={readingSize} headerTarget={readerHeaderTarget} active={activeSurface === 'reader'} closing={readerClosing} onActivate={() => setActiveSurface('reader')} onClose={() => void closeEpub()} onMeta={change => readerSession.updateEpub(change, activeEpub)} onMessage={setMessage} onExcerpt={insertEpubExcerpt} onSelectionAction={saveEpubSelection} excerptTarget={activeDoc ? (workspace.activeGroup === 'secondary' ? '摘录到右栏' : '摘录到当前笔记') : null} target={isEpubAnchor(target) ? target : null}/> : <PdfPane dark={THEMES[resolvedTheme].colorScheme === 'dark'} pdf={activePdf} page={page} setPage={value => readerSession.setPage(value)} scale={scale} setScale={value => readerSession.setScale(value)} fullscreen={windowState.fullscreen} onToggleFullscreen={() => { void reader().windowControl('fullscreen'); }} onMeta={change => activePdf ? readerSession.updatePdf(change, activePdf) : Promise.resolve(false)} captureExcerpt={capturePdfExcerpt} onTextAction={onPdfTextAction} canExcerpt={!!activeDoc && !activeDoc.blocked()} target={target && 'pdfId' in target ? target : null} onMessage={setMessage}/>)}
          {layout === 'split' && <PaneSplitter key={'splitter:' + (activeEpub?.path || activePdf?.path || 'reader')} container={panesRef} ratio={splitAt} onChange={setSplitAt} deferred={!!activeEpub}/>}
          {(['primary', 'secondary'] as const).map(group => <NoteGroupPane key={group} workspace={workspace} group={group}
            tabsTarget={noteTabsTarget} controlsTarget={noteControlsTarget}
            foreground={!epubVisible || activeSurface === 'note'} onFocus={() => setActiveSurface('note')}
            hidden={layout === 'read' || (layout === 'split' ? workspace.activeGroup !== group : group === 'secondary' && !workspace.groups.secondary.tabs.length)}
            findCommand={findCommand?.pane === group ? findCommand : null} onJump={jumpTo}
            insertRegister={group === 'primary' ? primaryInsertExcerpt : secondInsertExcerpt}
            scrollMemory={scrollMemory} rememberScroll={rememberScroll} onOpen={() => void openFiles(group)}
            onNew={() => { workspace.activate(group); beginInline('note'); }}
            onRight={path => void openNoteInSecondary({ path, name: path.split(/[\\/]/).pop() || path, relative: path, type: 'md' })}
            onSplit={() => { const doc = workspace.currentDocument(group); if (doc) void openNoteInSecondary({ path: doc.note.path, name: '', relative: '', type: 'md' }); else workspace.blank('secondary'); }}/>)}
        </div>
      </main>
    </div>
    {fileContextMenu && <ContextMenu x={fileContextMenu.x} y={fileContextMenu.y} returnFocus={fileMenuTrigger.current} label="文件操作" onClose={() => setFileContextMenu(null)}><button role="menuitem" onClick={() => { setFileContextMenu(null); void reader().showItemInFolder(fileContextMenu.entry.path); }}>打开所在路径</button>{fileContextMenu.entry.kind === 'file' && fileContextMenu.entry.type === 'md' && <button role="menuitem" onClick={() => { const entry = fileContextMenu.entry as WorkspaceFile; setFileContextMenu(null); void openEntry(entry); }}>在新标签页中打开</button>}{fileContextMenu.entry.kind === 'file' && fileContextMenu.entry.type === 'md' && <button role="menuitem" onClick={() => { const entry = fileContextMenu.entry as WorkspaceFile; setFileContextMenu(null); void openNoteInSecondary(entry); }}>在右侧打开</button>}<button role="menuitem" onClick={() => beginRename(fileContextMenu.entry)}>重命名</button><button role="menuitem" className="menu-item-danger" onClick={() => { setTrashCandidate(fileContextMenu.entry); setFileContextMenu(null); }}>移到回收站</button></ContextMenu>}
    {trashCandidate && !modalConflict && !workspace.pendingClose && <TrashConfirmation name={trashCandidate.name} onCancel={() => setTrashCandidate(null)} onConfirm={async () => { const entry = trashCandidate; const okay = await deleteEntry(entry); if (okay) setTrashCandidate(null); return okay; }}/>}
    {message && <div className="toast"><span role="status">{message}</span><button aria-label="关闭提示" onClick={() => setMessage('')}><X size={16}/></button></div>}
    {workspace.pendingClose && !modalConflict && <UnsavedDialog description="关闭这份未能保存的笔记" onCancel={() => { workspace.pendingClose = null; workspace.blockingDocument = null; workspace.notify(); }}
      onDiscard={async () => { await workspace.finishPendingClose(true).catch(error => setMessage(String(error))); }}
      onSave={async () => { await workspace.finishPendingClose().catch(error => setMessage(String(error))); }}/>}
    {modalConflict && conflictDoc && <ConflictDialog conflict={{ ...modalConflict, conflict: true }} mine={conflictDoc.recoveryConflict?.recovery.content || conflictDoc.text}
      closing={closing} onMine={() => resolveConflict('mine')} onDisk={() => resolveConflict('disk')} onSaveAs={() => resolveConflict('copy')}/>}
  </div></ReducedMotionContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<App/>);
