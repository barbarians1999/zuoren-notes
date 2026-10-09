export type FileKind = 'pdf' | 'epub' | 'md';

export interface WorkspaceFile {
  path: string;
  name: string;
  relative: string;
  type: FileKind;
}

export type WorkspaceDirectoryEntry =
  | { path: string; name: string; kind: 'folder' }
  | (WorkspaceFile & { kind: 'file' });

export interface DirectoryListing {
  directory: string;
  parent: string | null;
  breadcrumbs: { name: string; path: string }[];
  entries: WorkspaceDirectoryEntry[];
}

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfAnchor {
  pdfId: string;
  page: number;
  rects: PdfRect[];
  rotation: 0 | 90 | 180 | 270;
  quote?: string;
  source?: string;
}

export interface EpubAnchor {
  epubId: string;
  cfiRange: string;
  source?: string;
  quote?: string;
  annotationId?: string;
  chapterHref?: string;
  chapterLabel?: string;
}

export type ReaderAnchor = PdfAnchor | EpubAnchor;

export type AnnotationType = 'highlight' | 'region' | 'note';

export interface PdfAnnotation {
  id: string;
  type: AnnotationType;
  anchor: PdfAnchor;
  color?: string;
  comment?: string;
  text?: string;
  attachment?: string;
  ocrText?: string;
  createdAt: string;
}

export interface PdfMeta {
  version: 1;
  id: string;
  page: number;
  annotations: PdfAnnotation[];
}

