import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteRead, SaveNoteResult } from '../types';
import { reader, type SaveLabel } from '../readerContext';
import { DocumentPersistence } from '../documentPersistence.cjs';
import { sameNoteContent } from '../noteContent.cjs';
import { diagnostics } from '../diagnostics.cjs';

type Options = {
  pane: 'primary' | 'secondary'; initial?: NoteRead; initialText?: string;
  ready: boolean; recoveryPending: boolean; recoveryId: string | null;
  barrier: { has(path: string): boolean }; onMessage?: (message: string) => void;
};
let nextDocumentId = 0;

// Both panes use one lifecycle contract. All deferred work reads current refs;
// only a real replacement/reload resets editor history, never a save acknowledgement.
export function useNoteSession(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [note, updateNote] = useState<NoteRead | null>(options.initial || null);
  const [text, updateText] = useState(options.initialText ?? options.initial?.content ?? '');
  const [label, setLabel] = useState<SaveLabel>(sameNoteContent(text, note?.content || '') ? '已保存' : '编辑中');
  const [conflict, updateConflict] = useState<SaveNoteResult | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const noteRef = useRef(note), textRef = useRef(text), conflictRef = useRef(conflict);
  const editRevision = useRef(0), savedRevision = useRef(0);
  const documentId = useRef(0);
  if (!documentId.current) documentId.current = ++nextDocumentId;
  const persistence = useRef(new DocumentPersistence());
  const trace = useCallback((operation: string, detail: Record<string, string | number> = {}) => {
    diagnostics.record(operation, { pane: latest.current.pane, documentId: documentId.current,
      revision: editRevision.current, committedRevision: savedRevision.current, ...detail });
  }, []);
  const setNote = useCallback((value: NoteRead | null) => {
    if (value?.path !== noteRef.current?.path) { documentId.current = ++nextDocumentId; persistence.current.invalidate(); }
    noteRef.current = value; updateNote(value);
  }, []);
  const setConflict = useCallback((value: SaveNoteResult | null) => {
    conflictRef.current = value; updateConflict(value);
  }, []);
  const setText = useCallback((value: string) => {
    if (value === textRef.current) return;
    textRef.current = value; editRevision.current++; updateText(value);
    setLabel(conflictRef.current ? '外部冲突' : sameNoteContent(value, noteRef.current?.content || '') ? '已保存' : '编辑中');
  }, []);
  const replaceText = useCallback((value: string) => {
    persistence.current.invalidate(); documentId.current = ++nextDocumentId;
    textRef.current = value; editRevision.current = 0; savedRevision.current = 0;
    updateText(value); setEditorRevision(value => value + 1); trace('replace');
  }, [trace]);
  const blocked = useCallback(() => !latest.current.ready || latest.current.recoveryPending || !!conflictRef.current ||
    !!(noteRef.current && latest.current.barrier.has(noteRef.current.path)), []);
  const snapshot = useCallback(() => ({ note: noteRef.current, text: textRef.current, revision: editRevision.current }), []);
  const persistRecovery = useCallback(async () => {
    const { recoveryId, pane } = latest.current, current = noteRef.current, content = textRef.current;
    if (blocked() || !current || !recoveryId || sameNoteContent(content, current.content)) return;
    const origin = documentId.current, revision = editRevision.current;
    await reader().writeRecovery({ sourcePath: current.path, paneHint: pane, recoveryId, baseHash: current.hash,
      content, encoding: { bom: current.bom, eol: current.eol } });
    trace('recovery', { documentId: origin, revision });
  }, [blocked, trace]);
  const save = useCallback((expected?: NoteRead): Promise<boolean> => {
    if (expected && noteRef.current !== expected) return Promise.resolve(true);
    return persistence.current.save({ snapshot, blocked, recovery: persistRecovery,
      recoveryError: () => latest.current.onMessage?.('恢复稿暂时无法更新，正在继续保存正文。'),
      write: state => { trace('save.submit', { submittedRevision: state.revision });
        return reader().saveNote({ ...state.note!, content: state.text, recoveryId: latest.current.recoveryId || undefined }); },
      saving: () => setLabel('保存中'), clean: () => setLabel('已保存'),
      conflict: result => { setConflict(result); setLabel('外部冲突'); trace('save.conflict'); },
      commit: (result, state) => {
        setNote({ ...state.note!, content: result.content, hash: result.hash }); savedRevision.current = state.revision;
        setLabel(sameNoteContent(textRef.current, result.content) ? '已保存' : '编辑中');
        trace('save.commit', { submittedRevision: state.revision });
      },
      error: error => { setLabel('保存失败'); trace('save.error'); latest.current.onMessage?.(`保存失败：${String(error)}`); },
    });
  }, [snapshot, blocked, persistRecovery, setConflict, setNote, trace]);
  const flushRecovery = useCallback(async () => {
    try { await persistRecovery(); return true; }
    catch (error) { latest.current.onMessage?.(`恢复稿保存失败：${String(error)}`); return false; }
  }, [persistRecovery]);
  useEffect(() => {
    if (blocked() || !note || sameNoteContent(text, note.content)) return;
    const expected = noteRef.current!;
    const timer = window.setTimeout(() => void save(expected), 900);
    return () => window.clearTimeout(timer);
  }, [text, note, options.ready, options.recoveryPending, conflict, save, blocked]);
  useEffect(() => {
    if (blocked() || !note || !options.recoveryId || sameNoteContent(text, note.content)) return;
    const expected = noteRef.current, content = text;
    const timer = window.setTimeout(() => {
      if (noteRef.current === expected && textRef.current === content) void flushRecovery();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [text, note, options.ready, options.recoveryPending, options.recoveryId, conflict, flushRecovery, blocked]);
  useEffect(() => {
    persistence.current.disposed = false;
    const timer = window.setInterval(() => {
      void persistence.current.poll({ snapshot, blocked, read: path => reader().readNote(path),
        apply: (disk, hasConflict) => {
          if (hasConflict) { setConflict({ ...disk, conflict: true }); setLabel('外部冲突'); trace('poll.conflict'); }
          else { setNote(disk); if (!sameNoteContent(disk.content, textRef.current)) replaceText(disk.content);
            setLabel('已保存'); trace('poll.reload'); }
        },
      }).catch(() => trace('poll.error'));
    }, 3000);
    return () => { window.clearInterval(timer); persistence.current.invalidate(); persistence.current.disposed = true; };
  }, [snapshot, blocked, setConflict, setNote, replaceText, trace]);
  return { note, text, label, conflict, editorRevision, noteRef, textRef, conflictRef, documentId,
    setNote, setText, replaceText, setLabel, setConflict, save, flushRecovery, blocked };
}
