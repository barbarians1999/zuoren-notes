import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowLeftRight, BookOpen, ChevronLeft, ChevronRight, Columns2, Copy, Crop, List, FileText, Folder, FolderOpen, FolderPlus, FolderTree, Highlighter, Maximize2, MessageSquare, Minimize2, Minus, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Square, Sun, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { EpubAnchor, EpubAnnotation, EpubMeta, MarkdownScrollMemory, NoteRead, PdfAnchor, PdfAnnotation, PdfMeta, PdfRect, ReaderAnchor, RecoveryCheckResult, RecoveryV1, SaveNoteResult, WorkspaceFile } from '../types';
import { reader, resolveLocal, NOTE_BODY_FONTS, EPUB_MIN_SPREAD_WIDTH, type ActivePdf, type ActiveEpub, type FlatNavItem, type OcrDialog, type NoteMode, type NoteBodyFont, type SaveLabel, type FindCommand } from '../readerContext';
import { isolateHistory, redo as cmRedo, undo as cmUndo } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { EditorView as CodeMirrorView } from '@codemirror/view';
import { MarkdownSourceEditor } from './MarkdownSourceEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { formatSourceSelection, formatSourceBlock, markdownOutline, type MarkdownInlineFormat, type MarkdownBlockFormat } from './markdownCommands';
import { findSourceMatches, readDomText, selectDomMatch, type DomTextMap } from './domFind';
import { findLiteralMatches, stepMatchIndex } from '../findReplace';
import { countMarkdownUnits, countTextUnits } from '../wordCount';
import { resolveScrollTop } from '../sessionState.cjs';
import { MarkdownWorkspaceHeader } from '../markdownWorkspace';
export function NotePane({ paneId, onActivate, findCommand, note, text, setText, mode, setMode, onSave, onJump, revision, label, caption, scrollMemory, onScrollMemory, excerptRegister, hidden }: { paneId: FindCommand['pane']; onActivate: (pane: FindCommand['pane']) => void; findCommand: FindCommand | null; note: NoteRead | null; text: string; setText: (text: string) => void; mode: NoteMode; setMode: (mode: NoteMode) => void; onSave: () => void; onJump: (anchor: ReaderAnchor, fromNotePath?: string) => void; revision: number; label?: string; caption?: React.ReactNode; scrollMemory: MarkdownScrollMemory[]; onScrollMemory: (entry: MarkdownScrollMemory) => void; excerptRegister?: React.MutableRefObject<(block: string) => boolean>; hidden?: boolean }) {
  const [outline, setOutline] = useState(false);
  const [headings, setHeadings] = useState<{ text: string; level: number; line?: number }[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [replacing, setReplacing] = useState(false);
  const [sourceView, setSourceView] = useState<CodeMirrorView | null>(null);
  const liveNotePath = useRef(note?.path); liveNotePath.current = note?.path;
  useEffect(() => {
    if (!excerptRegister) return;
    const append = (block: string) => {
      if (!sourceView || !note || liveNotePath.current !== note.path || sourceView.dom.parentElement?.getAttribute('data-note-path') !== note.path) return false;
      const doc = sourceView.state.doc.toString();
      const from = doc.trimEnd().length;
      sourceView.dispatch({
        changes: { from, to: doc.length, insert: block },
        selection: { anchor: from + block.length },
        annotations: [Transaction.userEvent.of('input.excerpt'), isolateHistory.of('full')],
      });
      return true;
    };
    excerptRegister.current = append;
    return () => { if (excerptRegister.current === append) excerptRegister.current = () => false; };
  }, [excerptRegister, note?.path, sourceView]);
  const [previewMap, setPreviewMap] = useState<DomTextMap>({ text: '', nodes: [] });
  const [selectedUnits, setSelectedUnits] = useState(0);
  const [paragraphUnits, setParagraphUnits] = useState(0);
  const [selectionToolbar, setSelectionToolbar] = useState<{ left: number; top: number } | null>(null);
  const [sourceSelection, setSourceSelection] = useState<{ from: number; to: number; left: number; top: number; width: number; height: number } | null>(null);
  const onJumpRef = useRef(onJump); onJumpRef.current = onJump;
  const scrollMemoryRef = useRef(scrollMemory); scrollMemoryRef.current = scrollMemory;
  const onScrollMemoryRef = useRef(onScrollMemory); onScrollMemoryRef.current = onScrollMemory;
  const stableJump = useCallback((anchor: ReaderAnchor) => onJumpRef.current(anchor, note?.path), [note?.path]);
  const host = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const lastPath = useRef(note?.path);
  const totalUnits = useMemo(() => note ? countMarkdownUnits(text) : 0, [note, text]);
  const matches = useMemo(() => mode === 'preview'
    ? findLiteralMatches(previewMap.text, findText, caseSensitive)
    : sourceView ? findSourceMatches(sourceView, findText, caseSensitive) : [],
  [mode, previewMap, findText, caseSensitive, sourceView, text]);
  const activeMatch = currentIndex >= 0 && currentIndex < matches.length ? matches[currentIndex] : null;
  useEffect(() => {
    if (lastPath.current === note?.path) return;
    lastPath.current = note?.path;
    setSourceSelection(null); setSelectionToolbar(null); setSelectedUnits(0);
    setFindOpen(false); setReplaceOpen(false); setFindText(''); setReplaceText(''); setCurrentIndex(-1);
  }, [note?.path]);
  useEffect(() => {
    const notePath = note?.path;
    if (!notePath) return;
    const memoryMode: MarkdownScrollMemory['mode'] = mode === 'preview' ? 'preview' : 'edit';
    let frame = 0;
    let attempts = 0;
    let scrollTimer = 0;
    let scroller: HTMLElement | null = null;
    const capture = () => {
      if (!scroller) return;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      onScrollMemoryRef.current({ pane: paneId, path: notePath, mode: memoryMode, scrollTop: scroller.scrollTop, ratio: maxScrollTop ? scroller.scrollTop / maxScrollTop : 0 });
    };
    const onScroll = () => {
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(capture, 140);
    };
    const attach = () => {
      scroller = host.current?.querySelector<HTMLElement>(memoryMode === 'preview' ? '.markdown-preview' : '.markdown-source-editor .cm-scroller') || null;
      if (!scroller) {
        if (++attempts < 180) frame = requestAnimationFrame(attach);
        return;
      }
      const saved = scrollMemoryRef.current.find(entry => entry.pane === paneId && entry.path === notePath && entry.mode === memoryMode);
      if (saved) scroller.scrollTop = resolveScrollTop(saved, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      scroller.addEventListener('scroll', onScroll, { passive: true });
    };
    frame = requestAnimationFrame(attach);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(scrollTimer);
      if (scroller) { scroller.removeEventListener('scroll', onScroll); capture(); }
    };
  }, [note?.path, mode, paneId, revision]);
  useEffect(() => {
    if (!findCommand || findCommand.pane !== paneId) return;
    setFindOpen(true); setReplaceOpen(findCommand.mode === 'replace');
    requestAnimationFrame(() => findInput.current?.focus());
  }, [findCommand?.sequence, findCommand?.pane, paneId]);
  useEffect(() => {
    if (!replaceOpen) return;
    const frame = requestAnimationFrame(() => replaceInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [replaceOpen]);
  useEffect(() => {
    if (findOpen) setCurrentIndex(matches.length ? 0 : -1);
  }, [findText, caseSensitive, note?.path, findOpen]);
  useEffect(() => {
    if (findOpen) setCurrentIndex(index => matches.length ? Math.max(0, Math.min(index, matches.length - 1)) : -1);
  }, [findOpen, matches.length]);
  useEffect(() => {
    if (mode !== 'preview' || !findOpen) { setPreviewMap({ text: '', nodes: [] }); return; }
    const root = host.current?.querySelector<HTMLElement>('.markdown-preview');
    if (!root) return;
    const update = () => setPreviewMap(readDomText(root));
    update();
    const observer = new MutationObserver(update); observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [mode, findOpen, note?.path, text, revision]);
  useEffect(() => {
    if (!findOpen || !activeMatch) return;
    if (mode === 'preview') {
      const root = host.current?.querySelector<HTMLElement>('.markdown-preview');
      if (root) selectDomMatch(root, previewMap, activeMatch);
      return;
    }
    if (sourceView) {
      if (activeMatch.to > sourceView.state.doc.length) return;
      sourceView.dispatch({ selection: { anchor: activeMatch.from, head: activeMatch.to }, effects: CodeMirrorView.scrollIntoView(activeMatch.from, { y: 'center' }) });
      // Keep keyboard focus in Find/Replace: Enter navigates matches instead
      // of replacing the selected document text with a newline.
      return;
    }
  }, [findOpen, mode, activeMatch?.from, activeMatch?.to, sourceView, previewMap]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    if (mode === 'edit' && sourceView) {
      const next = markdownOutline(sourceView);
      setHeadings(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      return;
    }
    const update = () => {
      const next = [...element.querySelectorAll<HTMLElement>('.markdown-preview :is(h1,h2,h3,h4,h5,h6)')].map(item => ({ text: item.textContent || '无标题', level: Number(item.tagName[1]) }));
      setHeadings(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const observer = new MutationObserver(update); observer.observe(element, { childList: true, characterData: true, subtree: true }); update();
    return () => observer.disconnect();
  }, [note?.path, mode, revision, sourceView, text]);
  useEffect(() => {
    setSelectedUnits(0); setParagraphUnits(0);
    const updateSelection = () => {
      const selection = window.getSelection();
      const element = host.current;
      if (!selection || !element || !selection.anchorNode || !element.contains(selection.anchorNode)) {
        setParagraphUnits(0);
        return;
      }
      const anchorElement = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as Element : selection.anchorNode.parentElement;
      const block = anchorElement?.closest<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,.cm-line');
      setParagraphUnits(block && element.contains(block) ? countTextUnits(block.textContent || '') : 0);
    };
    document.addEventListener('selectionchange', updateSelection);
    return () => document.removeEventListener('selectionchange', updateSelection);
  }, [note?.path, mode]);
  useEffect(() => {
    if (mode !== 'edit') setSourceSelection(null);
    if (mode !== 'edit' || !sourceSelection || !sourceView) {
      setSelectionToolbar(null);
      setSelectedUnits(0);
      return;
    }
    const toolbarWidth = Math.min(470, Math.max(240, window.innerWidth - 20));
    const centered = sourceSelection.left + sourceSelection.width / 2 - toolbarWidth / 2;
    const maxLeft = Math.max(10, window.innerWidth - toolbarWidth - 10);
    setSelectedUnits(countTextUnits(sourceView.state.sliceDoc(sourceSelection.from, sourceSelection.to)));
    setSelectionToolbar({ left: Math.min(maxLeft, Math.max(10, centered)), top: Math.max(8, sourceSelection.top - 44) });
  }, [mode, sourceSelection, sourceView]);

  function navigate(direction: 1 | -1) { setCurrentIndex(stepMatchIndex(matches.length, currentIndex, direction)); }
  function toggleReplace() {
    const opening = !replaceOpen;
    setReplaceOpen(opening);
    requestAnimationFrame(() => (opening ? replaceInput.current : findInput.current)?.focus());
  }
  function closeFind() {
    setFindOpen(false);
    const preview = host.current?.querySelector('.markdown-preview');
    const selection = window.getSelection();
    if (preview && selection?.anchorNode && preview.contains(selection.anchorNode)) selection.removeAllRanges();
  }
  function onFindKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
    else if (event.key === 'Enter') { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
  }
  function onReplaceKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
    else if (event.key === 'Enter') { event.preventDefault(); void replaceCurrent(); }
  }
  function replaceCurrent() {
    if (replacing || mode === 'preview' || !sourceView) return;
    if (sourceView) {
      const liveMatches = findSourceMatches(sourceView, findText, caseSensitive);
      const liveIndex = Math.min(Math.max(currentIndex, 0), liveMatches.length - 1);
      const liveMatch = liveMatches[liveIndex];
      if (!liveMatch) return;
      setReplacing(true);
      try {
        sourceView.dispatch({ changes: { from: liveMatch.from, to: liveMatch.to, insert: replaceText }, selection: { anchor: liveMatch.from + replaceText.length }, effects: CodeMirrorView.scrollIntoView(liveMatch.from, { y: 'center' }) });
        const nextMatches = findSourceMatches(sourceView, findText, caseSensitive);
        setCurrentIndex(nextMatches.length ? Math.min(liveIndex, nextMatches.length - 1) : -1);
      } finally { queueMicrotask(() => setReplacing(false)); }
      return;
    }
  }
  function replaceAll() {
    if (replacing || mode === 'preview' || !sourceView) return;
    if (sourceView) {
      const liveMatches = findSourceMatches(sourceView, findText, caseSensitive);
      if (!liveMatches.length) return;
      setReplacing(true);
      try {
        sourceView.dispatch({ changes: liveMatches.slice().reverse().map(match => ({ from: match.from, to: match.to, insert: replaceText })) });
        setCurrentIndex(-1);
      } finally { queueMicrotask(() => setReplacing(false)); }
      return;
    }
  }
  function runInlineFormat(format: MarkdownInlineFormat) {
    if (sourceView) {
      formatSourceSelection(sourceView, format);
      setSelectionToolbar(null);
      return;
    }
  }
  function runBlockFormat(format: MarkdownBlockFormat) {
    if (sourceView) {
      formatSourceBlock(sourceView, format);
      setSelectionToolbar(null);
      return;
    }
  }
  function runUndo() {
    if (sourceView) { cmUndo(sourceView); sourceView.focus(); return; }

  }
  function runRedo() {
    if (sourceView) { cmRedo(sourceView); sourceView.focus(); return; }

  }
  return <section className="pane note-pane markdown-workspace" data-pane-id={paneId} style={hidden ? { display: 'none' } : undefined} onPointerDownCapture={() => onActivate(paneId)} onFocusCapture={() => onActivate(paneId)}>
    <MarkdownWorkspaceHeader path={note?.path || ''} caption={caption} label={label} mode={mode === 'preview' ? 'preview' : 'edit'} outline={outline} onFind={() => { setFindOpen(true); setReplaceOpen(false); requestAnimationFrame(() => findInput.current?.focus()); }} onToggleMode={() => setMode(mode === 'preview' ? 'edit' : 'preview')} onToggleOutline={() => setOutline(value => !value)} />
    {findOpen && <div className="find-bar" role="search" aria-label={`查找当前${paneId === 'primary' ? '左' : '右'}栏笔记`}>
      <input ref={findInput} aria-label="查找文本" placeholder="查找" value={findText} onChange={event => setFindText(event.target.value)} onKeyDown={onFindKeyDown}/>
      <button type="button" className="find-replace-toggle" aria-label={replaceOpen ? '收起替换' : '展开替换'} title={replaceOpen ? '收起替换' : '展开替换'} aria-expanded={replaceOpen} onClick={toggleReplace}><span aria-hidden="true">替</span></button>
      {replaceOpen && <input ref={replaceInput} aria-label="替换为" placeholder="替换为" value={replaceText} onChange={event => setReplaceText(event.target.value)} onKeyDown={onReplaceKeyDown}/>}
      <span className="find-count" aria-live="polite">{matches.length ? `${activeMatch ? currentIndex + 1 : 0} / ${matches.length}` : '0 / 0'}</span>
      <button type="button" className={caseSensitive ? 'selected' : ''} aria-label="区分大小写" aria-pressed={caseSensitive} title="区分大小写" onClick={() => setCaseSensitive(value => !value)}>Aa</button>
      <button type="button" aria-label="上一个匹配" title="上一个（Shift+Enter）" disabled={!matches.length} onClick={() => navigate(-1)}>↑</button>
      <button type="button" aria-label="下一个匹配" title="下一个（Enter）" disabled={!matches.length} onClick={() => navigate(1)}>↓</button>
      {replaceOpen && (mode === 'preview'
        ? <button type="button" className="find-replace-action" onClick={() => setMode('edit')}>切到编辑后替换</button>
        : <><button type="button" className="find-replace-action" disabled={!activeMatch || replacing} onClick={replaceCurrent}>替换</button><button type="button" className="find-replace-action" disabled={!matches.length || replacing} onClick={replaceAll}>全部替换</button></>)}
      <button type="button" aria-label="关闭查找" title="关闭（Esc）" onClick={closeFind}>×</button>
    </div>}
    <div className="note-body" ref={host}>
      {!note ? <div className="empty-state"><FileText size={28}/><p>打开或新建 Markdown 笔记</p><small>编辑后自动保存</small></div> : <div className="note-content"><div className="note-editor-surface" style={{ display: mode === 'preview' ? 'none' : 'flex' }}><MarkdownSourceEditor key={note.path} notePath={note.path} value={text} onChange={setText} onView={setSourceView} onSelectionChange={setSourceSelection}/></div>{mode === 'preview' && <MarkdownPreview notePath={note.path} text={text} onJump={stableJump}/>}</div>}
      {outline && <aside className="note-outline" aria-label="Markdown 大纲"><div className="outline-title">大纲</div>{headings.length ? headings.map((item, index) => <button key={index} style={{ paddingLeft: 10 + (item.level - 1) * 10 }} title={item.text} onClick={() => { if (mode === 'edit' && sourceView && item.line !== undefined) { const line = sourceView.state.doc.line(Math.min(item.line + 1, sourceView.state.doc.lines)); sourceView.dispatch({ selection: { anchor: line.from }, effects: CodeMirrorView.scrollIntoView(line.from, { y: 'start' }) }); sourceView.focus(); return; } const target = host.current?.querySelectorAll('.markdown-preview :is(h1,h2,h3,h4,h5,h6)')[index]; target?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}><small>{item.level}</small><span>{item.text}</span></button>) : <p>使用标题组织笔记后，目录会出现在这里。</p>}</aside>}
    </div>
    {selectionToolbar && mode === 'edit' && sourceView && <div className="selection-toolbar" role="toolbar" aria-label="选中文本格式" style={{ left: selectionToolbar.left, top: selectionToolbar.top }} onPointerDown={event => event.preventDefault()}>
      <button title="加粗（Ctrl+B）" onClick={() => runInlineFormat('bold')}>B</button>
      <button title="斜体（Ctrl+I）" onClick={() => runInlineFormat('italic')}><i>I</i></button>
      <button title="行内代码" onClick={() => runInlineFormat('code')}>`</button>
      <button title="高亮" onClick={() => runInlineFormat('highlight')}>高亮</button>
      <button title="删除线" onClick={() => runInlineFormat('strike')}>删除线</button>
      <button title="链接" onClick={() => runInlineFormat('link')}>链接</button>
      <span className="format-divider" aria-hidden="true" />
      <button title="二级标题" onClick={() => runBlockFormat('heading')}>H2</button>
      <button title="引用" onClick={() => runBlockFormat('quote')}>引用</button>
      <button title="无序列表" onClick={() => runBlockFormat('bullet')}>• 列表</button>
      <button title="有序列表" onClick={() => runBlockFormat('ordered')}>1. 列表</button>
      <button title="待办事项" onClick={() => runBlockFormat('task')}>待办</button>
      <button title="插入表格" onClick={() => runBlockFormat('table')}>表格</button>
      <span className="format-divider" aria-hidden="true" />
      <button title="撤销（Ctrl+Z）" onClick={runUndo}>撤销</button>
      <button title="重做（Ctrl+Y）" onClick={runRedo}>重做</button>
    </div>}
    {note && <footer className="note-foot" aria-label="字数统计" aria-live="polite"><span className="word-stats"><span>全文 {totalUnits.toLocaleString('zh-CN')} 字</span><span>本段 {paragraphUnits.toLocaleString('zh-CN')} 字</span><span className={selectedUnits ? 'has-selection' : ''}>已选 {selectedUnits.toLocaleString('zh-CN')} 字</span></span></footer>}
  </section>;
}
