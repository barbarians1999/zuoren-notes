import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowLeftRight, Columns2, Plus, X } from 'lucide-react';
import type { FindCommand } from '../readerContext';
import type { MarkdownScrollMemory, ReaderAnchor } from '../types';
import { NotePane } from '../editor/NotePane';
import { createPortal } from 'react-dom';
import type { NoteWorkspace, NoteGroupId } from './noteWorkspace';
import { ContextMenu } from '../ui/overlays';

export function NoteGroupPane({ workspace, group, findCommand, onJump, insertRegister, scrollMemory, rememberScroll, onOpen, onNew, onRight, onSplit, split, hidden = false, tabsTarget, controlsTarget, foreground = true, onFocus }: {
  workspace: NoteWorkspace; group: NoteGroupId; findCommand: FindCommand | null;
  onJump: (anchor: ReaderAnchor, path?: string) => void; insertRegister: MutableRefObject<(block: string) => boolean>;
  scrollMemory: MarkdownScrollMemory[]; rememberScroll: (entry: MarkdownScrollMemory) => void;
  onOpen: () => void; onNew: () => void; onRight: (path: string) => void; onSplit: () => void; split: boolean; hidden?: boolean;
  tabsTarget: HTMLElement | null; controlsTarget: HTMLElement | null;
  foreground?: boolean; onFocus?: () => void;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement | null } | null>(null);
  const [dropping, setDropping] = useState(false);
  const value = workspace.groups[group], tab = workspace.current(group), doc = tab?.document || null;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tab || hidden || workspace.focusRequest !== tab.id) return;
    const frame = requestAnimationFrame(() => {
      if (!workspace.consumeFocus(tab.id)) return;
      host.current?.querySelector<HTMLElement>(tab.mode === 'preview' ? '.markdown-preview' : '.cm-content')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [tab?.id, hidden, workspace, workspace.focusRequest]);
  useEffect(() => {
    if (hidden || workspace.activeGroup !== group || !tabsTarget) return;
    let frame = 0;
    const reveal = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => tabsTarget.querySelector<HTMLElement>(`[data-view-id="${tab?.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })); };
    reveal();
    const observer = new ResizeObserver(reveal); observer.observe(tabsTarget);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [tab?.id, hidden, workspace.activeGroup, tabsTarget, group]);
  useEffect(() => { setMenu(null); }, [workspace.activeGroup, hidden]);
  const selected = menu && value.tabs.find(tab => tab.id === menu.id);
  const scroll = rememberScroll;
  const drop = (event: React.DragEvent, beforeId?: string) => {
    event.preventDefault();
    setDropping(false);
    try {
      const item = JSON.parse(event.dataTransfer.getData('text/x-zuoren-note-view'));
      if ((item.group === 'primary' || item.group === 'secondary') && typeof item.id === 'string') {
        const rect = event.currentTarget.getBoundingClientRect(); workspace.move(item.group, item.id, group, beforeId, !!beforeId && event.clientX > rect.left + rect.width / 2);
      }
    } catch { /* unrelated drags do not change the workspace */ }
  };
  return <div ref={host} className={'note-group ' + (workspace.activeGroup === group ? 'active-group ' : '') + (dropping ? 'note-drop-target' : '')} data-note-group={group} style={hidden ? { display: 'none' } : undefined}
    onPointerDownCapture={() => { onFocus?.(); if (workspace.activeGroup !== group) workspace.activate(group); }} onFocusCapture={() => { onFocus?.(); if (workspace.activeGroup !== group) workspace.activate(group); }}
    onDragOver={event => { if (event.dataTransfer.types.includes('text/x-zuoren-note-view')) event.preventDefault(); }}
    onDragEnter={event => { if (event.dataTransfer.types.includes('text/x-zuoren-note-view')) setDropping(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
    onDrop={event => { if (event.dataTransfer.types.includes('text/x-zuoren-note-view')) drop(event); }}>
    {tabsTarget && createPortal(<div className="note-tab-cluster" data-tabs-group={group} role="tablist" aria-label={group === 'primary' ? '左栏笔记标签' : '右栏笔记标签'} onDragOver={event => event.preventDefault()} onDrop={event => { event.stopPropagation(); drop(event); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || !(event.target as Element).matches('[role="tab"]')) return;
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')], index = tabs.indexOf(event.target as HTMLButtonElement);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0 || !tabs[next]) return;
        event.preventDefault(); event.stopPropagation();
        const id = tabs[next].closest<HTMLElement>('[data-view-id]')!.dataset.viewId!;
        workspace.activate(group, id); workspace.consumeFocus(id); tabs[next].focus({ preventScroll: true });
      }}>
      {value.tabs.map(item => <div draggable key={item.id} className={'document-tab ' + (value.activeId === item.id ? 'active ' : '') + (foreground && workspace.activeGroup === group && value.activeId === item.id ? 'foreground-tab ' : '') + (item.preview ? 'preview-tab' : '')} data-view-id={item.id}
        onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/x-zuoren-note-view', JSON.stringify({ group, id: item.id })); }}
        onDrop={event => { event.stopPropagation(); drop(event, item.id); }}
        onContextMenu={event => { event.preventDefault(); const trigger = event.currentTarget.querySelector<HTMLElement>('[role="tab"]'), box = event.currentTarget.getBoundingClientRect(); setMenu({ id: item.id, x: event.clientX || box.left, y: event.clientY || box.bottom, trigger }); }}>
        <button role="tab" tabIndex={value.activeId === item.id ? 0 : -1} aria-selected={value.activeId === item.id} title={(item.document?.note.path || '空白标签') + (item.preview ? '\n临时标签：双击保留' : '')}
          onClick={() => workspace.activate(group, item.id)} onDoubleClick={() => workspace.pin(item)}><span className="tab-file-name">{item.document?.note.path.split(/[\\/]/).pop() || '新标签'}</span>{workspace.groups.secondary.tabs.length > 0 && <span className="tab-pane-hint" aria-hidden="true">{group === 'primary' ? '左' : '右'}</span>}{item.document && item.document.label !== '已保存' && <span className="tab-status" title={item.document.label}>{item.document.label === '保存失败' || item.document.label === '外部冲突' ? ' !' : ' •'}</span>}</button>
        <button tabIndex={-1} aria-label={'关闭 ' + (item.document?.note.path.split(/[\\/]/).pop() || '空白标签')} title="关闭标签（Ctrl+W）" onClick={() => void workspace.close(group, item)}><X size={13}/></button>
      </div>)}
    </div>, tabsTarget)}
    <NotePane paneId={group} onActivate={id => workspace.activeGroup !== id && workspace.activate(id)} findCommand={findCommand}
      note={doc?.note || null} text={doc?.text || ''} label={doc?.label} mode={tab?.mode || 'edit'} setMode={mode => { if (tab) workspace.setMode(group, tab.id, mode === 'preview' ? 'preview' : 'edit'); }}
      onSave={() => { if (doc) void doc.save(); }} onJump={onJump} revision={doc?.revision || 0} excerptRegister={insertRegister}
      sharedDocument={doc} tab={tab} scrollMemory={scrollMemory} onScrollMemory={scroll} hidden={hidden}
      unifiedHeader headerTarget={!hidden && workspace.activeGroup === group ? controlsTarget : null}
      headerControls={<><button className="workspace-icon-action" aria-label="新建空白标签" title="新标签" onClick={() => workspace.blank(group)}><Plus size={16}/></button>
        <button className={'workspace-icon-action' + (split ? ' active' : '')} aria-label="左右分屏笔记" aria-pressed={split} title={split ? '恢复单栏（保留全部标签）' : '在右侧打开当前笔记'} onClick={onSplit}><Columns2 size={17}/></button></>}/>
    {!doc && <div className="empty-tab-actions"><button onClick={onOpen}>打开笔记</button><button onClick={onNew}>新建笔记</button></div>}
    {selected && menu && <ContextMenu x={menu.x} y={menu.y} returnFocus={menu.trigger} label="标签操作" onClose={() => setMenu(null)}>
      {selected.document && <button role="menuitem" onClick={() => { setMenu(null); onRight(selected.document!.note.path); }}>在右侧打开</button>}
      {!!workspace.groups.secondary.tabs.length && <><button role="menuitem" aria-label="交换左右笔记" onClick={() => { setMenu(null); workspace.swap(); }}><ArrowLeftRight size={15}/>交换左右笔记</button>
        <button role="menuitem" aria-label="关闭笔记分屏" onClick={() => { setMenu(null); workspace.merge(); }}><Columns2 size={15}/>合并左右标签</button></>}
      {!!selected.document?.retainedRecoveryIds.length && <button role="menuitem" onClick={() => { setMenu(null); void workspace.copyRetainedRecovery(selected.document!).catch(workspace.report); }}>旧恢复稿副本</button>}
      <button role="menuitem" onClick={() => { setMenu(null); void workspace.close(group, selected); }}><span>关闭</span>{value.activeId === selected.id && <kbd aria-hidden="true">Ctrl+W</kbd>}</button>
    </ContextMenu>}
  </div>;
}
