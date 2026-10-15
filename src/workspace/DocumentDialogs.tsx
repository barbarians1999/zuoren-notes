import { AlertTriangle, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { SaveNoteResult } from '../types';
import { DialogFrame } from '../ui/overlays';

// Stay inside the renderer: blocking window.confirm can leave Electron's
// native owner active while its content no longer receives input on Windows.
function useDialogAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (action: () => void | Promise<void | boolean>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { if (await action() === false && mounted.current) setError('操作尚未完成，请处理提示后重试。'); }
    catch (failure) { if (mounted.current) setError(`操作失败：${String(failure)}`); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  return { busy, error, run };
}

export function TrashConfirmation({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void | Promise<boolean | void> }) {
  const title = useId(), description = useId(), action = useDialogAction();
  return <DialogFrame labelledBy={title} describedBy={description} onCancel={onCancel} busy={action.busy}>
    <div className="dialog-head"><h2 id={title}><AlertTriangle size={20}/>移到回收站</h2><button disabled={action.busy} aria-label="取消回收" onClick={onCancel}><X/></button></div>
    <p id={description}>确定将“{name}”移到回收站吗？文件可以从 Windows 回收站恢复。</p>
    {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    <div className="dialog-actions"><button data-dialog-default disabled={action.busy} onClick={onCancel}>取消</button><button disabled={action.busy} className="primary" onClick={() => void action.run(onConfirm)}>移到回收站</button></div>
  </DialogFrame>;
}
export function UnsavedDialog({ description, onCancel, onDiscard, onSave }: { description: string; onCancel: () => void; onDiscard: () => Promise<void>; onSave: () => Promise<void> }) {
  const title = useId(), action = useDialogAction();
  return <DialogFrame labelledBy={title} className="unsaved-dialog" onCancel={onCancel} busy={action.busy}><div className="dialog-head"><h2 id={title}><AlertTriangle size={20}/>还有未保存的修改</h2><button disabled={action.busy} aria-label="取消操作" onClick={onCancel}><X/></button></div><p>继续{description}前，当前笔记还有未保存内容。</p>{action.error && <p className="dialog-error" role="alert">{action.error}</p>}<div className="dialog-actions"><button disabled={action.busy} onClick={() => void action.run(onDiscard)}>放弃修改</button><button disabled={action.busy} onClick={onCancel}>取消</button><button disabled={action.busy} className="primary" data-dialog-default onClick={() => void action.run(onSave)}>保存并继续</button></div></DialogFrame>;
}

export function ConflictDialog({ conflict, mine, closing, onMine, onDisk, onSaveAs }: { conflict: SaveNoteResult & { conflict: true }; mine: string; closing: boolean; onMine: () => void | Promise<void>; onDisk: () => void | Promise<void>; onSaveAs: () => void | Promise<void> }) {
  const title = useId(), action = useDialogAction();
  return <DialogFrame labelledBy={title} busy={action.busy}><div className="dialog-head"><h2 id={title}><AlertTriangle size={20}/>文件发生外部修改</h2></div><p>{closing ? '关闭前需要先处理这次冲突。' : '检测到磁盘版本已经变化。你的内容和磁盘内容都保留在这里，请选择要继续使用的版本。'}</p><p className="dialog-context"><strong>{conflict.path.split(/[\\/]/).pop() || conflict.path}</strong><br/><span title={conflict.path}>{conflict.path}</span></p><div className="diff"><div><label>我的内容（当前编辑稿）</label><pre>{mine}</pre></div><div><label>磁盘内容（外部修改后）</label><pre>{conflict.content}</pre></div></div>{action.error && <p className="dialog-error" role="alert">{action.error}</p>}<div className="dialog-actions"><button disabled={action.busy} onClick={() => void action.run(onSaveAs)}>将我的内容另存为</button><button disabled={action.busy} onClick={() => void action.run(onDisk)}>使用磁盘内容</button><button disabled={action.busy} className="primary" onClick={() => void action.run(onMine)}>保留我的内容</button></div></DialogFrame>;
}
