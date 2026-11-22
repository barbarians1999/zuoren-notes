import { MetadataWriter } from '../metadataWriter.cjs';
import { remapDescendantPath, sameOrDescendantPath } from '../fileOperations.cjs';
import type { ActiveEpub, ActivePdf } from '../readerContext';
import type { EpubMeta, PdfMeta, ReaderApi, ReaderSessionV3 } from '../types';

export type ReaderSessionAdapter = Pick<ReaderApi, 'openPdf' | 'openEpub' | 'savePdfMeta' | 'saveEpubMeta'>;
export type ReaderKind = 'pdf' | 'epub';
export type ReaderSaveFailure = { kind: ReaderKind; name: string; path: string; reason: string };
export type ReaderOpenResult = { status: 'opened'; warnings?: string[] } | { status: 'superseded' | 'save-failed' | 'identity-mismatch' };
export type ReaderSessionSnapshot = { pdf: ActivePdf | null; epub: ActiveEpub | null; page: number; scale: number };

export function formatReaderSaveError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const cleaned = raw.trim().replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '');
  if (/\bENOENT\b/i.test(cleaned)) return '原文件不存在或所在磁盘已断开，无法写入阅读进度或标注。';
  if (/\b(EACCES|EPERM|EROFS)\b/i.test(cleaned)) return '原文件所在位置没有写入权限或为只读目录，无法保存阅读进度或标注。';
  if (/\bEBUSY\b/i.test(cleaned)) return '目标文件正被其他程序占用，请稍后重试。';
  return cleaned || '保存未能确认，请检查原文件是否存在且可写入。';
}

export class ReaderSession {
  private snapshot: ReaderSessionSnapshot = { pdf: null, epub: null, page: 1, scale: 1 };
  private generation = 0;
  private listeners = new Set<() => void>();
  private pdfWriter = new MetadataWriter<PdfMeta>();
  private epubWriter = new MetadataWriter<EpubMeta>();
  private lastPdfTarget: { key: Uint8Array; name: string; path: string } | null = null;
  private lastEpubTarget: { key: Uint8Array; name: string; path: string } | null = null;
  private adapter: ReaderSessionAdapter;
  private capture: () => void;
  private onError: (message: string) => void;

  constructor(adapter: ReaderSessionAdapter, onError: (message: string) => void, capture?: () => void) {
    this.adapter = adapter;
    this.capture = capture || (() => {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('reader-flush'));
    });
    this.onError = onError;
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  currentGeneration = () => this.generation;
  currentPdf = () => this.snapshot.pdf;
  currentEpub = () => this.snapshot.epub;
  isCurrentPdf = (expected: ActivePdf) => !!this.snapshot.pdf && this.samePdf(this.snapshot.pdf, expected);
  isCurrentEpub = (expected: ActiveEpub) => !!this.snapshot.epub && this.sameEpub(this.snapshot.epub, expected);
  private publish(next: ReaderSessionSnapshot) { this.snapshot = next; for (const listener of this.listeners) listener(); }

  async open(path: string, kind: ReaderKind, options: { name?: string; page?: number; scale?: number; expectedId?: string; discardPreviousChanges?: boolean } = {}): Promise<ReaderOpenResult> {
    const generation = ++this.generation;
    if (options.discardPreviousChanges) this.discardFailedWrites();
    else if (!(await this.flushWrites())) return { status: 'save-failed' };
    if (generation !== this.generation) return { status: 'superseded' };

    if (kind === 'pdf') {
      const loaded = await this.adapter.openPdf(path);
      if (generation !== this.generation) return { status: 'superseded' };
      if (options.expectedId && loaded.meta.id !== options.expectedId) return { status: 'identity-mismatch' };
      return this.commitOpen(generation, () => {
        const current = this.snapshot.pdf;
        const meta = current?.path === loaded.path && current.meta.id === loaded.meta.id ? current.meta : loaded.meta;
        const name = options.name || loaded.path.split(/[\\/]/).pop() || loaded.path;
        const data = loaded.data instanceof Uint8Array ? loaded.data : new Uint8Array(0);
        this.publish({ pdf: { path: loaded.path, name, data, size: loaded.size, rangeMode: !!loaded.rangeMode, meta }, epub: null,
          page: Math.max(1, options.page || meta.page || 1), scale: options.scale || 1 });
        return { status: 'opened' };
      }, options.discardPreviousChanges);
    }
    const loaded = await this.adapter.openEpub(path);
    if (generation !== this.generation) return { status: 'superseded' };
    if (options.expectedId && loaded.meta.id !== options.expectedId) return { status: 'identity-mismatch' };
    return this.commitOpen(generation, () => {
      const current = this.snapshot.epub;
      const meta = current?.path === loaded.path && current.meta.id === loaded.meta.id ? current.meta : loaded.meta;
      const name = options.name || loaded.path.split(/[\\/]/).pop() || loaded.path;
      this.publish({ ...this.snapshot, pdf: null, epub: { path: loaded.path, name, data: loaded.data, meta } });
      return { status: 'opened', ...(loaded.warnings?.length ? { warnings: loaded.warnings } : {}) };
    }, options.discardPreviousChanges);
  }

