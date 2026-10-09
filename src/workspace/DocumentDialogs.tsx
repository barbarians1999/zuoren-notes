import { AlertTriangle, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef } from 'react';
import type { SaveNoteResult } from '../types';

// Stay inside the renderer: blocking window.confirm can leave Electron's
// native owner active while its content no longer receives input on Windows.
export function TrashConfirmation({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  const title = useId(), description = useId();
  const dialog = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel); cancelRef.current = onCancel;
  useLayoutEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus({ preventScroll: true });
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) cancel.current?.focus({ preventScroll: true });
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRef.current(); }
      if (event.key !== 'Tab') return;
      const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === buttons.length - 1)) {
        event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
      }
    };
    document.addEventListener('focusin', keepFocus);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('focusin', keepFocus);
      document.removeEventListener('keydown', key, true);
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);
  return <div className="modal-backdrop"><div ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-labelledby={title} aria-describedby={description}>
    <div className="dialog-head"><h2 id={title}><AlertTriangle size={20}/>移到回收站</h2><button aria-label="取消回收" onClick={onCancel}><X/></button></div>
    <p id={description}>确定将“{name}”移到回收站吗？文件可以从 Windows 回收站恢复。</p>
    <div className="dialog-actions"><button ref={cancel} onClick={onCancel}>取消</button><button className="primary" onClick={onConfirm}>移到回收站</button></div>
  </div></div>;
}
export function UnsavedDialog({ description, onCancel, onDiscard, onSave }: { description: string; onCancel: () => void; onDiscard: () => Promise<void>; onSave: () => Promise<void> }) {
  return <div className="modal-backdrop"><div className="dialog unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-title"><div className="dialog-head"><h2 id="unsaved-title"><AlertTriangle size={20}/>还有未保存的修改</h2><button aria-label="取消操作" onClick={onCancel}><X/></button></div><p>继续{description}前，当前笔记还有未保存内容。</p><div className="dialog-actions"><button onClick={() => void onDiscard()}>放弃修改</button><button onClick={onCancel}>取消</button><button className="primary" autoFocus onClick={() => void onSave()}>保存并继续</button></div></div></div>;
}

export function ConflictDialog({ conflict, mine, closing, onMine, onDisk, onSaveAs }: { conflict: SaveNoteResult & { conflict: true }; mine: string; closing: boolean; onMine: () => void; onDisk: () => void; onSaveAs: () => void }) {
  return <div className="modal-backdrop"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title"><div className="dialog-head"><h2 id="conflict-title"><AlertTriangle size={20}/>文件发生外部修改</h2></div><p>{closing ? '关闭前需要先处理这次冲突。' : '检测到磁盘版本已经变化。你的内容和磁盘内容都保留在这里，请选择要继续使用的版本。'}</p><p className="dialog-context"><strong>{conflict.path.split(/[\\/]/).pop() || conflict.path}</strong><br/><span title={conflict.path}>{conflict.path}</span></p><div className="diff"><div><label>我的内容（当前编辑稿）</label><pre>{mine}</pre></div><div><label>磁盘内容（外部修改后）</label><pre>{conflict.content}</pre></div></div><div className="dialog-actions"><button onClick={onSaveAs}>将我的内容另存为</button><button onClick={onDisk}>使用磁盘内容</button><button className="primary" onClick={onMine}>保留我的内容</button></div></div></div>;
}
