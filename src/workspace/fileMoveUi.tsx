import { useEffect, useId, useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import { ArrowLeft, Folder, FolderOpen, MoveRight, Undo2 } from 'lucide-react';
import { DialogFrame } from '../ui/overlays';
import { reader } from '../readerContext';
import type { DirectoryListing, WorkspaceDirectoryEntry, WorkspaceFile } from '../types';
import type { NoteWorkspace } from './noteWorkspace';
import type { ReaderSession } from '../readers/readerSession';
import type { MutationBarrier } from '../fileOperations.cjs';
import { sameOrDescendantPath } from '../fileOperations.cjs';
import { filePathKey } from '../pathIdentity.cjs';
import { FileMoveCoordinator, fileDropPermission, fileMoveParent as parentPath, type MoveIssue, type MoveOutcome } from './fileMove';

const MIME = 'application/x-zuoren-file-move';
type TargetProps = HTMLAttributes<HTMLElement> & { 'data-drop-state'?: string; 'data-move-received'?: boolean };
type Options = { root: string; directory: DirectoryListing | null; workspace: NoteWorkspace; readers: ReaderSession; barrier: MutationBarrier;
  blocked: boolean; remap(previous: string, next: string): void; persistSession(): Promise<boolean>; reload(): Promise<void>; message(text: string): void };

export function useFileMoveUi(options: Options) {
  const current = useRef(options); current.current = options;
  const coordinator = useRef(new FileMoveCoordinator());
  const drag = useRef<{ id: string; source: WorkspaceFile; root: string } | null>(null);
  const hover = useRef(''), timer = useRef(0);
  const openRequest = useRef(0);
  const pendingRequest = useRef(0);
  const [dragging, setDragging] = useState(false), [hovered, setHovered] = useState<{ path: string; allowed: boolean; reason: string } | null>(null);
  const [preview, setPreview] = useState<DirectoryListing | null>(null);
  const [proposal, setProposal] = useState<{ source: WorkspaceFile; directory: string; id: number } | null>(null);
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<MoveIssue | null>(null);
  const [checkingPending, setCheckingPending] = useState(true), [pendingError, setPendingError] = useState('');
  const [undo, setUndo] = useState<{ root: string; source: WorkspaceFile; directory: string; token: string } | null>(null);
  const [received, setReceived] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  function clearDrag() { drag.current = null; hover.current = ''; window.clearTimeout(timer.current); setDragging(false); setHovered(null); setPreview(null); }
  useEffect(() => { openRequest.current++; clearDrag(); setProposal(null); setUndo(null); }, [options.root]);
  useEffect(() => { if (!received) return; const id = window.setTimeout(() => setReceived(''), 1000); return () => window.clearTimeout(id); }, [received]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { openRequest.current++; clearDrag(); } }; window.addEventListener('keydown', escape); return () => { openRequest.current++; window.removeEventListener('keydown', escape); window.clearTimeout(timer.current); }; }, []);
  useEffect(() => { void checkPending(); return () => { pendingRequest.current++; }; }, []);
  function context() { const value = current.current; return { workspace: value.workspace, readers: value.readers, barrier: value.barrier, api: reader(), remap: value.remap, persistSession: value.persistSession,
    valid: () => current.current.root === value.root && !current.current.blocked }; }
  async function checkPending() {
    const id = ++pendingRequest.current; setCheckingPending(true); setPendingError('');
    const outcome = await coordinator.current.restorePending(context());
    if (id !== pendingRequest.current) return;
    setCheckingPending(false); setPendingError(coordinator.current.pendingError || '');
    if (outcome?.status === 'uncertain') { setIssue(outcome.issue); setProposal(null); setUndo(null); current.current.message(outcome.issue.message); }
    else if (outcome?.status === 'blocked') current.current.message(outcome.message);
  }
  function available() { const value = current.current; return !!value.root && !value.blocked && !value.workspace.committing && !checkingPending && !coordinator.current.pendingError && coordinator.current.pendingReady && !coordinator.current.issue && !coordinator.current.busy; }
  async function open(source: WorkspaceFile, directory = parentPath(source.path), refreshSource = false) {
    const id = ++openRequest.current;
    if (!available() || !sameOrDescendantPath(source.path, current.current.root) || !sameOrDescendantPath(directory, current.current.root)) return;
    const root = current.current.root;
    if (!source.moveVersion || refreshSource) {
      try {
        const listing = await reader().listDirectory({ root, directory: parentPath(source.path) });
        const actual = listing.entries.find(item => item.kind === 'file' && filePathKey(item.path) === filePathKey(source.path));
        if (!actual || actual.kind !== 'file' || !actual.moveVersion) throw new Error('源文件已变化或不再可用，请刷新资料目录');
        source = actual;
      } catch (error) { if (id === openRequest.current) current.current.message(String(error)); return; }
    }
    if (id !== openRequest.current || root !== current.current.root || !available()) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setProposal({ source, directory, id });
  }
  async function accept(outcome: MoveOutcome, root: string, wasUndo = false) {
    const movedHere = outcome.status === 'moved' && root === current.current.root
      && sameOrDescendantPath(outcome.result.oldPath, root) && sameOrDescendantPath(outcome.result.entry.path, root);
    if (outcome.status === 'moved') {
      setIssue(null); setProposal(null);
      if (movedHere) {
        if (outcome.result.restored || wasUndo || !outcome.result.undoToken) setUndo(null);
        else setUndo({ root, source: outcome.result.entry, directory: parentPath(outcome.result.oldPath), token: outcome.result.undoToken });
        setReceived(outcome.result.restored || wasUndo ? outcome.result.entry.path : parentPath(outcome.result.entry.path));
      }
      const message = movedHere
        ? outcome.result.recovered ? `已核对；上次未能打开的标签可从目标目录重新打开，恢复引用仍保留。${outcome.result.warning ? ` ${outcome.result.warning}` : ''}`
          : outcome.result.warning || (outcome.result.restored ? '已恢复原位置。' : wasUndo ? '已撤销文件移动。' : '文件已移动，可撤销。')
        : `原目录文件位置已更新：${outcome.result.oldPath} → ${outcome.result.entry.path}。当前资料目录已切换，此处不提供撤销。${outcome.result.recovered ? '上次未能打开的标签可从目标目录重新打开，恢复引用仍保留。' : ''}${outcome.result.warning ? ` ${outcome.result.warning}` : ''}`;
      current.current.message(message);
    } else if (outcome.status === 'uncertain') { setIssue(outcome.issue); setProposal(null); setUndo(null); current.current.message(outcome.issue.message); }
    else { setIssue(coordinator.current.issue); current.current.message(outcome.message); if (outcome.status === 'blocked') setProposal(null); }
    if (outcome.status === 'moved' ? movedHere : root === current.current.root) await current.current.reload().catch(error => current.current.message(`文件状态已保留，但目录刷新失败：${String(error)}`));
    return outcome.status === 'moved';
  }
  async function execute(source: WorkspaceFile, directory: string, undoToken?: string) {
    if (undoToken && (undo?.root !== current.current.root || undo.token !== undoToken)) { current.current.message('资料目录已变化，请回到原目录后重新选择移动。'); return false; }
    openRequest.current++;
    setBusy(true); clearDrag(); const root = current.current.root;
    try { return await accept(await coordinator.current.run(context(), { root, source, directory, undoToken }), root, !!undoToken); }
    finally { setBusy(false); }
  }
  function targetProps(directory: string): TargetProps {
    const permission = () => fileDropPermission(drag.current?.source || null, current.current.root, directory, !available());
    const ours = (event: DragEvent) => !!drag.current && event.dataTransfer.types.includes(MIME);
    return { 'data-drop-state': dragging && hovered?.path === directory ? hovered.allowed ? 'allowed' : 'blocked' : undefined,
      'data-move-received': received === directory || undefined,
      onDragOver(event) {
        if (!ours(event)) return; const allowed = permission(); event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = allowed.allowed ? 'move' : 'none';
        setHovered(previous => previous?.path === directory && previous.allowed === allowed.allowed ? previous : { path: directory, ...allowed });
        if (hover.current === directory) return; hover.current = directory; window.clearTimeout(timer.current);
        if (allowed.allowed && preview?.directory !== directory) {
          const session = drag.current!;
          timer.current = window.setTimeout(() => { void reader().listDirectory({ root: session.root, directory }).then(listing => {
            if (drag.current?.id === session.id && current.current.root === session.root && hover.current === directory) setPreview(listing);
          }).catch(() => {}); }, 550);
        }
      },
      onDragLeave(event) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (hover.current === directory) { hover.current = ''; window.clearTimeout(timer.current); setHovered(null); }
      },
      onDrop(event) {
        if (!ours(event)) return; event.preventDefault(); event.stopPropagation(); const session = drag.current!;
        if (!permission().allowed || session.root !== current.current.root || event.dataTransfer.getData(MIME) !== session.id) { clearDrag(); return; }
        const source = session.source; clearDrag(); void execute(source, directory);
      } };
  }
  function entryProps(entry: WorkspaceDirectoryEntry): TargetProps {
    if (entry.kind === 'folder') return targetProps(entry.path);
    return { draggable: available(), 'data-move-received': received === entry.path || undefined,
      onDragStart(event) {
        if (!available()) { event.preventDefault(); return; }
        const id = crypto.randomUUID(); drag.current = { id, source: entry, root: current.current.root };
        event.dataTransfer.clearData(); event.dataTransfer.setData(MIME, id); event.dataTransfer.effectAllowed = 'move'; setDragging(true);
      }, onDragEnd: clearDrag };
  }
  const panel = <>
    {checkingPending && <div className="file-move-receipt" role="status">正在核对上次文件移动，新的移动暂不可用。</div>}
    {pendingError && <div className="file-move-receipt" role="alert"><span>{pendingError}</span><button disabled={busy || checkingPending} onClick={() => void checkPending()}>重试核对移动记录</button></div>}
    {dragging && <div className="file-drag-status" role="status" aria-live="polite">{hovered?.reason || '拖到文件夹、上一级或地址栏，松开后移动，可撤销。'}</div>}
    {dragging && preview && <div className="file-drop-preview" role="group" aria-label="拖放子文件夹预览">
      <div><FolderOpen size={14}/><span>{preview.directory}</span></div>
      <button {...targetProps(preview.directory)} tabIndex={-1}>放到此文件夹</button>
      {preview.parent && <button {...targetProps(preview.parent)} tabIndex={-1}><ArrowLeft size={13}/>上一级</button>}
      {preview.entries.filter(item => item.kind === 'folder').map(item => <button key={item.path} {...targetProps(item.path)} tabIndex={-1}><Folder size={13}/>{item.name}</button>)}
      {!preview.entries.some(item => item.kind === 'folder') && <small>没有下级文件夹，松开后移动到此处。</small>}
    </div>}
    {undo && <div className="file-move-receipt" role="status"><span>已移动“{undo.source.name}”</span><button disabled={busy || !available()} onClick={() => void execute(undo.source, undo.directory, undo.token)}><Undo2 size={13}/>撤销移动</button></div>}
  </>;
  const dialogs = <>
    {proposal && !options.blocked && <FileMoveDialog root={options.root} source={proposal.source} initialDirectory={proposal.directory} refreshKey={proposal.id} busy={busy}
      onCancel={() => { openRequest.current++; setProposal(null); }} returnFocus={() => returnFocus.current?.isConnected ? returnFocus.current : document.querySelector('.file-list button')}
      onRefresh={() => void open(proposal.source, proposal.directory, true)} onConfirm={directory => execute(proposal.source, directory)}/>}
    {issue && <MoveRecoveryDialog issue={issue} busy={busy} onCheck={async recover => {
      setBusy(true); try { await accept(recover ? await coordinator.current.recover(context()) : await coordinator.current.recheck(context()), options.root); } finally { setBusy(false); }
    }}/>}
  </>;
  return { entryProps, targetProps, open, panel, dialogs, busy };
}

