import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowLeftRight, BookOpen, ChevronLeft, ChevronRight, Columns2, Copy, Crop, List, FileText, Folder, FolderOpen, FolderPlus, FolderTree, Highlighter, Maximize2, MessageSquare, Minimize2, Minus, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Square, Sun, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { EpubAnchor, EpubAnnotation, EpubMeta, MarkdownScrollMemory, NoteRead, PdfAnchor, PdfAnnotation, PdfMeta, PdfRect, ReaderAnchor, RecoveryCheckResult, RecoveryV1, SaveNoteResult, WorkspaceFile } from '../types';
import { reader, resolveLocal, NOTE_BODY_FONTS, EPUB_MIN_SPREAD_WIDTH, type ActivePdf, type ActiveEpub, type FlatNavItem, type OcrDialog, type NoteMode, type NoteBodyFont, type SaveLabel, type FindCommand } from '../readerContext';
import { NotePane } from '../editor/NotePane';
import { ConflictDialog } from './DocumentDialogs';
import { DocumentPersistence } from '../documentPersistence.cjs';
import { sameNoteContent } from '../noteContent.cjs';
import { MutationBarrier } from '../fileOperations.cjs';
export function SecondaryNote({ initial, initialMode, initialRecovery, recoveryId, mutationBarrier, register, excerptRegister, onJump, choices, onChoose, onModeChange, onNoteChange, paneId, onActivate, findCommand, scrollMemory, onScrollMemory }: { initial: NoteRead; initialMode: NoteMode; initialRecovery?: RecoveryCheckResult; recoveryId: string | null; mutationBarrier: React.MutableRefObject<MutationBarrier>; register: React.MutableRefObject<() => Promise<boolean>>; excerptRegister: React.MutableRefObject<(block: string) => boolean>; onJump: (anchor: ReaderAnchor, fromNotePath?: string) => void; choices: WorkspaceFile[]; onChoose: (path: string) => void; onModeChange: (mode: NoteMode) => void; onNoteChange: (note: NoteRead, recoveryId: string) => void; paneId: FindCommand['pane']; onActivate: (pane: FindCommand['pane']) => void; findCommand: FindCommand | null; scrollMemory: MarkdownScrollMemory[]; onScrollMemory: (entry: MarkdownScrollMemory) => void }) {
  const restoredText = initialRecovery?.status === 'recoverable' ? initialRecovery.recovery.content : initial.content;
  const [note, setNote] = useState(initial), [text, setText] = useState(restoredText);
  const [mode, setMode] = useState<NoteMode>(initialMode), [label, setLabel] = useState<SaveLabel>(initialRecovery?.status === 'recoverable' ? '编辑中' : '已保存');
  const [conflict, setConflict] = useState<(SaveNoteResult & { conflict: true }) | null>(null);
  const [recoveryConflict, setRecoveryConflict] = useState<RecoveryV1 | null>(initialRecovery?.status === 'conflict' ? initialRecovery.recovery : null);
  const [revision, setRevision] = useState(0);
  const current = useRef(initial), draft = useRef(restoredText);
  const persistence = useRef(new DocumentPersistence());
  const editRevision = useRef(0), savedRevision = useRef(0);
  const conflictRef = useRef(conflict); conflictRef.current = conflict;
  const editorInsert = useRef<(block: string) => boolean>(() => false);
  const appendExcerpt = useCallback((block: string) => {
    if (conflictRef.current || recoveryConflict) return false;
    if (mutationBarrier.current.has(current.current.path)) return false;
    return editorInsert.current(block);
  }, [recoveryConflict]);
  useEffect(() => { excerptRegister.current = appendExcerpt; return () => { if (excerptRegister.current === appendExcerpt) excerptRegister.current = () => false; }; }, [appendExcerpt, excerptRegister]);
  const save = useCallback((): Promise<boolean> => persistence.current.save({
    snapshot: () => ({ note: current.current, text: draft.current, revision: editRevision.current }),
    blocked: () => !!conflictRef.current || !!recoveryConflict || mutationBarrier.current.has(current.current.path),
    recovery: state => reader().writeRecovery({ sourcePath: state.note!.path, paneHint: 'secondary', recoveryId: recoveryId || crypto.randomUUID(), baseHash: state.note!.hash, content: state.text, encoding: { bom: state.note!.bom, eol: state.note!.eol } }),
    write: state => reader().saveNote({ ...state.note!, content: state.text, recoveryId: recoveryId || undefined }),
    saving: () => setLabel('保存中'), clean: () => setLabel('已保存'),
    conflict: result => { conflictRef.current = result; setConflict(result); setLabel('外部冲突'); },
    commit: (result, state) => { current.current = { ...state.note!, ...result }; setNote(current.current); savedRevision.current = state.revision; setLabel(sameNoteContent(draft.current, result.content) ? '已保存' : '编辑中'); },
    error: () => setLabel('保存失败'),
  }), [recoveryConflict, recoveryId]);
  useEffect(() => { register.current = save; return () => { if (register.current === save) register.current = async () => true; }; }, [save, register]);
  useEffect(() => { const timer = window.setTimeout(() => void save(), 900); return () => clearTimeout(timer); }, [text, save]);
  useEffect(() => { onModeChange(mode); }, [mode, onModeChange]);
  useEffect(() => {
    if (initialRecovery?.status === 'conflict') setRecoveryConflict(initialRecovery.recovery);
    else if (initialRecovery?.status === 'recoverable' && sameNoteContent(draft.current, current.current.content)) {
      draft.current = initialRecovery.recovery.content; setText(initialRecovery.recovery.content); setLabel('编辑中');
    }
  }, [initialRecovery]);
  useEffect(() => {
     if (!recoveryId || !note || mutationBarrier.current.has(current.current.path) || sameNoteContent(draft.current, current.current.content) || recoveryConflict) return;
    const timer = window.setTimeout(() => {
      void reader().writeRecovery({ sourcePath: current.current.path, paneHint: 'secondary', recoveryId, baseHash: current.current.hash, content: draft.current, encoding: { bom: current.current.bom, eol: current.current.eol } }).catch(() => setLabel('保存失败'));
    }, 400);
    return () => clearTimeout(timer);
  }, [text, note?.path, note?.hash, recoveryId, recoveryConflict]);
  useEffect(() => {
    persistence.current.disposed = false;
    const timer = window.setInterval(() => {
      void persistence.current.poll({
        snapshot: () => ({ note: current.current, text: draft.current, revision: editRevision.current }),
        blocked: () => !!conflictRef.current || mutationBarrier.current.has(current.current.path),
        read: path => reader().readNote(path),
        apply: (disk, hasConflict) => {
          if (hasConflict) { const problem = { ...disk, conflict: true as const }; conflictRef.current = problem; setConflict(problem); setLabel('外部冲突'); }
          else { current.current = disk; setNote(disk); if (!sameNoteContent(disk.content, draft.current)) { draft.current = disk.content; setText(disk.content); setRevision(value => value + 1); } setLabel('已保存'); }
        },
      }).catch(() => {});
    }, 3000);
    return () => { clearInterval(timer); persistence.current.invalidate(); persistence.current.disposed = true; };
  }, []);
  async function keepRecoveryDraft() {
    if (!recoveryConflict) return;
    const result = await reader().saveNote({ ...current.current, content: recoveryConflict.content, recoveryId: recoveryId || undefined });
    if (result.conflict) { const latest = await reader().readNote(current.current.path); current.current = latest; setNote(latest); draft.current = latest.content; setText(latest.content); return; }
    current.current = { ...current.current, ...result }; draft.current = result.content; setNote(current.current); setText(result.content); setRecoveryConflict(null); setLabel('已保存');
  }
  async function discardRecoveryDraft() {
    if (!recoveryConflict || !recoveryId) return;
    await reader().deleteRecovery({ sourcePath: current.current.path, recoveryId, draftHash: recoveryConflict.draftHash });
    draft.current = current.current.content; setText(current.current.content); setRecoveryConflict(null); setLabel('已保存');
  }
  async function saveRecoveryDraftAs() {
    if (!recoveryConflict) return;
    const saved = await reader().saveAs({ sourcePath: current.current.path, suggestedName: current.current.path.split(/[\\/]/).pop(), content: recoveryConflict.content });
    if (!saved) return;
    if (recoveryId) await reader().deleteRecovery({ sourcePath: current.current.path, recoveryId, draftHash: recoveryConflict.draftHash });
    const id = crypto.randomUUID(); current.current = saved; draft.current = saved.content; setNote(saved); setText(saved.content); setRecoveryConflict(null); setLabel('已保存'); onNoteChange(saved, id);
  }
  async function saveConflictAs() {
    const saved = await reader().saveAs({ sourcePath: note.path, content: text });
    if (!saved) return;
    const id = crypto.randomUUID(); current.current = saved; draft.current = saved.content; setNote(saved); setText(saved.content); conflictRef.current = null; setConflict(null); setLabel('已保存'); onNoteChange(saved, id);
  }
  return <><NotePane paneId={paneId} onActivate={onActivate} findCommand={findCommand} caption={<select aria-label="右栏笔记" title={note.path} value={note.path} onChange={event => onChoose(event.target.value)}>{choices.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</select>} label={label} note={note} text={text} setText={value => { draft.current = value; editRevision.current += 1; setText(value); setLabel('编辑中'); }} mode={mode} setMode={setMode} onSave={() => void save()} onJump={onJump} revision={revision} scrollMemory={scrollMemory} onScrollMemory={onScrollMemory} excerptRegister={editorInsert}/>
    {conflict && <ConflictDialog conflict={conflict} mine={text} closing={false} onClose={() => {}} onMine={() => { current.current = { ...current.current, hash: conflict.hash }; conflictRef.current = null; setConflict(null); void save(); }} onDisk={() => { current.current = conflict; draft.current = conflict.content; setNote(conflict); setText(conflict.content); conflictRef.current = null; setConflict(null); setLabel('已保存'); setRevision(value => value + 1); }} onSaveAs={() => void saveConflictAs()}/>} 
    {recoveryConflict && <ConflictDialog conflict={{ conflict: true, ...current.current }} mine={recoveryConflict.content} closing={false} onClose={() => setRecoveryConflict(null)} onMine={() => void keepRecoveryDraft()} onDisk={() => void discardRecoveryDraft()} onSaveAs={() => void saveRecoveryDraftAs()}/>}</>;
}
