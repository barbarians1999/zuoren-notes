import type { NoteRead, SaveNoteResult } from './types';
type Snapshot = { note: NoteRead | null; text: string; revision: number };
export class DocumentPersistence {
  pending: Promise<boolean> | null;
  disposed: boolean;
  invalidate(): void;
  poll(options: { snapshot(): Snapshot; read(path: string): Promise<NoteRead>; apply(disk: NoteRead, conflict: boolean): void; blocked?(): boolean }): Promise<void>;
  save(options: {
    snapshot(): Snapshot; blocked?(): boolean; recovery?(snapshot: Snapshot): Promise<unknown>; recoveryError?(error: unknown): void;
    write(snapshot: Snapshot): Promise<SaveNoteResult>; saving?(): void; clean?(): void;
    conflict(result: SaveNoteResult & { conflict: true }): void;
    commit(result: Exclude<SaveNoteResult, { conflict: true }>, submitted: Snapshot): void; error(error: unknown): void;
  }): Promise<boolean>;
}