function FileMoveDialog({ root, source, initialDirectory, refreshKey, onCancel, onConfirm, onRefresh, busy, returnFocus }: {
  root: string; source: WorkspaceFile; initialDirectory: string; refreshKey: number; onCancel(): void; onConfirm(directory: string): Promise<boolean>; onRefresh(): void; busy: boolean; returnFocus(): HTMLElement | null;
}) {
  const title = useId(), description = useId(), [directory, setDirectory] = useState(initialDirectory);
  const [listing, setListing] = useState<DirectoryListing | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const request = useRef(0), submitted = useRef(false);
  useEffect(() => { const id = ++request.current; setLoading(true); setListing(null); setError('');
    void reader().listDirectory({ root, directory }).then(value => { if (id === request.current) setListing(value); }).catch(value => { if (id === request.current) setError(String(value)); }).finally(() => { if (id === request.current) setLoading(false); });
    return () => { request.current++; };
  }, [root, directory, source.moveVersion, refreshKey]);
  const permission = fileDropPermission(source, root, directory, busy || loading || !!error || listing?.directory !== directory);
  const collision = listing?.entries.some(item => item.name.toLocaleLowerCase() === source.name.toLocaleLowerCase());
  return <DialogFrame labelledBy={title} describedBy={description} onCancel={onCancel} busy={busy} returnFocus={returnFocus} className="file-move-dialog">
    <div className="dialog-head"><h2 id={title}><MoveRight size={19}/>移动“{source.name}”</h2></div>
    <p id={description}>源位置：{source.path}<br/>目标文件夹：{directory}</p>
    <nav className="move-folder-address" aria-label="移动目标地址">{listing?.breadcrumbs.map(item => <button key={item.path} disabled={busy || loading} aria-current={item.path === directory ? 'location' : undefined} onClick={() => setDirectory(item.path)}>{item.name}</button>)}</nav>
    <div className="move-folder-rows" aria-label="选择目标文件夹" aria-busy={loading}>
      {listing?.parent && <button disabled={busy || loading} onClick={() => setDirectory(listing.parent!)}><ArrowLeft size={15}/>上一级文件夹</button>}
      {listing?.entries.filter(item => item.kind === 'folder').map(item => <button key={item.path} disabled={busy || loading} onClick={() => setDirectory(item.path)}><Folder size={15}/>{item.name}</button>)}
      {loading ? <p role="status">正在读取文件夹…</p> : !listing?.entries.some(item => item.kind === 'folder') && <p>没有下级文件夹，可选择当前文件夹。</p>}
    </div>
    <p className="move-file-guidance">确认后会先保存已打开的笔记和阅读进度。只移动所选文件，不改写正文；Markdown 相对链接将按新位置解析，附件仍留在原处。</p>
    {(error || collision) && <p className="dialog-error" role="alert">{error || '此文件夹已有同名文件或目录，请选择其他位置；不会覆盖。'}</p>}
    <div className="dialog-actions"><button data-dialog-default disabled={busy} onClick={onCancel}>取消</button><button disabled={busy} onClick={onRefresh}>重新检查源文件</button><button className="primary" disabled={!permission.allowed || collision} title={permission.reason} onClick={() => {
      if (submitted.current) return; submitted.current = true; void onConfirm(directory).then(ok => { if (!ok) setError('移动尚未完成，请处理保存提示或重新检查源文件。'); }).finally(() => { submitted.current = false; });
    }}>{busy ? '正在移动…' : '移动到此文件夹'}</button></div>
  </DialogFrame>;
}
function MoveRecoveryDialog({ issue, busy, onCheck }: { issue: MoveIssue; busy: boolean; onCheck(recover: boolean): Promise<void> }) {
  const title = useId();
  return <DialogFrame labelledBy={title} busy={busy} className="file-move-dialog">
    <h2 id={title}>移动结果需要核对</h2><p role="alert">{issue.message}</p>
    <p>当前内容保持保护，暂不接受下一轮移动。不会自动重试、回滚正文或覆盖同名文件；请先在资料目录核对。</p>
    <div className="dialog-actions"><button disabled={busy} onClick={() => void reader().showItemInFolder(issue.recoveryPath || parentPath(issue.oldPath)).catch(() => {})}>打开资料位置</button>
      <button disabled={busy} onClick={() => void onCheck(false)}>重新核对结果</button>{issue.recoveryPath && <button disabled={busy} onClick={() => void onCheck(true)}>将暂存文件恢复原位</button>}</div>
  </DialogFrame>;
}
