import type { ReaderApi, FileMoveResult, PendingFileMoveIssue, WorkspaceFile } from '../types';
import type { NoteWorkspace } from './noteWorkspace';
import type { ReaderSession } from '../readers/readerSession';
import type { MutationBarrier } from '../fileOperations.cjs';
import { filePathKey, normalizeFilePath } from '../pathIdentity.cjs';
import { sameOrDescendantPath } from '../fileOperations.cjs';

export function fileMoveParent(value: string) {
  const normalized = normalizeFilePath(value), separator = normalized.startsWith('/') ? '/' : '\\';
  if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(normalized)) return normalized.replace(/\\$/, '');
  const at = normalized.lastIndexOf(separator);
  if (separator === '/' && at === 0) return '/';
  if (/^[a-z]:\\/i.test(normalized) && at === 2) return normalized.slice(0, 3);
  return at > 0 ? normalized.slice(0, at) : normalized;
}
export function fileDropPermission(source: WorkspaceFile | null, root: string, directory: string, busy = false) {
  if (busy) return { allowed: false, reason: '正在处理文件，请稍候' };
  if (!source || ('kind' in source && source.kind !== 'file') || !root || !sameOrDescendantPath(source.path, root) || !sameOrDescendantPath(directory, root)) return { allowed: false, reason: '只能移动当前资料根目录内的文件' };
  const parent = fileMoveParent(source.path);
  if (filePathKey(parent) === filePathKey(directory)) return { allowed: false, reason: '文件已经在这个文件夹中' };
  return { allowed: true, reason: `移动到 ${directory}` };
}
type Context = {
  workspace: NoteWorkspace; readers: ReaderSession; barrier: MutationBarrier; api: ReaderApi;
  remap(previous: string, next: string): void;
  persistSession(): Promise<boolean>;
  valid?(): boolean;
};
export type MoveIssue = PendingFileMoveIssue;
export type MoveOutcome = { status: 'moved'; result: Extract<FileMoveResult, { ok: true }> }
  | { status: 'failed' | 'blocked'; message: string } | { status: 'uncertain'; issue: MoveIssue };
