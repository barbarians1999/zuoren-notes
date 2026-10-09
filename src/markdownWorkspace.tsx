import type { ReactNode } from 'react';
import { ChevronRight, Eye, List, Pencil, Search, Save } from 'lucide-react';

export type WorkspaceMode = 'edit' | 'preview';

type WorkspaceHeaderProps = {
  path: string;
  caption?: ReactNode;
  label?: string;
  onSave: () => void;
  canSave: boolean;
  mode: WorkspaceMode;
  outline: boolean;
  onFind: () => void;
  onToggleMode: () => void;
  onToggleOutline: () => void;
  compact?: boolean;
  enabled?: boolean;
  controls?: ReactNode;
};

function pathParts(path: string) {
  return path.split(/[\\/]/).filter(Boolean);
}

export function MarkdownWorkspaceHeader({ path, caption, label, onSave, canSave, mode, outline, onFind, onToggleMode, onToggleOutline, compact = false, enabled = true, controls }: WorkspaceHeaderProps) {
  const parts = pathParts(path);
  const file = parts.at(-1) || '未命名笔记';
  const parent = parts.at(-2) || '笔记库';
  const save = label && <button type="button" aria-label="立即保存" title={canSave ? '立即保存（Ctrl+S）' : label === '外部冲突' ? '请先处理外部修改冲突' : `${label}（Ctrl+S）`} disabled={!canSave} onClick={onSave} className={'compact-save workspace-compat-save markdown-save-state state-' + label.replace(/[^一-龥a-z]+/gi, '-')}><Save size={12} aria-hidden="true" /><span>{label}</span></button>;
  return <div className={'markdown-workspace-head note-toolbar' + (compact ? ' compact-note-controls' : '')}>
    {!compact && <div className="markdown-breadcrumb" title={path}>
      <span className="markdown-breadcrumb-root">{parent}</span>
      <ChevronRight size={13} aria-hidden="true" />
      <span className="note-caption workspace-caption">{caption || <strong>{file}</strong>}</span>
      {save}
    </div>}
    {compact && save}
    <div className="markdown-workspace-actions">
      <button className="workspace-icon-action" aria-label="查找" title="查找（Ctrl+F）" disabled={!enabled} onClick={onFind}><Search size={15} /></button>
      <div className="workspace-mode-switch" role="group" aria-label="笔记模式">
        <button disabled={!enabled} className={mode === 'edit' ? 'active' : ''} aria-pressed={mode === 'edit'} aria-label={mode === 'edit' ? '源码编辑模式' : '切换到源码编辑'} title={mode === 'edit' ? '源码编辑模式（Obsidian）' : '切换到源码编辑'} onClick={() => mode !== 'edit' && onToggleMode()}><Pencil size={14} /><span>编辑</span></button>
        <button disabled={!enabled} className={mode === 'preview' ? 'active' : ''} aria-pressed={mode === 'preview'} aria-label={mode === 'preview' ? '阅读模式' : '切换到预览'} title={mode === 'preview' ? '阅读模式' : '切换到预览'} onClick={() => mode !== 'preview' && onToggleMode()}><Eye size={14} /><span>阅读</span></button>
      </div>
      {!compact && <button data-outline-toggle className={'workspace-icon-action ' + (outline ? 'active' : '')} aria-label={outline ? '收起大纲' : '展开大纲'} aria-pressed={outline} title={outline ? '收起大纲' : '展开大纲'} onClick={onToggleOutline}><List size={15} /></button>}
      {controls}
      {compact && <button data-outline-toggle className={'workspace-icon-action ' + (outline ? 'active' : '')} disabled={!enabled} aria-label={outline ? '收起大纲' : '展开大纲'} aria-pressed={outline} title={outline ? '收起大纲' : '展开大纲'} onClick={onToggleOutline}><List size={17}/></button>}
    </div>
  </div>;
}