export interface EpubAnnotation {
  id: string;
  kind: 'highlight';
  cfiRange: string;
  quote: string;
  comment?: string;
  chapterHref?: string;
  chapterLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EpubMeta {
  version: 2;
  id: string;
  cfi: string;
  progress: number;
  fontSize: number;
  annotations: EpubAnnotation[];
}

export interface NoteRead {
  path: string;
  content: string;
  hash: string;
  bom: boolean;
  eol: '\n' | '\r\n';
}

export interface SearchResult extends WorkspaceFile {
  snippet: string;
  line: number;
}

export interface NoteSaveInput {
  path: string;
  content: string;
  hash: string;
  bom?: boolean;
  eol?: '\n' | '\r\n';
  recoveryId?: string;
}

export interface NoteSaveResult {
  conflict: false;
  hash: string;
  content: string;
}

export interface NoteConflictResult {
  conflict: true;
  path: string;
  content: string;
  hash: string;
  bom: boolean;
  eol: '\n' | '\r\n';
}

export type SaveNoteResult = NoteSaveResult | NoteConflictResult;

export interface HistoryEntry {
  time: number;
  content: string;
}

export interface Settings {
  recentFiles: string[];
  roots: string[];
  warning?: string;
  window?: { x?: number; y?: number; width?: number; height?: number };
  session: ReaderSession | null;
}

export type RecoveryPane = 'primary' | 'secondary';
export type NoteMode = 'edit' | 'source' | 'preview';

export interface ReaderSessionNote {
  path: string;
  mode: NoteMode;
  recoveryId: string;
}

export interface ReaderSessionV1 {
  version: 1;
  root: string | null;
  currentDirectory: string | null;
  layout: 'read' | 'note' | 'split';
  sidebar: boolean;
  splitAt: number;
  noteTabs: string[];
  primaryNote: ReaderSessionNote | null;
  secondaryNote: ReaderSessionNote | null;
  activePdf: { path: string; page: number; scale: number } | null;
  activeEpub: string | null;
}

export interface MarkdownScrollMemory {
  pane: RecoveryPane;
  path: string;
  mode: 'edit' | 'preview';
  scrollTop: number;
  ratio: number;
}

export interface ReaderSessionV2 extends Omit<ReaderSessionV1, 'version'> {
  version: 2;
  scrollMemory: MarkdownScrollMemory[];
}

export interface NoteSessionTab {
  id: string; path: string | null; mode: 'edit' | 'preview'; preview: boolean;
  selection: { anchor: number; head: number }; scroll: { edit: number; preview: number };
}
export interface NoteSessionGroup { tabs: NoteSessionTab[]; activeId: string | null }
export interface RecoveryReference { sourcePath: string; recoveryId: string }
export interface ReaderSessionV3 extends Omit<ReaderSessionV2, 'version'> {
  version: 3;
  // Legacy fields above are derived projections, never additional owners.
  noteGroups: { primary: NoteSessionGroup; secondary: NoteSessionGroup };
  activeNoteGroup: 'primary' | 'secondary';
  // retainedRecoveries is path-qualified in new V3 snapshots. Legacy V3
  // snapshots with retainedRecoveryIds remain accepted at the session boundary.
  noteDocuments: ({ path: string; recoveryId: string; retainedRecoveries: RecoveryReference[] }
    | { path: string; recoveryId: string; retainedRecoveryIds: string[] })[];
}
export type ReaderSession = ReaderSessionV1 | ReaderSessionV2 | ReaderSessionV3;

export interface RecoveryV1 {
  version: 1;
  recoveryId: string;
  sourcePath: string;
  paneHint: RecoveryPane;
  createdAt: string;
  updatedAt: string;
  baseHash: string;
  draftHash: string;
  content: string;
  encoding: { bom: boolean; eol: '\n' | '\r\n' };
}

export type RecoveryCheckResult =
  | { status: 'none' | 'corrupt' }
  | { status: 'already-saved'; note: NoteRead }
  | { status: 'recoverable' | 'conflict'; note: NoteRead; recovery: RecoveryV1 };

export interface WorkspaceMeta {
  version: 1;
  root: string;
  notes: Record<string, { pdfPath?: string; pdfId?: string }>;
}

export interface OcrProgress {
  jobId: string;
  progress: number;
  status: string;
  text?: string;
  message?: string;
}

export interface ReaderApi {
  getLaunchItems(): Promise<{ root?: string; files: WorkspaceFile[] }>;
  listWorkspace(root: string): Promise<{ files: WorkspaceFile[]; truncated: boolean }>;
  listDirectory(input: { root: string; directory: string }): Promise<DirectoryListing>;
  chooseWorkspace(): Promise<{ path: string; files: WorkspaceFile[] } | null>;
  chooseFiles(): Promise<WorkspaceFile[]>;
  chooseRelocation(input: { pdfId: string; suggestedPath?: string }): Promise<string | null>;
  chooseEpubRelocation(input: { epubId: string }): Promise<string | null>;
  showItemInFolder(path: string): Promise<boolean>;
  createNoteAt(input: { directory: string; name: string; initialContent?: string }): Promise<NoteRead>;
  createFolderAt(input: { directory: string; name: string }): Promise<Extract<WorkspaceDirectoryEntry, { kind: 'folder' }>>;
  renameEntry(input: { path: string; name: string }): Promise<WorkspaceDirectoryEntry>;
  trashEntry(path: string): Promise<boolean>;
  createNote(input: { suggestedName?: string; initialContent?: string }): Promise<NoteRead | null>;
  saveAs(input: { sourcePath?: string; suggestedName?: string; content: string }): Promise<NoteRead | null>;
  readNote(path: string): Promise<NoteRead>;
  saveNote(input: NoteSaveInput): Promise<SaveNoteResult>;
  noteHistory(path: string): Promise<HistoryEntry[]>;
  openPdf(path: string): Promise<{ data: Uint8Array; meta: PdfMeta; path: string }>;
  savePdfMeta(input: { path: string; meta: PdfMeta }): Promise<boolean>;
  openEpub(path: string): Promise<{ data: Uint8Array; meta: EpubMeta; warnings?: string[]; path: string }>;
  saveEpubMeta(input: { path: string; meta: EpubMeta }): Promise<boolean>;
  saveAttachment(input: { sourcePath: string; data: Uint8Array; extension?: string }): Promise<string>;
  search(input: { root: string; query: string }): Promise<SearchResult[]>;
  getSettings(): Promise<Settings>;
  getWindowState(): Promise<{ maximized: boolean; fullscreen: boolean }>;
  windowControl(action: 'minimize' | 'maximize' | 'fullscreen' | 'close'): Promise<{ maximized: boolean; fullscreen: boolean }>;
  updateSettings(settings: Partial<Settings>): Promise<Settings>;
  saveSession(session: ReaderSession): Promise<Settings>;
  writeRecovery(input: { sourcePath: string; paneHint: RecoveryPane; recoveryId: string; baseHash: string; content: string; encoding: { bom: boolean; eol: '\n' | '\r\n' } }): Promise<RecoveryV1>;
  checkRecovery(input: { sourcePath: string; recoveryId: string }): Promise<RecoveryCheckResult>;
  deleteRecovery(input: { sourcePath: string; recoveryId: string; draftHash: string }): Promise<boolean>;
  assetUrl(path: string): Promise<string>;
  makeAnchorPath(input: { fromFile: string; toFile: string }): Promise<string>;
  resolveAnchorPath(input: { fromFile: string; storedPath: string; pdfId?: string; epubId?: string }): Promise<string | null>;
  startOcr(input: { image: Uint8Array; languages?: string[] }): Promise<{ jobId: string }>;
  cancelOcr(jobId: string): Promise<boolean>;
  onOcrProgress(listener: (progress: OcrProgress) => void): () => void;
  onOpenLaunchItems(listener: (items: { root?: string; files: WorkspaceFile[] }) => void): () => void;
  onWindowState(listener: (state: { maximized: boolean; fullscreen: boolean }) => void): () => void;
  onAppClosing(listener: () => void): () => void;
  confirmClose(): void;
}