export class FileMoveCoordinator {
  busy = false;
  issue: MoveIssue | null = null;
  pendingReady = false;
  pendingError: string | null = null;
  private pendingFlight: Promise<MoveOutcome | null> | null = null;
  async restorePending(context: Context): Promise<MoveOutcome | null> {
    if (this.issue) {
      context.barrier.pin(this.issue.oldPath);
      if (this.issue.targetPath) context.barrier.pin(this.issue.targetPath);
      return { status: 'uncertain', issue: this.issue };
    }
    if (this.pendingFlight) return this.pendingFlight;
    this.pendingReady = false; this.pendingError = null;
    this.pendingFlight = (async () => {
      try {
        const pending = await context.api.pendingFileMove();
        if (pending !== null) {
          if (!pending || typeof pending.operationId !== 'string' || !pending.operationId || typeof pending.oldPath !== 'string' || !pending.oldPath
            || typeof pending.message !== 'string' || (pending.targetPath !== undefined && typeof pending.targetPath !== 'string')) throw new Error('移动保护记录格式不可用');
          this.issue = { ...pending };
          context.barrier.pin(pending.oldPath); if (pending.targetPath) context.barrier.pin(pending.targetPath);
          this.pendingReady = true;
          return { status: 'uncertain', issue: this.issue } as const;
        }
        this.pendingReady = true; return null;
      } catch (error) {
        this.pendingError = `无法核对上次移动记录，已暂停新的文件移动；请重试核对：${String(error)}`;
        return { status: 'blocked', message: this.pendingError } as const;
      }
    })();
    try { return await this.pendingFlight; }
    finally { this.pendingFlight = null; }
  }
  private async accept(context: Context, result: FileMoveResult): Promise<MoveOutcome> {
    if (!result.ok) {
      context.barrier.pin(result.oldPath);
      this.issue = { operationId: result.operationId, oldPath: result.oldPath, message: result.error, recoveryPath: result.recoveryPath,
        targetPath: this.issue?.operationId === result.operationId ? this.issue.targetPath : undefined };
      return { status: 'uncertain', issue: this.issue };
    }
    const previous = this.issue?.operationId === result.operationId ? this.issue : null;
    const protectedPaths = new Set([result.oldPath, result.entry.path, ...(previous ? [previous.oldPath, previous.targetPath].filter((value): value is string => !!value) : [])]);
    for (const value of protectedPaths) context.barrier.pin(value);
    let remapped = false;
    try {
      const sourceDocument = context.workspace.documents.get(filePathKey(result.oldPath)), targetDocument = context.workspace.documents.get(filePathKey(result.entry.path));
      if (sourceDocument && targetDocument && sourceDocument !== targetDocument) throw new Error('目标位置仍有另一份打开的笔记，未替换或合并任何文档');
      context.remap(result.oldPath, result.entry.path); remapped = true;
      if ((await context.api.finalizeFileMove(result.operationId)) !== true) throw new Error('持久完成确认尚未成功');
    } catch (error) {
      this.issue = { operationId: result.operationId, oldPath: result.oldPath, targetPath: result.entry.path,
        message: `文件已移动到 ${result.entry.path}，${remapped ? '持久完成确认' : '界面同步'}未完成；原位置与目标位置继续保护，请重新核对结果：${String(error)}` };
      return { status: 'uncertain', issue: this.issue };
    }
    for (const value of protectedPaths) context.barrier.unpin(value);
    context.barrier.releaseExact(result.entry.path);
    context.barrier.release(result.oldPath); if (!result.restored) context.barrier.block(result.oldPath);
    this.issue = null; return { status: 'moved', result };
  }
  async run(context: Context, request: { root: string; source: WorkspaceFile; directory: string; undoToken?: string }): Promise<MoveOutcome> {
    if (this.busy || this.issue) return { status: 'blocked', message: '上一轮移动尚未确认，已阻止自动继续。' };
    let release: (() => void) | null = null, submitted = false;
    this.busy = true; const operationId = crypto.randomUUID(), oldPath = request.source.path;
    const targetPath = request.directory.replace(/[\\/]$/, '') + (request.directory.startsWith('/') ? '/' : '\\') + request.source.name;
    const targetIsOpen = () => filePathKey(targetPath) !== filePathKey(oldPath) && (context.workspace.documents.has(filePathKey(targetPath))
      || [context.readers.currentPdf(), context.readers.currentEpub()].some(item => item && filePathKey(item.path) === filePathKey(targetPath)));
    try {
      if (!this.pendingReady && !this.pendingError) {
        const pending = await this.restorePending(context); if (pending) return pending;
      }
      if (!this.pendingReady) return { status: 'blocked', message: this.pendingError || '尚未核对上次文件移动，已暂停新的移动。' };
      const capability = await context.api.fileMoveCapability();
      if (!capability.supported) return { status: 'failed', message: capability.reason || '当前环境未通过安全移动前置检查，未保存或移动文件。' };
      if (context.valid?.() === false) return { status: 'blocked', message: '资料目录或当前操作已变化，请重新选择文件。' };
      if (targetIsOpen()) return { status: 'blocked', message: '目标位置已有打开的笔记或阅读器，请先处理该标签；文件未移动，也未合并内容。' };
      release = context.workspace.beginCommit(); if (!release) return { status: 'blocked', message: '工作区正在保存或关闭，请稍后重试。' };
      if (!(await context.workspace.saveAll()) || !(await context.readers.flush())) return { status: 'blocked', message: '笔记、恢复稿或阅读进度尚未保存，文件未移动。请先处理保存提示或冲突。' };
      if (context.valid?.() === false) return { status: 'blocked', message: '保存期间资料目录发生变化，文件未移动。' };
      if ((await context.persistSession()) !== true) return { status: 'blocked', message: '当前工作现场尚未持久保存，文件未移动。请处理保存提示后重试。' };
      if (context.valid?.() === false) return { status: 'blocked', message: '保存期间资料目录发生变化，文件未移动。' };
      if (targetIsOpen()) return { status: 'blocked', message: '目标位置在保存期间被打开，请先处理该标签；文件未移动，也未合并内容。' };
      const doc = context.workspace.documents.get(filePathKey(oldPath));
      const pdf = context.readers.currentPdf(), epub = context.readers.currentEpub();
      const expectedHash = doc?.note.hash || (pdf && filePathKey(pdf.path) === filePathKey(oldPath) ? pdf.meta.id : undefined)
        || (epub && filePathKey(epub.path) === filePathKey(oldPath) ? epub.meta.id : undefined);
      context.barrier.pin(oldPath); context.barrier.pin(targetPath);
      let result: FileMoveResult;
      try {
        submitted = true;
        result = request.undoToken ? await context.api.undoFileMove({ operationId, token: request.undoToken, expectedHash })
          : await context.api.moveFile({ operationId, root: request.root, path: oldPath, directory: request.directory, expectedVersion: request.source.moveVersion, expectedHash });
      } catch (error) {
        const status = await context.api.fileMoveStatus(operationId).catch(() => ({ status: 'unknown' as const }));
        if (status.status === 'finished') result = status.result;
        else if (status.status === 'failed') { context.barrier.unpin(targetPath); context.barrier.unpin(oldPath); context.barrier.release(oldPath); return { status: 'failed', message: status.error }; }
        else {
          this.issue = { operationId, oldPath, targetPath, message: `无法确认移动结果，已保留当前内容并暂停后续移动。请检查目录后核对结果：${String(error)}` };
          return { status: 'uncertain', issue: this.issue };
        }
      }
      const outcome = await this.accept(context, result);
      if (outcome.status === 'uncertain') { this.issue!.targetPath ??= targetPath; }
      return outcome;
    } catch (error) {
      if (submitted) {
        context.barrier.pin(oldPath); context.barrier.pin(targetPath);
        this.issue = { operationId, oldPath, targetPath, message: `移动回执无法处理，已保留闭锁：${String(error)}` };
        return { status: 'uncertain', issue: this.issue };
      }
      // Before submitting IPC, save failures cannot have moved the file.
      return { status: 'failed', message: String(error) };
    } finally { this.busy = false; release?.(); }
  }
  async recheck(context: Context): Promise<MoveOutcome> {
    const issue = this.issue;
    if (!issue || this.busy) return { status: 'blocked', message: '没有可核对的移动结果。' };
    this.busy = true;
    try {
      const status = await context.api.fileMoveStatus(issue.operationId).catch(() => ({ status: 'unknown' as const }));
      if (status.status === 'finished') return await this.accept(context, status.result);
      if (status.status === 'failed') { const message = status.error; if (issue.targetPath) context.barrier.unpin(issue.targetPath); context.barrier.unpin(issue.oldPath); context.barrier.release(issue.oldPath); this.issue = null; return { status: 'failed', message }; }
      return { status: 'uncertain', issue };
    } catch (error) {
      this.issue = { ...(this.issue || issue), message: `移动回执仍无法处理，保护继续保留：${String(error)}` };
      return { status: 'uncertain', issue: this.issue };
    } finally { this.busy = false; }
  }
  async recover(context: Context): Promise<MoveOutcome> {
    if (!this.issue || this.busy) return { status: 'blocked', message: '请先核对上一轮移动。' };
    this.busy = true;
    try { return await this.accept(context, await context.api.recoverFileMove(this.issue.operationId)); }
    catch (error) { return { status: 'failed', message: `未覆盖原位置，暂存内容仍保留：${String(error)}` }; }
    finally { this.busy = false; }
  }
}
