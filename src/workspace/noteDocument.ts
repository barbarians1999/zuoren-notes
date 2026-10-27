import { EditorSelection, EditorState, Transaction, type Annotation, type StateCommand } from '@codemirror/state';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { NoteRead, ReaderApi, RecoveryReference, RecoveryV1, SaveNoteResult } from '../types';
import type { SaveLabel } from '../readerContext';
import { DocumentPersistence } from '../documentPersistence.cjs';
import { sameNoteContent } from '../noteContent.cjs';
import { diagnostics } from '../diagnostics.cjs';
import { formatContinuation, markdownHistory } from '../editor/markdownFormatHistory';

export type NoteViewState = {
  id: string; document: NoteDocument | null; preview: boolean; mode: 'edit' | 'preview';
  selection: EditorSelection; scroll: { edit: number; preview: number };
};
export type ImagePasteSnapshot = { id: string; documentId: number; notePath: string; from: number; to: number; replaceValid: boolean };
export type PendingImagePaste = { id: string; notePath: string; name: string; phase: 'reading' | 'attachment' | 'reference' | 'body' | 'identity'; retryAllowed: boolean; error?: string; savedPath?: string };
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
  private imageAnchors = new Map<string, ImagePasteSnapshot>();
  private imageQueue: Array<{ id: string; name: string; extension: string; size: number; read: () => Promise<Uint8Array>; data?: Uint8Array; anchor: ImagePasteSnapshot; savedPath?: string; inserted: boolean; phase: PendingImagePaste['phase']; error?: string }> = [];
  private imageRunning = false;
  private imageWaiters: Array<() => void> = [];
  private imageAccepting = true;
  private imageBytes = 0;
  constructor(note: NoteRead, recoveryId: string, private api: () => ReaderApi,
    private barrier: { has(path: string): boolean }, private notify: () => void,
    private edited: (doc: NoteDocument) => void, private message: (text: string) => void,
    public paneHint: 'primary' | 'secondary' = 'primary', private allowEdits: () => boolean = () => true) {
    this.noteRef = { current: note }; this.recoveryId = recoveryId;
    this.state = EditorState.create({ doc: note.content, extensions: [markdownHistory(), EditorState.allowMultipleSelections.of(true)] });
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
        const continuation = transaction.annotation(formatContinuation);
        if (continuation !== undefined) annotations.push(formatContinuation.of(continuation));
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
    this.mapImageAnchors(transaction);
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
  private mapImageAnchors(transaction: Transaction) {
    if (!transaction.docChanged) return;
    for (const [id, anchor] of this.imageAnchors) {
      let touched = false;
      transaction.changes.iterChanges((fromA, toA) => {
        if (anchor.from === anchor.to ? fromA <= anchor.from && toA >= anchor.from : fromA <= anchor.to && toA >= anchor.from) touched = true;
      });
      const map = transaction.changes;
      this.imageAnchors.set(id, { ...anchor, from: map.mapPos(anchor.from, anchor.from === anchor.to ? 1 : -1),
        to: map.mapPos(anchor.to, 1), replaceValid: anchor.replaceValid && !touched });
    }
  }
  captureImagePaste(selection: { from: number; to: number }) {
    const id = crypto.randomUUID(), anchor = { id, documentId: this.documentId.current, notePath: this.note.path,
      from: selection.from, to: selection.to, replaceValid: true };
    this.imageAnchors.set(id, anchor); return anchor;
  }
  get pendingImagePastes(): PendingImagePaste[] {
    return this.imageQueue.map(item => ({ id: item.id, notePath: item.anchor.notePath, name: item.name, phase: item.phase,
      retryAllowed: item.phase !== 'identity',
      ...(item.error ? { error: item.error } : {}), ...(item.savedPath ? { savedPath: item.savedPath } : {}) }));
  }
  get hasImageWork() { return this.imageRunning || this.imageQueue.length > 0; }
  enqueueImagePaste(input: { name: string; extension?: string; size: number; read: () => Promise<Uint8Array>; selection?: { from: number; to: number }; anchor?: ImagePasteSnapshot }) {
    if (!this.imageAccepting) throw new Error('笔记正在保存或迁移，暂时不能接收图片');
    if (input.size < 1 || input.size > 20 * 1024 * 1024) throw new Error('图片须为 20 MiB 以内的 PNG、JPEG 或 WebP');
    if (this.imageQueue.length >= 8 || this.imageBytes + input.size > 40 * 1024 * 1024) throw new Error('图片粘贴队列已满，请稍后重试');
    const extension = (input.extension || imageExtension(input.name)).toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(extension)) throw new Error('只支持 PNG、JPEG 或 WebP 图片');
    const anchor = input.anchor || this.captureImagePaste(input.selection || { from: 0, to: 0 }), id = anchor.id;
    this.imageBytes += input.size;
    this.imageQueue.push({ id, name: input.name, extension, size: input.size, read: input.read, anchor, inserted: false, phase: 'reading' });
    this.notify(); void this.pumpImageQueue(); return id;
  }
  releaseImageAnchor(id: string) { this.imageAnchors.delete(id); }
  stopImagePastes() { this.imageAccepting = false; }
  resumeImagePastes() { if (!this.disposed) this.imageAccepting = true; }
  async drainImagePastes(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (this.imageQueue.length || this.imageRunning) {
      const first = this.imageQueue[0];
      if (first?.error) return false;
      if (!this.imageRunning) void this.pumpImageQueue();
      const completed = await new Promise<boolean>(resolve => {
        let done = false;
        const finish = (value: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
        const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
        this.imageWaiters.push(() => finish(true));
      });
      if (!completed) {
        if (first) first.error = `等待图片处理超过 ${Math.ceil(timeoutMs / 1000)} 秒，任务仍在后台运行；可稍后重试或取消。`;
        else this.message(`等待已取消的图片操作超过 ${Math.ceil(timeoutMs / 1000)} 秒；后台写入仍在进行。`);
        this.notify(); return false;
      }
    }
    return true;
  }
  retryImagePaste(id: string) { const item = this.imageQueue.find(item => item.id === id); if (!item || item.phase === 'identity') return false; item.error = undefined; void this.pumpImageQueue(); return true; }
  cancelImagePaste(id: string) { const index = this.imageQueue.findIndex(item => item.id === id); if (index < 0) return false; const [item] = this.imageQueue.splice(index, 1); this.imageBytes -= item.size; this.imageAnchors.delete(id); this.notify(); void this.pumpImageQueue(); return true; }
  private async pumpImageQueue() {
    if (this.imageRunning) return;
    this.imageRunning = true;
    try {
      while (this.imageQueue.length) {
        const item = this.imageQueue[0]; if (item.error) return;
        try {
          if (!item.savedPath) {
            if (item.anchor.documentId !== this.documentId.current || item.anchor.notePath !== this.note.path) { item.phase = 'identity'; throw new Error('笔记身份已变化，附件保留；请取消或手动处理'); }
            if (item.phase === 'reading') {
              const data = await item.read();
              if (this.imageQueue[0] !== item) return;
              if (data.byteLength !== item.size || data.byteLength > 20 * 1024 * 1024) throw new Error('剪贴板图片大小发生变化，未插入');
              item.data = data;
            }
            if (item.anchor.documentId !== this.documentId.current || item.anchor.notePath !== this.note.path) { item.phase = 'identity'; throw new Error('笔记身份已变化，未保存附件；请取消并手动处理'); }
            if (this.blocked()) { item.phase = 'attachment'; throw new Error('笔记当前处于冲突或变更保护状态；处理后可重试保存附件'); }
            item.phase = 'attachment'; this.notify();
            item.savedPath = await this.api().saveAttachment({ sourcePath: item.anchor.notePath, data: item.data!, extension: item.extension, purpose: 'note-image' });
            if (this.imageQueue[0] !== item) {
              this.message(`图片附件已保存到 ${item.savedPath}；插入已取消，可手动使用该文件。`); return;
            }
            this.imageBytes -= item.size; item.size = 0; item.data = undefined; item.read = async () => new Uint8Array();
          }
          if (!item.inserted) {
            if (item.anchor.documentId !== this.documentId.current || item.anchor.notePath !== this.note.path) { item.phase = 'identity'; throw new Error('笔记身份已变化，附件保留；请取消或手动处理'); }
            item.phase = 'reference'; this.notify();
            if (this.blocked()) throw new Error('笔记当前处于冲突或变更保护状态；处理后可重试插入');
            const anchor = this.imageAnchors.get(item.id) || item.anchor;
            const at = anchor.replaceValid ? anchor.from : anchor.to;
            const to = anchor.replaceValid ? anchor.to : at;
            this.insertImageReference(at, to, imageMarkdown(item.savedPath)); item.inserted = true;
          }
          if (item.anchor.documentId !== this.documentId.current || item.anchor.notePath !== this.note.path) { item.phase = 'identity'; throw new Error('笔记身份已变化，已保存的附件和引用保留；请手动处理或取消'); }
          item.phase = 'body'; this.notify();
          if (!(await this.save())) throw new Error('正文保存失败，可重试');
          if (item.anchor.documentId !== this.documentId.current || item.anchor.notePath !== this.note.path) { item.phase = 'identity'; throw new Error('保存期间笔记身份已变化，附件保留；请手动处理或取消'); }
          if (this.imageQueue[0] !== item) return;
          this.imageQueue.shift(); this.imageAnchors.delete(item.id); this.notify();
        } catch (error) { if (this.imageQueue.includes(item)) { item.error = String(error); this.notify(); } return; }
      }
    } finally {
      this.imageRunning = false; for (const resolve of this.imageWaiters.splice(0)) resolve();
      if (this.imageQueue.length && !this.imageQueue[0].error) void this.pumpImageQueue();
    }
  }
  private insertImageReference(from: number, to: number, text: string) {
    const transaction = this.state.update({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length),
      annotations: [Transaction.userEvent.of('input.paste'), isolateHistory.of('full')] });
    this.state = transaction.state; this.broadcast(transaction, undefined, false); this.changed();
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
    this.state = EditorState.create({ doc: text, extensions: [markdownHistory(), EditorState.allowMultipleSelections.of(true)] });
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

function imageExtension(name: string) {
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'png' || extension === 'jpg' || extension === 'jpeg' || extension === 'webp') return extension;
  throw new Error('只支持 PNG、JPEG 或 WebP 图片');
}
function imageMarkdown(path: string) {
  const escaped = path.split(/[\\/]/).map(part => encodeURIComponent(part)).join('/');
  return `![图片](${escaped})`;
}
