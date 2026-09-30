import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MarkdownScrollMemory, NoteRead, ReaderAnchor, RecoveryCheckResult, RecoveryV1, WorkspaceFile } from '../types';
import { reader, type NoteMode, type FindCommand } from '../readerContext';
import { NotePane } from '../editor/NotePane';
import { ConflictDialog } from './DocumentDialogs';
import { useNoteSession } from './useNoteSession';
import { sameNoteContent } from '../noteContent.cjs';
import { MutationBarrier } from '../fileOperations.cjs';
export function SecondaryNote({ initial, initialMode, initialRecovery, recoveryId, mutationBarrier, register, excerptRegister, onJump, choices, onChoose, onModeChange, onNoteChange, paneId, onActivate, findCommand, scrollMemory, onScrollMemory }: { initial: NoteRead; initialMode: NoteMode; initialRecovery?: RecoveryCheckResult; recoveryId: string | null; mutationBarrier: React.MutableRefObject<MutationBarrier>; register: React.MutableRefObject<() => Promise<boolean>>; excerptRegister: React.MutableRefObject<(block: string) => boolean>; onJump: (anchor: ReaderAnchor, fromNotePath?: string) => void; choices: WorkspaceFile[]; onChoose: (path: string) => void; onModeChange: (mode: NoteMode) => void; onNoteChange: (note: NoteRead, recoveryId: string) => void; paneId: FindCommand['pane']; onActivate: (pane: FindCommand['pane']) => void; findCommand: FindCommand | null; scrollMemory: MarkdownScrollMemory[]; onScrollMemory: (entry: MarkdownScrollMemory) => void }) {
  const restoredText = initialRecovery?.status === 'recoverable' ? initialRecovery.recovery.content : initial.content;
  const [mode, setMode] = useState<NoteMode>(initialMode);
  const [recoveryConflict, setRecoveryConflict] = useState<RecoveryV1 | null>(initialRecovery?.status === 'conflict' ? initialRecovery.recovery : null);
  const session = useNoteSession({ pane: 'secondary', initial, initialText: restoredText, ready: true,
    recoveryPending: !!recoveryConflict, recoveryId, barrier: mutationBarrier.current });
  const { note: nullableNote, setNote, text, setText, label, setLabel, conflict, setConflict,
    editorRevision: revision, noteRef: current, textRef: draft, save, replaceText } = session;
  const note = nullableNote!;
  const editorInsert = useRef<(block: string) => boolean>(() => false);
  const appendExcerpt = useCallback((block: string) => {
    if (session.blocked()) return false;
    return editorInsert.current(block);
  }, [session.blocked]);
  useEffect(() => { excerptRegister.current = appendExcerpt; return () => { if (excerptRegister.current === appendExcerpt) excerptRegister.current = () => false; }; }, [appendExcerpt, excerptRegister]);
  useEffect(() => { register.current = save; return () => { if (register.current === save) register.current = async () => true; }; }, [save, register]);
  useEffect(() => { onModeChange(mode); }, [mode, onModeChange]);
  useEffect(() => {
    if (initialRecovery?.status === 'conflict') setRecoveryConflict(initialRecovery.recovery);
    else if (initialRecovery?.status === 'recoverable' && sameNoteContent(draft.current, current.current!.content)) {
      replaceText(initialRecovery.recovery.content); setLabel('编辑中');
    }
  }, [initialRecovery]);
  async function keepRecoveryDraft() {
    if (!recoveryConflict) return;
    const result = await reader().saveNote({ ...current.current!, content: recoveryConflict.content, recoveryId: recoveryId || undefined });
    if (result.conflict) { const latest = await reader().readNote(current.current!.path); setNote(latest); replaceText(latest.content); return; }
    setNote({ ...current.current!, ...result }); replaceText(result.content); setRecoveryConflict(null); setLabel('已保存');
  }
  async function discardRecoveryDraft() {
    if (!recoveryConflict || !recoveryId) return;
    await reader().deleteRecovery({ sourcePath: current.current!.path, recoveryId, draftHash: recoveryConflict.draftHash });
    replaceText(current.current!.content); setRecoveryConflict(null); setLabel('已保存');
  }
  async function saveRecoveryDraftAs() {
    if (!recoveryConflict) return;
    const saved = await reader().saveAs({ sourcePath: current.current!.path, suggestedName: current.current!.path.split(/[\\/]/).pop(), content: recoveryConflict.content });
    if (!saved) return;
    if (recoveryId) await reader().deleteRecovery({ sourcePath: current.current!.path, recoveryId, draftHash: recoveryConflict.draftHash });
    const id = crypto.randomUUID(); setNote(saved); replaceText(saved.content); setRecoveryConflict(null); setLabel('已保存'); onNoteChange(saved, id);
  }
  async function saveConflictAs() {
    const saved = await reader().saveAs({ sourcePath: note.path, content: text });
    if (!saved) return;
    const id = crypto.randomUUID(); setNote(saved); replaceText(saved.content); setConflict(null); setLabel('已保存'); onNoteChange(saved, id);
  }
  return <><NotePane paneId={paneId} onActivate={onActivate} findCommand={findCommand} caption={<select aria-label="右栏笔记" title={note.path} value={note.path} onChange={event => onChoose(event.target.value)}>{choices.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</select>} label={label} note={note} text={text} setText={setText} mode={mode} setMode={setMode} onSave={() => void save()} onJump={onJump} revision={revision} scrollMemory={scrollMemory} onScrollMemory={onScrollMemory} excerptRegister={editorInsert}/>
    {conflict?.conflict && <ConflictDialog conflict={conflict} mine={text} closing={false} onMine={() => { setNote({ ...current.current!, content: conflict.content, hash: conflict.hash }); setConflict(null); void save(); }} onDisk={() => { setNote(conflict); replaceText(conflict.content); setConflict(null); setLabel('已保存'); }} onSaveAs={() => void saveConflictAs()}/>}
    {recoveryConflict && <ConflictDialog conflict={{ conflict: true, ...current.current! }} mine={recoveryConflict.content} closing={false} onMine={() => void keepRecoveryDraft()} onDisk={() => void discardRecoveryDraft()} onSaveAs={() => void saveRecoveryDraftAs()}/>}</>;
}
