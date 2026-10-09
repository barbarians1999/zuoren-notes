import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReducedMotionContext } from '../uiMotion';
import { OutlinePanel } from '../OutlinePanel';
import { FileText } from 'lucide-react';
import type { MarkdownScrollMemory, NoteRead, ReaderAnchor } from '../types';
import { type NoteMode, type FindCommand } from '../readerContext';
import { isolateHistory } from '@codemirror/commands';
import { undoNoteView as cmUndo, redoNoteView as cmRedo, type NoteDocument, type NoteViewState } from '../workspace/noteDocument';
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
import { createPortal } from 'react-dom';
import { taskToggleChange } from './markdownTasks';
export function NotePane({ paneId, onActivate, findCommand, note, text, mode, setMode, onSave, onJump, revision, label, caption, scrollMemory, onScrollMemory, excerptRegister, hidden, sharedDocument, tab, unifiedHeader, headerTarget, headerControls }: { paneId: FindCommand['pane']; onActivate: (pane: FindCommand['pane']) => void; findCommand: FindCommand | null; note: NoteRead | null; text: string; mode: NoteMode; setMode: (mode: NoteMode) => void; onSave: () => void; onJump: (anchor: ReaderAnchor, fromNotePath?: string) => void; revision: number; label?: string; caption?: React.ReactNode; scrollMemory: MarkdownScrollMemory[]; onScrollMemory: (entry: MarkdownScrollMemory) => void; excerptRegister?: React.MutableRefObject<(block: string) => boolean>; hidden?: boolean; sharedDocument: NoteDocument | null; tab: NoteViewState | null; unifiedHeader?: boolean; headerTarget?: HTMLElement | null; headerControls?: React.ReactNode }) {
  const [outline, setOutline] = useState(false);
  const reducedMotion = useContext(ReducedMotionContext);
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
      if (!sourceView || !note || !sharedDocument || sharedDocument.editingBlocked() || liveNotePath.current !== note.path || sourceView.dom.parentElement?.getAttribute('data-note-path') !== note.path) return false;
      const revision = sharedDocument.revision;
      const doc = sourceView.state.doc.toString();
      const from = doc.trimEnd().length;
      sourceView.dispatch({
        changes: { from, to: doc.length, insert: block },
        selection: { anchor: from + block.length },
        annotations: [Transaction.userEvent.of('input.excerpt'), isolateHistory.of('full')],
      });
      return sharedDocument.revision !== revision;
    };
    excerptRegister.current = append;
    return () => { if (excerptRegister.current === append) excerptRegister.current = () => false; };
  }, [excerptRegister, note?.path, sourceView, tab?.id, sharedDocument]);
  const [previewMap, setPreviewMap] = useState<DomTextMap>({ text: '', nodes: [] });
  const [selectedUnits, setSelectedUnits] = useState(0);
  const [paragraphUnits, setParagraphUnits] = useState(0);
  const [selectionToolbar, setSelectionToolbar] = useState<{ left: number; top: number } | null>(null);
  const [sourceSelection, setSourceSelection] = useState<{ from: number; to: number; left: number; top: number; width: number; height: number } | null>(null);
  const onJumpRef = useRef(onJump); onJumpRef.current = onJump;
  const scrollMemoryRef = useRef(scrollMemory); scrollMemoryRef.current = scrollMemory;
  const onScrollMemoryRef = useRef(onScrollMemory); onScrollMemoryRef.current = onScrollMemory;
  const stableJump = useCallback((anchor: ReaderAnchor) => onJumpRef.current(anchor, note?.path), [note?.path]);
  const toggleTask = useCallback((position: number, checked: boolean, expectedSource: string) => {
    if (!sourceView || sourceView.state.readOnly || !note || hidden || sharedDocument?.editingBlocked() || label === '外部冲突' || liveNotePath.current !== note.path ||
        sourceView.dom.parentElement?.getAttribute('data-note-path') !== note.path) return false;
    // CodeMirror uses LF offsets; disk snapshots may retain CRLF.
    const expected = expectedSource.replace(/\r\n/g, '\n');
    const sourcePosition = expectedSource.slice(0, position).replace(/\r\n/g, '\n').length;
    const change = taskToggleChange(sourceView.state.doc.toString(), expected, sourcePosition, checked);
    if (!change) return false;
    sourceView.dispatch({ changes: change, annotations: [Transaction.userEvent.of('input.task'), isolateHistory.of('full')] });
    return true;
  }, [sourceView, note?.path, hidden, label, sharedDocument]);
  const host = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const findFocusTarget = useRef<'find' | 'replace'>('find');
  const lastPath = useRef(note?.path);
  const [wordCount, setWordCount] = useState<{ path: string; units: number } | null>(null);
  const notePath = note?.path;
  // Defer only the display, never editing/recovery/save. A different document
  // must not inherit the previous one's count while its timer is pending.
  useEffect(() => {
    if (!notePath) return;
    const timer = window.setTimeout(() => setWordCount({ path: notePath, units: countMarkdownUnits(text) }), 300);
    return () => window.clearTimeout(timer);
  }, [notePath, text]);
  const totalUnits = wordCount?.path === notePath ? wordCount?.units : undefined;
  const matches = useMemo(() => !findOpen || hidden ? [] : mode === 'preview'
    ? findLiteralMatches(previewMap.text, findText, caseSensitive)
    : sourceView ? findSourceMatches(sourceView, findText, caseSensitive) : [],
  [mode, previewMap, findText, caseSensitive, sourceView, text, findOpen, hidden]);
  const activeMatch = currentIndex >= 0 && currentIndex < matches.length ? matches[currentIndex] : null;
  useEffect(() => {
    if (lastPath.current === note?.path) return;
    lastPath.current = note?.path;
    setSourceSelection(null); setSelectionToolbar(null); setSelectedUnits(0);
    setFindOpen(false); setReplaceOpen(false); setFindText(''); setReplaceText(''); setCurrentIndex(-1);
  }, [note?.path]);
  useEffect(() => {
    const notePath = note?.path;
    if (!notePath || hidden) return;
    const memoryMode: MarkdownScrollMemory['mode'] = mode === 'preview' ? 'preview' : 'edit';
    let frame = 0;
    let attempts = 0;
    let scrollTimer = 0;
    let scroller: HTMLElement | null = null;
    const capture = () => {
      if (!scroller || !scroller.clientHeight) return;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (tab) tab.scroll[memoryMode] = scroller.scrollTop;
      onScrollMemoryRef.current({ pane: paneId, path: notePath, mode: memoryMode, scrollTop: scroller.scrollTop, ratio: maxScrollTop ? scroller.scrollTop / maxScrollTop : 0 });
    };
    const onScroll = () => {
      if (tab && scroller?.clientHeight) tab.scroll[memoryMode] = scroller.scrollTop;
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(capture, 140);
    };
    const attach = () => {
      scroller = host.current?.querySelector<HTMLElement>(memoryMode === 'preview' ? '.markdown-preview:not(.preview-loading)' : '.markdown-source-editor .cm-scroller') || null;
      if (!scroller) {
        if (++attempts < 600) frame = requestAnimationFrame(attach);
        return;
      }
      const saved = scrollMemoryRef.current.find(entry => entry.pane === paneId && entry.path === notePath && entry.mode === memoryMode);
      if (tab) scroller.scrollTop = Math.min(tab.scroll[memoryMode], Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      else if (saved) scroller.scrollTop = resolveScrollTop(saved, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      scroller.addEventListener('scroll', onScroll, { passive: true });
    };
    frame = requestAnimationFrame(attach);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(scrollTimer);
      if (scroller) { scroller.removeEventListener('scroll', onScroll); capture(); }
    };
  }, [note?.path, mode, paneId, tab?.id, hidden]);
  useLayoutEffect(() => {
    if (!findCommand || findCommand.pane !== paneId) return;
    findFocusTarget.current = 'find';
    setFindOpen(true); setReplaceOpen(findCommand.mode === 'replace');
    findInput.current?.focus();
  }, [findCommand?.sequence, findCommand?.pane, paneId]);
  useLayoutEffect(() => {
    if (findOpen) (findFocusTarget.current === 'replace' ? replaceInput.current : findInput.current)?.focus();
  }, [findOpen, replaceOpen]);
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
    findFocusTarget.current = opening ? 'replace' : 'find';
    setReplaceOpen(opening);
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
  return <section className="pane note-pane markdown-workspace" data-pane-id={paneId} style={hidden ? { display: 'none' } : undefined} onPointerDownCapture={() => onActivate(paneId)} onFocusCapture={() => onActivate(paneId)} onKeyDownCapture={event => {
    if (mode === 'preview' && sourceView && !hidden && label !== '外部冲突' && !event.nativeEvent.isComposing && event.keyCode !== 229 &&
        !event.defaultPrevented && (event.ctrlKey || event.metaKey) && !event.altKey && (event.target as Element).closest?.('.markdown-preview')) {
      const key = event.key.toLowerCase();
      if ((key === 'z' || (key === 'y' && !event.shiftKey)) && (key === 'y' || event.shiftKey ? cmRedo(sourceView) : cmUndo(sourceView))) {
        event.preventDefault(); event.stopPropagation(); return;
      }
    }
    if (!note || hidden || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 ||
        !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
    // Pane capture covers reading/Find too, with the current callback and
    // without rebuilding CodeMirror or its undo history.
    event.preventDefault(); event.stopPropagation(); onSave();
  }}>
    {(() => {
      const header = <MarkdownWorkspaceHeader path={note?.path || ''} caption={caption} label={label} onSave={onSave} canSave={!!note && (label === '编辑中' || label === '保存失败')} mode={mode === 'preview' ? 'preview' : 'edit'} outline={outline} onFind={() => { findFocusTarget.current = 'find'; setFindOpen(true); setReplaceOpen(false); findInput.current?.focus(); }} onToggleMode={() => setMode(mode === 'preview' ? 'edit' : 'preview')} onToggleOutline={() => setOutline(value => !value)} compact={unifiedHeader} enabled={!!note} controls={headerControls}/>;
      return unifiedHeader ? headerTarget && createPortal(<div data-note-controls={paneId}>{header}</div>, headerTarget) : header;
    })()}
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
      {!note ? <div className="empty-state"><FileText size={28}/><p>打开或新建 Markdown 笔记</p><small>编辑后自动保存</small></div> : <div className="note-content"><div className="note-editor-surface" style={{ display: mode === 'preview' ? 'none' : 'flex' }}><MarkdownSourceEditor notePath={note.path} onView={setSourceView} onSelectionChange={setSourceSelection} sharedDocument={sharedDocument!} tab={tab!}/></div>{mode === 'preview' && <MarkdownPreview notePath={note.path} text={text} onJump={stableJump} onToggleTask={toggleTask}/>}</div>}
      <OutlinePanel open={outline} label="Markdown 大纲" emptyText="使用标题组织笔记后，目录会出现在这里。"
        returnFocus={() => document.querySelector(`[data-note-controls="${paneId}"] [data-outline-toggle]`) || host.current?.querySelector('[data-outline-toggle]') || null}
        items={headings.map((item, index) => ({ id: String(index), label: item.text, depth: item.level - 1, indicator: String(item.level) }))}
        onSelect={entry => { const index = Number(entry.id), item = headings[index]; if (!item) return;
          if (mode === 'edit' && sourceView && item.line !== undefined) { const line = sourceView.state.doc.line(Math.min(item.line + 1, sourceView.state.doc.lines)); sourceView.dispatch({ selection: { anchor: line.from }, effects: CodeMirrorView.scrollIntoView(line.from, { y: 'start' }) }); sourceView.focus(); return; }
          host.current?.querySelectorAll('.markdown-preview :is(h1,h2,h3,h4,h5,h6)')[index]?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' }); }}/>
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
    {note && <footer className="note-foot" aria-label="字数统计" aria-live="polite"><span className="word-stats"><span>{totalUnits === undefined ? '全文统计中…' : `全文 ${totalUnits.toLocaleString('zh-CN')} 字`}</span><span>本段 {paragraphUnits.toLocaleString('zh-CN')} 字</span><span className={selectedUnits ? 'has-selection' : ''}>已选 {selectedUnits.toLocaleString('zh-CN')} 字</span></span></footer>}
  </section>;
}