  private async commitOpen(generation: number, commit: () => ReaderOpenResult, discardPreviousChanges = false): Promise<ReaderOpenResult> {
    if (generation !== this.generation) return { status: 'superseded' };
    if (discardPreviousChanges) {
      this.discardFailedWrites();
      return generation === this.generation ? commit() : { status: 'superseded' };
    }
    let result: ReaderOpenResult = { status: 'superseded' };
    const saved = await this.flushWrites(() => {
      if (generation === this.generation) result = commit();
    });
    return saved ? result : { status: generation === this.generation ? 'save-failed' : 'superseded' };
  }

  async flush(): Promise<boolean> {
    ++this.generation;
    return this.flushWrites();
  }

  lastSaveFailure(): ReaderSaveFailure | null {
    const { pdf, epub } = this.snapshot;
    if (pdf && this.pdfWriter.hasFailure(pdf.data)) {
      return { kind: 'pdf', name: pdf.name, path: pdf.path, reason: formatReaderSaveError(this.pdfWriter.failureError(pdf.data)) };
    }
    if (epub && this.epubWriter.hasFailure(epub.data)) {
      return { kind: 'epub', name: epub.name, path: epub.path, reason: formatReaderSaveError(this.epubWriter.failureError(epub.data)) };
    }
    if (this.pdfWriter.hasFailure()) {
      return { kind: 'pdf', name: this.lastPdfTarget?.name || 'PDF 资料', path: this.lastPdfTarget?.path || '', reason: formatReaderSaveError(this.pdfWriter.failureError()) };
    }
    if (this.epubWriter.hasFailure()) {
      return { kind: 'epub', name: this.lastEpubTarget?.name || 'EPUB 资料', path: this.lastEpubTarget?.path || '', reason: formatReaderSaveError(this.epubWriter.failureError()) };
    }
    return null;
  }

  discardFailedWrites(): void {
    this.pdfWriter.discard();
    this.epubWriter.discard();
  }

  async close(expected: ActiveEpub | ActivePdf, onCommit?: () => void): Promise<boolean> {
    const matches = () => this.snapshot.epub ? this.sameEpub(this.snapshot.epub, expected as ActiveEpub)
      : !!this.snapshot.pdf && this.samePdf(this.snapshot.pdf, expected as ActivePdf);
    if (!matches()) return false;
    const generation = ++this.generation;
    let closed = false;
    await this.flushWrites(() => {
      if (generation !== this.generation || !matches()) return;
      this.publish({ pdf: null, epub: null, page: 1, scale: 1 });
      onCommit?.();
      closed = true;
    });
    return closed;
  }

  private async flushWrites(commit?: () => void): Promise<boolean> {
    // Reader views capture transient position synchronously, then enqueue any
    // resulting metadata change through updatePdf/updateEpub before this waits.
    const activePdfKey = this.snapshot.pdf?.data;
    const activeEpubKey = this.snapshot.epub?.data;
    const pdfTailBefore = this.pdfWriter.tail;
    const epubTailBefore = this.epubWriter.tail;
    this.capture();
    if (this.pdfWriter.tail === pdfTailBefore && this.pdfWriter.hasFailure()) {
      if (activePdfKey && this.pdfWriter.hasFailure(activePdfKey)) void this.pdfWriter.retry(activePdfKey)?.catch(() => undefined);
      else this.pdfWriter.discard();
    }
    if (this.epubWriter.tail === epubTailBefore && this.epubWriter.hasFailure()) {
      if (activeEpubKey && this.epubWriter.hasFailure(activeEpubKey)) void this.epubWriter.retry(activeEpubKey)?.catch(() => undefined);
      else this.epubWriter.discard();
    }
    let failed = false;
    while (true) {
      const pdfTail = this.pdfWriter.tail, epubTail = this.epubWriter.tail;
      const results = await Promise.allSettled([pdfTail, epubTail]);
      for (const result of results) if (result.status === 'rejected' || result.value === false) failed = true;
      if (pdfTail === this.pdfWriter.tail && epubTail === this.epubWriter.tail) {
        // Commit in the same turn as the final queue check, so no update can
        // enter between the save confirmation and the document switch.
        if (!failed) commit?.();
        return !failed;
      }
    }
  }

