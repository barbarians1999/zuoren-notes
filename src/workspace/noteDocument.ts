import { EditorSelection, EditorState, Transaction, type Annotation, type StateCommand } from '@codemirror/state';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { NoteRead, ReaderApi, RecoveryReference, RecoveryV1, SaveNoteResult } from '../types';
import type { SaveLabel } from '../readerContext';
import { DocumentPersistence } from '../documentPersistence.cjs';
import { sameNoteContent } from '../noteContent.cjs';
import { diagnostics } from '../diagnostics.cjs';

export type NoteViewState = {
  id: string; document: NoteDocument | null; preview: boolean; mode: 'edit' | 'preview';
  selection: EditorSelection; scroll: { edit: number; preview: number };
};
type RecoveryConflict = { note: NoteRead; recovery: RecoveryV1; recoveryId: string };
let sequence = 0;
const bindings = new WeakMap<EditorView, { document: NoteDocument; tab: NoteViewState }>();
export function undoNoteView(view: EditorView) { return bindings.get(view)?.document.runHistory(undo, view) ?? undo(view); }
export function redoNoteView(view: EditorView) { return bindings.get(view)?.document.runHistory(redo, view) ?? redo(view); }

// The document, not a pane, owns history, revision, recovery and the existing
// save/poll gate. Views receive changes, never a competing whole-file write.
export class NoteDocument {
  state: EditorState;
  noteRef: { current: NoteRead };
  textRef: { current: string };
  conflictRef: { current: (SaveNoteResult & { conflict: true }) | null } = { current: null };
  documentId = { current: ++sequence };
  label: SaveLabel = '已保存';
  recoveryConflict: RecoveryConflict | null = null;
  recoveryId: string;
  recoveryReferences: RecoveryReference[] = [];
  revision = 0;
  committedRevision = 0;
  ready = false;
  initialized: Promise<void> = Promise.resolve();
  disposed = false;
  saveDue = Infinity;
  recoveryDue = Infinity;
  lastPoll = Date.now();
  polling = false;
  views = new Set<NoteViewState>();
  private mounted = new Map<EditorView, NoteViewState>();
  private persistence = new DocumentPersistence();
  constructor(note: NoteRead, recoveryId: string, private api: () => ReaderApi,
    private barrier: { has(path: string): boolean }, private notify: () => void,
    private edited: (doc: NoteDocument) => void, private message: (text: string) => void,
    public paneHint: 'primary' | 'secondary' = 'primary', private allowEdits: () => boolean = () => true) {
    this.noteRef = { current: note }; this.recoveryId = recoveryId;
    this.state = EditorState.create({ doc: note.content, extensions: [history(), EditorState.allowMultipleSelections.of(true)] });
    this.textRef = { current: this.state.doc.toString() };
  }
  get note() { return this.noteRef.current; }
  get text() { return this.textRef.current; }
  get conflict() { return this.conflictRef.current; }
  get retainedRecoveryIds() { return this.recoveryReferences.map(item => item.recoveryId); }
  blocked = () => !this.ready || this.disposed || !!this.recoveryConflict || !!this.conflict || this.barrier.has(this.note.path);
  // A final workspace commit freezes input, not the persistence queue.
  editingBlocked = () => !this.ready || this.disposed || this.barrier.has(this.note.path) || !this.allowEdits();
  private trace(operation: string, detail: Record<string, string | number> = {}) {
    diagnostics.record(operation, { pane: this.paneHint, documentId: this.documentId.current,
      revision: this.revision, committedRevision: this.committedRevision, ...detail });
  }
  attach(view: EditorView, tab: NoteViewState) {
    this.mounted.set(view, tab); bindings.set(view, { document: this, tab });
    return () => { tab.selection = view.state.selection; this.mounted.delete(view); bindings.delete(view); };
  }
  dispatch(view: EditorView, transactions: readonly Transaction[]) {
    for (const transaction of transactions) {
      const tab = this.mounted.get(view);
      if (!tab || transaction.startState !== view.state) continue;
      if (transaction.docChanged && this.editingBlocked()) return;
      if (transaction.docChanged) {
        if (!transaction.startState.doc.eq(this.state.doc)) return;
        const annotations: Annotation<unknown>[] = [];
        const event = transaction.annotation(Transaction.userEvent), isolation = transaction.annotation(isolateHistory);
        if (event) annotations.push(Transaction.userEvent.of(event));
        if (isolation) annotations.push(isolateHistory.of(isolation));
        annotations.push(Transaction.time.of(transaction.annotation(Transaction.time)!));
        const add = transaction.annotation(Transaction.addToHistory);
        if (add !== undefined) annotations.push(Transaction.addToHistory.of(add));
        const change = this.state.update({ changes: transaction.changes, selection: transaction.newSelection, annotations });
        this.state = change.state;
        view.update([transaction]); tab.selection = view.state.selection;
        this.broadcast(change, view);
        this.changed();
      } else { view.update([transaction]); tab.selection = view.state.selection; if (transaction.selection) this.notify(); }
    }
  }
  private broadcast(transaction: Transaction, origin?: EditorView, selectOrigin = false) {
    const originTab = origin && this.mounted.get(origin);
    for (const tab of this.views) {
      if (tab !== originTab) tab.selection = tab.selection.map(transaction.changes);
    }
    for (const [view, tab] of this.mounted) {
      if (view === origin && !selectOrigin) continue;
      const update = view.state.update({ changes: transaction.changes,
        selection: view === origin && selectOrigin ? transaction.newSelection : tab.selection,
        annotations: Transaction.addToHistory.of(false), scrollIntoView: view === origin && selectOrigin });
      view.update([update]); tab.selection = view.state.selection;
    }
  }
  runHistory(command: StateCommand, origin?: EditorView) {
    if (this.blocked() || this.editingBlocked()) return false;
    return command({ state: this.state, dispatch: transaction => {
      this.state = transaction.state; this.broadcast(transaction, origin, true); this.changed();
    } });
  }
  private changed() {
    this.textRef.current = this.state.doc.toString(); this.revision++;
    this.label = this.conflict ? '外部冲突' : sameNoteContent(this.text, this.note.content) ? '已保存' : '编辑中';
    this.saveDue = Date.now() + 900; this.recoveryDue = Date.now() + 400;
    this.edited(this); this.notify();
  }
  setNote = (note: NoteRead) => { this.noteRef.current = note; this.notify(); };
  setConflict = (value: (SaveNoteResult & { conflict: true }) | null) => { this.conflictRef.current = value; this.notify(); };
  setLabel = (value: SaveLabel) => { this.label = value; this.notify(); };
  replaceText = (text: string) => {
    this.persistence.invalidate(); this.documentId.current = ++sequence;
    const previous = this.state;
    this.state = EditorState.create({ doc: text, extensions: [history(), EditorState.allowMultipleSelections.of(true)] });
    const change = previous.update({ changes: { from: 0, to: previous.doc.length, insert: this.state.doc }, annotations: Transaction.addToHistory.of(false) });
    this.broadcast(change); this.textRef.current = this.state.doc.toString(); this.revision++;
    this.label = sameNoteContent(this.text, this.note.content) ? '已保存' : '编辑中';
    this.saveDue = Date.now() + 900; this.recoveryDue = Date.now() + 400; this.notify(); this.trace('replace');
  };
  snapshot = () => ({ note: this.note, text: this.text, revision: this.revision });
  flushRecovery = async () => {
    if (this.blocked() || sameNoteContent(this.text, this.note.content)) return;
    const revision = this.revision;
    await this.api().writeRecovery({ sourcePath: this.note.path, paneHint: this.paneHint,
      recoveryId: this.recoveryId, baseHash: this.note.hash, content: this.text, encoding: { bom: this.note.bom, eol: this.note.eol } });
    this.trace('recovery', { revision });
  };
  save = () => this.persistence.save({ snapshot: this.snapshot, blocked: this.blocked, recovery: this.flushRecovery,
    recoveryError: () => this.message('恢复稿暂时无法更新，正在继续保存正文。'),
    write: snapshot => { this.trace('save.submit', { submittedRevision: snapshot.revision }); return this.api().saveNote({ ...snapshot.note!, content: snapshot.text, recoveryId: this.recoveryId }); },
    saving: () => this.setLabel('保存中'), clean: () => this.setLabel('已保存'),
    conflict: result => { this.conflictRef.current = result; this.label = '外部冲突'; this.trace('save.conflict'); this.notify(); },
    commit: (result, submitted) => {
      this.noteRef.current = { ...submitted.note!, content: result.content, hash: result.hash };
      this.committedRevision = submitted.revision;
      this.label = sameNoteContent(this.text, result.content) ? '已保存' : '编辑中';
      this.trace('save.commit', { submittedRevision: submitted.revision }); this.notify();
    },
    error: error => { this.label = '保存失败'; this.trace('save.error'); this.message(`保存失败：${String(error)}`); this.notify(); },
  });
  async poll() {
    if (this.polling || this.blocked()) return;
    this.polling = true; this.lastPoll = Date.now();
    try { await this.persistence.poll({ snapshot: this.snapshot, blocked: this.blocked, read: path => this.api().readNote(path), apply: (disk, conflict) => {
      if (conflict) { this.conflictRef.current = { ...disk, conflict: true }; this.label = '外部冲突'; this.trace('poll.conflict'); }
      else { this.noteRef.current = disk; if (!sameNoteContent(disk.content, this.text)) this.replaceText(disk.content); this.label = '已保存'; this.trace('poll.reload'); }
      this.notify();
    } }); } catch { this.trace('poll.error'); } finally { this.polling = false; }
  }
  async hydrateRecovery(id = this.recoveryId) {
    try {
      const recovery = await this.api().checkRecovery({ sourcePath: this.note.path, recoveryId: id });
      if (recovery.status === 'recoverable') this.replaceText(recovery.recovery.content);
      else if (recovery.status === 'conflict') { this.recoveryConflict = { note: recovery.note, recovery: recovery.recovery, recoveryId: id }; this.label = '外部冲突'; }
      else if (recovery.status === 'corrupt') { this.retainRecovery(this.note.path, id); this.recoveryId = crypto.randomUUID(); this.message(`恢复稿损坏但已保留：${this.note.path}`); }
    } catch { throw new Error(`无法读取笔记恢复稿，已停止打开以保护原稿：${this.note.path}`); }
    this.ready = true; this.notify();
  }
  retainRecovery(sourcePath: string, recoveryId: string) {
    if (!this.recoveryReferences.some(item => item.recoveryId === recoveryId && item.sourcePath.toLocaleLowerCase() === sourcePath.toLocaleLowerCase()))
      this.recoveryReferences.push({ sourcePath, recoveryId });
  }
  remapRecoveryReferences(previous: string, next: string, remap: (path: string, previous: string, next: string) => string) {
    this.recoveryReferences = this.recoveryReferences.map(item => ({ ...item, sourcePath: remap(item.sourcePath, previous, next) }));
  }
  async clearRecovery(content?: string, sourcePath = this.note.path, recoveryId = this.recoveryId) {
    const result = await this.api().checkRecovery({ sourcePath, recoveryId });
    if (result.status === 'corrupt') throw new Error('恢复稿已损坏且无法安全清理，原稿已保留');
    if (result.status === 'recoverable' || result.status === 'conflict') {
      if (content !== undefined && !sameNoteContent(content, result.recovery.content)) throw new Error('恢复稿内容已变化，未清理原稿');
      const removed = await this.api().deleteRecovery({ sourcePath, recoveryId, draftHash: result.recovery.draftHash });
      if (!removed) throw new Error('恢复稿在清理前发生变化，未放弃修改');
    }
  }
  async discardChanges() {
    const conflict = this.recoveryConflict;
    if (conflict) await this.clearRecovery(conflict.recovery.content, this.note.path, conflict.recoveryId);
    else await this.clearRecovery(this.text);
    this.replaceText(this.note.content);
    this.conflictRef.current = null; this.recoveryConflict = null;
    this.label = '已保存'; this.notify();
  }
  async completeSaveAs(note: NoteRead, submitted: string, submittedRevision: number, recovering: boolean) {
    const oldPath = this.note.path, oldId = this.recoveryConflict?.recoveryId || this.recoveryId;
    await this.clearRecovery(submitted, oldPath, oldId);
    this.recoveryId = crypto.randomUUID();
    this.relocate(note);
    this.conflictRef.current = null; this.recoveryConflict = null;
    // Do not replace text typed while the Save As dialog/write was pending.
    if (recovering && this.revision === submittedRevision) this.replaceText(submitted);
    this.label = sameNoteContent(this.text, note.content) ? '已保存' : '编辑中';
    this.saveDue = this.label === '已保存' ? Infinity : Date.now() + 900;
    this.recoveryDue = this.label === '已保存' ? Infinity : Date.now() + 400;
    this.notify();
  }
  async keepMine() {
    if (this.recoveryConflict) {
      const item = this.recoveryConflict; this.noteRef.current = item.note; this.replaceText(item.recovery.content);
      this.recoveryId = item.recoveryId; this.recoveryConflict = null;
    } else if (this.conflict) { this.noteRef.current = { ...this.conflict }; this.conflictRef.current = null; }
    return this.save();
  }
  async useDisk() {
    const disk = this.recoveryConflict?.note || this.conflict || this.note;
    if (this.recoveryConflict) await this.clearRecovery(this.recoveryConflict.recovery.content, this.note.path, this.recoveryConflict.recoveryId);
    else await this.clearRecovery(this.text);
    this.recoveryConflict = null; this.conflictRef.current = null;
    this.noteRef.current = disk; this.replaceText(disk.content); this.label = '已保存'; this.notify();
  }
  relocate(note: NoteRead) {
    this.persistence.invalidate(); this.documentId.current = ++sequence; this.noteRef.current = note; this.notify();
  }
  dispose() { this.disposed = true; this.persistence.disposed = true; this.persistence.invalidate(); }
}
