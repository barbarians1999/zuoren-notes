import { EditorSelection } from '@codemirror/state';
import type { NoteSessionGroup, ReaderApi, ReaderSession, ReaderSessionV3 } from '../types';
import { remapDescendantPath, sameOrDescendantPath } from '../fileOperations.cjs';
import { filePathKey } from '../pathIdentity.cjs';
import { sameNoteContent } from '../noteContent.cjs';
import { NoteDocument, type NoteViewState } from './noteDocument';
export type NoteGroupId = 'primary' | 'secondary';
type Group = { tabs: NoteViewState[]; activeId: string | null };
export const documentKey = filePathKey;
export class NoteWorkspace {
  groups: Record<NoteGroupId, Group> = { primary: { tabs: [], activeId: null }, secondary: { tabs: [], activeId: null } };
  activeGroup: NoteGroupId = 'primary';
  private focusId: string | null = null;
  get focusRequest() { return this.focusId; }
  documents = new Map<string, NoteDocument>();
  blockingDocument: NoteDocument | null = null;
  pendingClose: { group: NoteGroupId; tab: NoteViewState } | null = null;
  ready = false;
  committing = false;
  private loads = new Map<string, Promise<NoteDocument>>();
  private requests = { primary: 0, secondary: 0 };
  private interaction = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private pollCursor = 0;
  constructor(private api: () => ReaderApi, private barrier: { has(path: string): boolean }, private message: (message: string) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.version;
  notify = () => { this.version++; for (const listener of this.listeners) listener(); };
  report = (error: unknown) => this.message(String(error));
  current(group = this.activeGroup) { const value = this.groups[group]; return value.tabs.find(tab => tab.id === value.activeId) || null; }
  currentDocument(group = this.activeGroup) { return this.current(group)?.document || null; }
  activate(group: NoteGroupId, id?: string) {
    if (id && !this.groups[group].tabs.some(tab => tab.id === id)) return;
    this.interaction++;
    // Focusing another pane supersedes a queued tab-open focus request. A
    // delayed animation frame must not steal focus back to the previous pane.
    this.focusId = id || null;
    this.activeGroup = group; if (id) { this.invalidate(group); this.groups[group].activeId = id; } this.notify();
  }
  pin(tab: NoteViewState) { if (tab.preview) { tab.preview = false; this.notify(); } }
  consumeFocus(id: string) {
    if (this.focusId !== id) return false;
    this.focusId = null; return true;
  }
  setMode(group: NoteGroupId, id: string, mode: NoteViewState['mode']) {
    const tab = this.groups[group].tabs.find(item => item.id === id);
    if (!tab || tab.mode === mode) return;
    tab.mode = mode; this.notify();
  }
  captureExcerptTarget() {
    const group = this.activeGroup, tab = this.current(group), doc = tab?.document;
    if (!tab || !doc || doc.blocked() || doc.editingBlocked()) return null;
    const identity = doc.documentId.current;
    return { group, tab, doc, path: doc.note.path,
      valid: () => this.activeGroup === group && this.current(group) === tab && tab.document === doc && doc.documentId.current === identity && !doc.blocked() && !doc.editingBlocked() };
  }
  private edited = (doc: NoteDocument) => { for (const tab of doc.views) tab.preview = false; };
  async load(path: string, recoveryId: string = crypto.randomUUID(), pane: NoteGroupId = 'primary') {
    const key = documentKey(path), found = this.documents.get(key);
    if (found) { await found.initialized; return found; }
    const pending = this.loads.get(key); if (pending) return pending;
    const promise = (async () => {
      const note = await this.api().readNote(path), realKey = documentKey(note.path);
      const existing = this.documents.get(realKey); if (existing) { await existing.initialized; return existing; }
      const doc = new NoteDocument(note, recoveryId, this.api, this.barrier, this.notify, this.edited, this.message, pane, () => !this.committing);
      this.documents.set(realKey, doc);
      doc.initialized = doc.hydrateRecovery();
      try { await doc.initialized; return doc; }
      catch (error) { doc.dispose(); this.documents.delete(realKey); throw error; }
    })();
    this.loads.set(key, promise);
    try { return await promise; } finally { if (this.loads.get(key) === promise) this.loads.delete(key); }
  }
  private newTab(doc: NoteDocument | null, preview: boolean): NoteViewState {
    const tab = { id: crypto.randomUUID(), document: doc, preview: preview && (!doc || sameNoteContent(doc.text, doc.note.content)),
      mode: 'edit' as const, selection: EditorSelection.single(0), scroll: { edit: 0, preview: 0 } };
    doc?.views.add(tab); return tab;
  }
  blank(group = this.activeGroup) {
    if (this.committing) return null;
    if (this.groups.primary.tabs.length + this.groups.secondary.tabs.length >= 100) { this.message('最多可打开 100 个标签，请先关闭一些标签。'); return null; }
    const tab = this.newTab(null, false); this.groups[group].tabs.push(tab); this.activate(group, tab.id); return tab;
  }
  async open(path: string, group = this.activeGroup, pinned = false, recoveryId?: string, prepare?: () => Promise<boolean>) {
    if (this.committing) return null;
    const request = ++this.requests[group];
    const interaction = ++this.interaction;
    if (prepare && !(await prepare())) return null;
    if (request !== this.requests[group]) return null;
    const doc = await this.load(path, recoveryId, group);
    if (request !== this.requests[group]) return null;
    const target = this.groups[group];
    const existing = target.tabs.find(tab => tab.document === doc);
    if (existing) { if (pinned) existing.preview = false; this.completeOpen(group, existing, interaction); return existing; }
    const empty = this.current(group); let replace = empty && !empty.document ? empty : !pinned ? target.tabs.find(tab => tab.preview) : undefined;
    if (!replace && this.groups.primary.tabs.length + this.groups.secondary.tabs.length >= 100) { this.releaseUnused(doc); this.message('最多可打开 100 个标签，请先关闭一些标签。'); return null; }
    if (replace?.document && replace.document.views.size === 1 && !(await replace.document.save())) {
      this.blockingDocument = replace.document; this.message('原临时笔记未保存成功，已保留。'); this.notify(); return null;
    }
    if (request !== this.requests[group]) return null;
    if (replace?.document && !replace.preview) replace = undefined;
    if (!replace && this.groups.primary.tabs.length + this.groups.secondary.tabs.length >= 100) { this.message('最多可打开 100 个标签，请先关闭一些标签。'); return null; }
    const tab = this.newTab(doc, !pinned);
    if (replace) { const index = target.tabs.indexOf(replace); target.tabs.splice(index, 1, tab); replace.document?.views.delete(replace); if (replace.document) this.releaseUnused(replace.document); }
    else target.tabs.push(tab);
    this.completeOpen(group, tab, interaction); return tab;
  }
  private completeOpen(group: NoteGroupId, tab: NoteViewState, interaction: number) {
    if (interaction === this.interaction) this.activate(group, tab.id);
    else { this.groups[group].activeId = tab.id; this.notify(); }
  }
  invalidate(group: NoteGroupId) { this.requests[group]++; }
  private releaseUnused(doc: NoteDocument) {
    if (doc.views.size || !sameNoteContent(doc.text, doc.note.content) || doc.conflict || doc.recoveryConflict) return;
    doc.dispose(); this.documents.delete(documentKey(doc.note.path));
  }
  private normalizeGroups() {
    if (!this.groups.primary.tabs.length && this.groups.secondary.tabs.length) {
      this.invalidate('primary'); this.invalidate('secondary');
      this.groups.primary = this.groups.secondary; this.groups.secondary = { tabs: [], activeId: null }; this.activeGroup = 'primary';
    }
    if (!this.groups.secondary.tabs.length) this.activeGroup = 'primary';
  }
  private remove(group: NoteGroupId, tab: NoteViewState, release = true) {
    const value = this.groups[group], index = value.tabs.indexOf(tab); if (index < 0) return;
    value.tabs.splice(index, 1);
    if (value.activeId === tab.id) value.activeId = value.tabs[index]?.id || value.tabs[index - 1]?.id || null;
    if (release) { tab.document?.views.delete(tab); if (tab.document) this.releaseUnused(tab.document); }
  }
  async close(group: NoteGroupId, tab: NoteViewState) {
    if (this.committing) return false;
    this.invalidate(group);
    const doc = tab.document;
    if (doc && doc.views.size === 1 && !(await doc.save())) {
      this.pendingClose = { group, tab }; this.blockingDocument = doc; this.notify(); return false;
    }
    this.remove(group, tab); this.normalizeGroups(); this.notify(); return true;
  }
  async finishPendingClose(discard = false) {
    const item = this.pendingClose; if (!item) return;
    const doc = item.tab.document;
    if (discard && doc && doc.views.size === 1) {
      try { await doc.discardChanges(); }
      catch (error) { this.message(`恢复稿清理失败，标签和内容仍保留：${error instanceof Error ? error.message : String(error)}`); this.notify(); return; }
    }
    this.pendingClose = null; this.blockingDocument = null; await this.close(item.group, item.tab);
  }
  move(source: NoteGroupId, id: string, target: NoteGroupId, beforeId?: string, after = false) {
    const tab = this.groups[source].tabs.find(item => item.id === id); if (!tab) return;
    if (source === target && beforeId === id) return;
    this.invalidate(source); this.invalidate(target); tab.preview = false;
    const value = this.groups[target], duplicate = source !== target && tab.document ? value.tabs.find(item => item.document === tab.document) : null;
    this.remove(source, tab, false);
    if (duplicate) { duplicate.preview = false; tab.document?.views.delete(tab); value.activeId = duplicate.id; }
    else { const at = beforeId ? value.tabs.findIndex(item => item.id === beforeId) : -1; value.tabs.splice(at < 0 ? value.tabs.length : at + (after ? 1 : 0), 0, tab); value.activeId = tab.id; }
    this.activeGroup = target; this.normalizeGroups(); this.notify();
  }
  merge() {
    this.invalidate('primary'); this.invalidate('secondary');
    const rightActive = this.activeGroup === 'secondary' ? this.current('secondary') : null;
    for (const tab of this.groups.secondary.tabs) {
      tab.preview = false;
      const duplicate = tab.document && this.groups.primary.tabs.find(item => item.document === tab.document);
      if (duplicate) {
        if (tab === rightActive) { duplicate.mode = tab.mode; duplicate.selection = tab.selection; duplicate.scroll = tab.scroll; this.groups.primary.activeId = duplicate.id; }
        tab.document?.views.delete(tab);
      } else { this.groups.primary.tabs.push(tab); if (tab === rightActive) this.groups.primary.activeId = tab.id; }
    }
    this.groups.secondary = { tabs: [], activeId: null }; this.normalizeGroups(); this.activeGroup = 'primary'; this.notify();
  }
  swap() {
    if (!this.groups.secondary.tabs.length) return;
    this.invalidate('primary'); this.invalidate('secondary');
    [this.groups.primary, this.groups.secondary] = [this.groups.secondary, this.groups.primary];
    this.activeGroup = this.activeGroup === 'primary' ? 'secondary' : 'primary'; this.notify();
  }
  cycle(group: NoteGroupId, direction: number) {
    const value = this.groups[group]; if (!value.tabs.length) return;
    const index = value.tabs.findIndex(tab => tab.id === value.activeId);
    this.activate(group, value.tabs[(index + direction + value.tabs.length) % value.tabs.length].id);
  }
  async saveAll() {
    while (true) {
      await Promise.allSettled([...this.loads.values()]);
      const revisions = new Map([...this.documents.values()].map(doc => [doc, doc.revision]));
      for (const doc of revisions.keys()) {
        if (!(await doc.save())) { this.blockingDocument = doc;
          for (const group of ['primary', 'secondary'] as const) { const tab = this.groups[group].tabs.find(tab => tab.document === doc); if (tab) { this.activate(group, tab.id); break; } }
          this.notify(); return false;
        }
      }
      if (!this.loads.size && revisions.size === this.documents.size && [...this.documents.values()].every(doc => revisions.get(doc) === doc.revision)) return true;
    }
  }
  beginCommit() {
    if (this.committing) return null;
    this.committing = true;
    this.invalidate('primary'); this.invalidate('secondary'); this.notify();
    let released = false;
    return () => { if (!released) { released = true; this.committing = false; this.notify(); } };
  }
  tick() {
    if (!this.ready) return;
    const now = Date.now(), docs = [...this.documents.values()];
    for (const doc of docs) {
      if (!doc.views.size && !this.loads.size) { this.releaseUnused(doc); if (doc.disposed) continue; }
      if (doc.recoveryDue <= now) { doc.recoveryDue = Infinity; void doc.flushRecovery().catch(() => this.message('恢复稿暂时无法保存，正文仍会继续保存。')); }
      if (doc.saveDue <= now) { doc.saveDue = Infinity; void doc.save(); }
    }
    if (docs.length) { const doc = docs[this.pollCursor++ % docs.length]; if (now - doc.lastPoll >= 3000) void doc.poll(); }
  }
  remap(previous: string, next: string) {
    for (const [key, doc] of [...this.documents]) if (sameOrDescendantPath(doc.note.path, previous)) {
      this.documents.delete(key); doc.remapRecoveryReferences(previous, next, remapDescendantPath);
      doc.relocate({ ...doc.note, path: remapDescendantPath(doc.note.path, previous, next) }); this.documents.set(documentKey(doc.note.path), doc);
    }
    // A retained draft can belong to a note that is no longer open.
    for (const doc of this.documents.values()) doc.remapRecoveryReferences(previous, next, remapDescendantPath);
    this.notify();
  }
  forget(path: string) {
    for (const group of ['primary', 'secondary'] as const) for (const tab of [...this.groups[group].tabs])
      if (tab.document && sameOrDescendantPath(tab.document.note.path, path)) this.remove(group, tab);
    this.normalizeGroups(); this.notify();
  }
  async saveAs(doc: NoteDocument) {
    const recovering = doc.recoveryConflict;
    const submitted = recovering ? recovering.recovery.content : doc.text;
    const submittedRevision = doc.revision;
    const oldKey = documentKey(doc.note.path);
    const note = await this.api().saveAs({ sourcePath: doc.note.path, suggestedName: doc.note.path.split(/[\\/]/).pop(), content: submitted });
    if (!note) return false;
    const existing = this.documents.get(documentKey(note.path));
    if (existing && existing !== doc) { this.message('副本已保存，但该路径已在另一标签打开；原笔记和草稿仍保留。'); return false; }
    try { await doc.completeSaveAs(note, submitted, submittedRevision, !!recovering); }
    catch (error) { this.message(`副本已保存，但恢复稿迁移未完成；原笔记会话和恢复稿仍保留：${error instanceof Error ? error.message : String(error)}`); return false; }
    this.documents.delete(oldKey); this.documents.set(documentKey(note.path), doc); this.notify(); return true;
  }
  sessionFields(): Pick<ReaderSessionV3, 'noteGroups' | 'activeNoteGroup' | 'noteDocuments' | 'noteTabs' | 'primaryNote' | 'secondaryNote'> {
    const group = (id: NoteGroupId): NoteSessionGroup => ({ activeId: this.groups[id].activeId, tabs: this.groups[id].tabs.map(tab => ({
      id: tab.id, path: tab.document?.note.path || null, mode: tab.mode, preview: tab.preview,
      selection: { anchor: tab.selection.main.anchor, head: tab.selection.main.head }, scroll: { ...tab.scroll },
    })) });
    const note = (id: NoteGroupId) => { const tab = this.current(id); return tab?.document ? { path: tab.document.note.path, mode: tab.mode, recoveryId: tab.document.recoveryId } : null; };
    const docs = [...this.documents.values()].filter(doc => doc.views.size);
    return { noteGroups: { primary: group('primary'), secondary: group('secondary') }, activeNoteGroup: this.activeGroup,
      noteDocuments: docs.map(doc => ({ path: doc.note.path, recoveryId: doc.recoveryId,
        retainedRecoveries: doc.recoveryReferences.map(item => ({ ...item })) })), noteTabs: docs.map(doc => doc.note.path), primaryNote: note('primary'), secondaryNote: note('secondary') };
  }
  async restore(session: ReaderSession) {
    const requests = { ...this.requests }, interaction = this.interaction;
    const restoreTab = (group: NoteGroupId, doc: NoteDocument | null, preview: boolean, id?: string) => {
      const tabs = this.groups[group].tabs;
      if (tabs.some(tab => id && tab.id === id || doc && tab.document === doc)) return null;
      if (this.groups.primary.tabs.length + this.groups.secondary.tabs.length >= 100) return null;
      const tab = this.newTab(doc, preview && !tabs.some(item => item.preview));
      if (id) tab.id = id;
      tabs.push(tab); return tab;
    };
    if (session.version === 3) {
      for (const item of session.noteDocuments) { try {
        const doc = await this.load(item.path, item.recoveryId);
        const references = 'retainedRecoveries' in item ? item.retainedRecoveries
          : item.retainedRecoveryIds.map(recoveryId => ({ sourcePath: item.path, recoveryId }));
        for (const reference of references) doc.retainRecovery(reference.sourcePath, reference.recoveryId);
      } catch { this.message(`笔记不可用，恢复稿保留，已跳过：${item.path}`); } }
      for (const id of ['primary', 'secondary'] as const) {
        for (const saved of session.noteGroups[id].tabs) {
          const doc = saved.path ? this.documents.get(documentKey(saved.path)) : null; if (saved.path && !doc) continue;
          const tab = restoreTab(id, doc || null, saved.preview, saved.id); if (!tab) continue;
          tab.mode = saved.mode;
          const length = doc?.state.doc.length || 0;
          tab.selection = EditorSelection.single(Math.min(length, saved.selection.anchor), Math.min(length, saved.selection.head)); tab.scroll = { ...saved.scroll };
        }
        const value = this.groups[id];
        if (requests[id] === this.requests[id]) value.activeId = value.tabs.some(tab => tab.id === session.noteGroups[id].activeId) ? session.noteGroups[id].activeId : value.tabs[0]?.id || null;
        else value.activeId ||= value.tabs[0]?.id || null;
      }
      if (interaction === this.interaction) this.activeGroup = session.activeNoteGroup;
    } else {
      const active = [session.primaryNote, session.secondaryNote];
      const paths = [...new Map([...session.noteTabs, ...active.flatMap(note => note ? [note.path] : [])].map(path => [documentKey(path), path])).values()];
      for (const path of paths) {
        const saved = active.find(note => note && documentKey(note.path) === documentKey(path));
        try { await this.load(path, saved?.recoveryId); } catch { this.message(`笔记不可用，恢复稿保留，已跳过：${path}`); }
      }
      // V1/V2 could own two independent drafts for the same file. Never
      // merge or overwrite the second draft; retain its ID and offer a copy.
      if (session.primaryNote && session.secondaryNote && documentKey(session.primaryNote.path) === documentKey(session.secondaryNote.path)
        && session.primaryNote.recoveryId !== session.secondaryNote.recoveryId) {
        const doc = this.documents.get(documentKey(session.primaryNote.path)), id = session.secondaryNote.recoveryId;
        if (doc) {
          const recovery = await this.api().checkRecovery({ sourcePath: doc.note.path, recoveryId: id });
          if (recovery.status === 'recoverable' || recovery.status === 'conflict' || recovery.status === 'corrupt') {
            doc.retainRecovery(doc.note.path, id); this.message('旧版同笔记存在另一份恢复稿，已保留，可从标签栏“旧恢复稿副本”另存查看。');
          }
        }
      }
      for (const path of paths) {
        const doc = this.documents.get(documentKey(path)); if (!doc) continue;
        const right = session.secondaryNote && documentKey(path) === documentKey(session.secondaryNote.path);
        if (!right || session.primaryNote && documentKey(path) === documentKey(session.primaryNote.path)) {
          const tab = restoreTab('primary', doc, false);
          if (tab && session.primaryNote && documentKey(path) === documentKey(session.primaryNote.path)) {
            if (requests.primary === this.requests.primary) this.groups.primary.activeId = tab.id;
            tab.mode = session.primaryNote.mode === 'preview' ? 'preview' : 'edit';
          }
        }
        if (right) { const tab = restoreTab('secondary', doc, false); if (tab) {
          tab.mode = session.secondaryNote!.mode === 'preview' ? 'preview' : 'edit';
          if (requests.secondary === this.requests.secondary) this.groups.secondary.activeId = tab.id;
        } }
      }
      this.groups.primary.activeId ||= this.groups.primary.tabs[0]?.id || null;
      this.groups.secondary.activeId ||= this.groups.secondary.tabs[0]?.id || null;
      if (session.version === 2) for (const entry of session.scrollMemory) {
        if (requests[entry.pane] !== this.requests[entry.pane]) continue;
        const tab = this.groups[entry.pane].tabs.find(tab => tab.document && documentKey(tab.document.note.path) === documentKey(entry.path)); if (tab) tab.scroll[entry.mode] = entry.scrollTop;
      }
    }
    this.normalizeGroups(); this.notify();
  }
  async copyRetainedRecovery(doc: NoteDocument) {
    for (const reference of doc.recoveryReferences) {
      const item = await this.api().checkRecovery({ sourcePath: reference.sourcePath, recoveryId: reference.recoveryId });
      if (item.status === 'recoverable' || item.status === 'conflict') {
        const saved = await this.api().saveAs({ sourcePath: reference.sourcePath, suggestedName: '恢复稿副本.md', content: item.recovery.content });
        if (saved) await this.open(saved.path, this.activeGroup, true);
        return;
      }
    }
    this.message('旧恢复稿已与磁盘内容相同，或无法读取；未删除任何恢复文件。');
  }
}