  async updatePdf(change: (current: PdfMeta) => PdfMeta, expected?: ActivePdf): Promise<boolean> {
    const active = this.snapshot.pdf;
    if (!active || (expected && !this.samePdf(active, expected))) return false;
    this.lastPdfTarget = { key: active.data, name: active.name, path: active.path };
    const write = this.pdfWriter.write({ key: active.data, initial: active.meta, change,
      persist: meta => {
        const current = this.snapshot.pdf;
        const targetPath = current && current.data === active.data && current.meta.id === meta.id ? current.path
          : this.lastPdfTarget?.key === active.data ? this.lastPdfTarget.path : active.path;
        return this.adapter.savePdfMeta({ path: targetPath, meta });
      },
      commit: meta => {
        const current = this.snapshot.pdf;
        if (current && this.samePdf(current, active) && current.meta.id === meta.id)
          this.publish({ ...this.snapshot, pdf: { ...current, meta } });
      },
    });
    try {
      const okay = await write;
      if (!okay) this.onError('PDF 标记保存未能确认，请重试。');
      return okay;
    } catch (error) { this.onError(`标记保存失败：${formatReaderSaveError(error)}`); return false; }
  }

  async updateEpub(change: (current: EpubMeta) => EpubMeta, expected?: ActiveEpub): Promise<boolean> {
    const active = this.snapshot.epub;
    if (!active || (expected && !this.sameEpub(active, expected))) return false;
    this.lastEpubTarget = { key: active.data, name: active.name, path: active.path };
    const write = this.epubWriter.write({ key: active.data, initial: active.meta, change,
      persist: meta => {
        const current = this.snapshot.epub;
        const targetPath = current && current.data === active.data && current.meta.id === meta.id ? current.path
          : this.lastEpubTarget?.key === active.data ? this.lastEpubTarget.path : active.path;
        return this.adapter.saveEpubMeta({ path: targetPath, meta });
      },
      commit: meta => {
        const current = this.snapshot.epub;
        if (current && this.sameEpub(current, active) && current.meta.id === meta.id)
          this.publish({ ...this.snapshot, epub: { ...current, meta } });
      },
    });
    try {
      const okay = await write;
      if (!okay) this.onError('EPUB 标注或阅读位置保存未能确认，请重试。');
      return okay;
    } catch (error) { this.onError(`EPUB 标注或阅读位置保存失败：${formatReaderSaveError(error)}`); return false; }
  }

  setPage(value: number) {
    if (!Number.isFinite(value)) return;
    const page = Math.max(1, Math.floor(value));
    if (page !== this.snapshot.page) this.publish({ ...this.snapshot, page });
  }
  setScale(value: number) {
    if (!Number.isFinite(value)) return;
    const scale = Math.min(3, Math.max(0.5, value));
    if (scale !== this.snapshot.scale) this.publish({ ...this.snapshot, scale });
  }

  sessionFields(): Pick<ReaderSessionV3, 'activePdf' | 'activeEpub'> {
    const { pdf, epub, page, scale } = this.snapshot;
    return { activePdf: pdf ? { path: pdf.path, page, scale } : null, activeEpub: epub?.path || null };
  }

  remapPath(previous: string, next: string) {
    const { pdf, epub } = this.snapshot;
    const remapTarget = (target: { key: Uint8Array; name: string; path: string } | null) => {
      if (!target || !sameOrDescendantPath(target.path, previous)) return target;
      const mapped = remapDescendantPath(target.path, previous, next);
      return { ...target, path: mapped, name: mapped.split(/[\\/]/).pop() || target.name };
    };
    this.lastPdfTarget = remapTarget(this.lastPdfTarget);
    this.lastEpubTarget = remapTarget(this.lastEpubTarget);
    this.publish({ ...this.snapshot,
      pdf: pdf && sameOrDescendantPath(pdf.path, previous) ? (() => { const mapped = remapDescendantPath(pdf.path, previous, next); return { ...pdf, path: mapped, name: mapped.split(/[\\/]/).pop() || pdf.name }; })() : pdf,
      epub: epub && sameOrDescendantPath(epub.path, previous) ? (() => { const mapped = remapDescendantPath(epub.path, previous, next); return { ...epub, path: mapped, name: mapped.split(/[\\/]/).pop() || epub.name }; })() : epub,
    });
  }

  forgetPath(path: string) {
    const { pdf, epub } = this.snapshot;
    const nextPdf = pdf && sameOrDescendantPath(pdf.path, path) ? null : pdf;
    const nextEpub = epub && sameOrDescendantPath(epub.path, path) ? null : epub;
    if (pdf && !nextPdf) this.pdfWriter.discard(pdf.data);
    if (epub && !nextEpub) this.epubWriter.discard(epub.data);
    if (pdf !== nextPdf || epub !== nextEpub) this.publish({ ...this.snapshot, pdf: nextPdf, epub: nextEpub });
  }

  private samePdf(a: ActivePdf, b: ActivePdf) { return a.data === b.data && a.path === b.path && a.meta.id === b.meta.id; }
  private sameEpub(a: ActiveEpub, b: ActiveEpub) { return a.data === b.data && a.path === b.path && a.meta.id === b.meta.id; }
}
