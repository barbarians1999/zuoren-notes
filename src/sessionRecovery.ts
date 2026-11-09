import type { NoteSessionDocument, ReaderSession, RecoveryReference } from './types';
import type { NoteDocument } from './workspace/noteDocument';
import type { NoteWorkspace } from './workspace/noteWorkspace';
import { filePathKey } from './pathIdentity.cjs';
import { remapDescendantPath } from './fileOperations.cjs';

type RecoveryDocument = { path: string; recoveryId: string; retainedRecoveries: RecoveryReference[] };
const references = (item: NoteSessionDocument): RecoveryReference[] => [
  { sourcePath: item.path, recoveryId: item.recoveryId },
  ...('retainedRecoveries' in item ? item.retainedRecoveries
    : item.retainedRecoveryIds.map(recoveryId => ({ sourcePath: item.path, recoveryId }))),
];
const referenceKey = (item: RecoveryReference) => `${filePathKey(item.sourcePath)}\n${item.recoveryId}`;

// Recovery ownership outlives a visible tab. Store only paths and IDs here,
// never draft text, and never discard an entry merely because opening failed.
export class SessionRecovery {
  private documents = new Map<string, RecoveryDocument>();
  private remapping = false;
  initialized = false;
  seed(session: ReaderSession | null) {
    if (session?.version === 3) {
      for (const item of [...(session.pendingNoteDocuments || []), ...session.noteDocuments]) this.remember(item);
    } else if (session) {
      for (const item of [session.secondaryNote, session.primaryNote]) if (item) this.remember({ ...item, retainedRecoveries: [] });
    }
    this.initialized = true;
  }
  private remember(item: NoteSessionDocument) {
    const key = filePathKey(item.path), previous = this.documents.get(key);
    const primary = { sourcePath: item.path, recoveryId: item.recoveryId };
    const all = new Map([...references(item), ...(previous ? references(previous) : [])].map(reference => [referenceKey(reference), { ...reference }]));
    all.delete(referenceKey(primary));
    this.documents.set(key, { path: item.path, recoveryId: item.recoveryId, retainedRecoveries: [...all.values()] });
  }
  recoveryId(path: string) { return this.documents.get(filePathKey(path))?.recoveryId; }
  attach(doc: NoteDocument, requestedPath = doc.note.path) {
    if (this.remapping || !doc.ready || !doc.views.size) return;
    const pending = this.documents.get(filePathKey(requestedPath));
    if (pending) for (const reference of references(pending)) {
      // Never replace an existing/in-flight document's identity or edits.
      // Overflow stays in the independent catalog instead of being dropped.
      if (reference.recoveryId !== doc.recoveryId && doc.recoveryReferences.length < 100) doc.retainRecovery(reference.sourcePath, reference.recoveryId);
    }
    this.remember({ path: doc.note.path, recoveryId: doc.recoveryId, retainedRecoveries: doc.recoveryReferences });
  }
  async open(workspace: NoteWorkspace, path: string, ...options: [group?: 'primary' | 'secondary', pinned?: boolean, recoveryId?: string, prepare?: () => Promise<boolean>]) {
    if (!this.initialized) throw new Error('尚未读取上次工作现场，暂未打开笔记以保护恢复稿；请稍后重试。');
    const [group, pinned, recoveryId, prepare] = options;
    const tab = await workspace.open(path, group, pinned, recoveryId || this.recoveryId(path), prepare);
    if (tab?.document) this.attach(tab.document, path);
    return tab;
  }
  capture(documents: Iterable<NoteDocument>) {
    for (const doc of documents) if (doc.ready && doc.views.size) this.attach(doc);
  }
  snapshot(documents: Iterable<NoteDocument>): RecoveryDocument[] {
    const active = new Map<string, Set<string>>();
    for (const doc of documents) if (doc.ready && doc.views.size) {
      this.attach(doc);
      active.set(filePathKey(doc.note.path), new Set(references({ path: doc.note.path, recoveryId: doc.recoveryId,
        retainedRecoveries: doc.recoveryReferences }).map(referenceKey)));
    }
    return [...this.documents.values()].filter(item => {
      const owned = active.get(filePathKey(item.path));
      return !owned || references(item).some(reference => !owned.has(referenceKey(reference)));
    }).map(item => ({ ...item, retainedRecoveries: item.retainedRecoveries.map(reference => ({ ...reference })) }));
  }
  remap(previous: string, next: string, updateWorkspace: () => void = () => {}) {
    // Workspace relocation notifies synchronously. Do not attach references
    // from one side of the rename while the other side still has old paths.
    this.remapping = true;
    try {
      const items = [...this.documents.values()]; this.documents.clear();
      for (const item of items) this.remember({ path: remapDescendantPath(item.path, previous, next), recoveryId: item.recoveryId,
        retainedRecoveries: item.retainedRecoveries.map(reference => ({ ...reference, sourcePath: remapDescendantPath(reference.sourcePath, previous, next) })) });
      updateWorkspace();
    } finally { this.remapping = false; }
  }
}
