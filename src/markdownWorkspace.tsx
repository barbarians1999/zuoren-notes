import React, { type ReactNode } from 'react';
import { ChevronRight, Eye, List, Pencil, Search, Save } from 'lucide-react';

export type WorkspaceMode = 'edit' | 'preview';

type WorkspaceHeaderProps = {
  path: string;
  caption?: ReactNode;
  label?: string;
  mode: WorkspaceMode;
  outline: boolean;
  onFind: () => void;
  onToggleMode: () => void;
  onToggleOutline: () => void;
};

function pathParts(path: string) {
  return path.split(/[\\/]/).filter(Boolean);
}

export function MarkdownWorkspaceHeader({ path, caption, label, mode, outline, onFind, onToggleMode, onToggleOutline }: WorkspaceHeaderProps) {
  const parts = pathParts(path);
  const file = parts.at(-1) || '未命名笔记';
  const parent = parts.at(-2) || '笔记库';
  return <div className="markdown-workspace-head note-toolbar">
    <div className="markdown-breadcrumb" title={path}>
      <span className="markdown-breadcrumb-root">{parent}</span>
      <ChevronRight size={13} aria-hidden="true" />
      <span className="note-caption workspace-caption">{caption || <strong>{file}</strong>}</span>
      {label && <span className={'compact-save workspace-compat-save markdown-save-state state-' + label.replace(/[^一-龥a-z]+/gi, '-')}><Save size={12} aria-hidden="true" />{label}</span>}
    </div>
    <div className="markdown-workspace-actions">
      <button className="workspace-icon-action" aria-label="查找" title="查找（Ctrl+F）" onClick={onFind}><Search size={15} /></button>
      <div className="workspace-mode-switch" role="group" aria-label="笔记模式">
        <button className={mode === 'edit' ? 'active' : ''} aria-pressed={mode === 'edit'} aria-label={mode === 'edit' ? '源码编辑模式' : '切换到源码编辑'} title={mode === 'edit' ? '源码编辑模式（Obsidian）' : '切换到源码编辑'} onClick={() => mode !== 'edit' && onToggleMode()}><Pencil size={14} /><span>编辑</span></button>
        <button className={mode === 'preview' ? 'active' : ''} aria-pressed={mode === 'preview'} aria-label={mode === 'preview' ? '阅读模式' : '切换到预览'} title={mode === 'preview' ? '阅读模式' : '切换到预览'} onClick={() => mode !== 'preview' && onToggleMode()}><Eye size={14} /><span>阅读</span></button>
      </div>
      <button className={'workspace-icon-action ' + (outline ? 'active' : '')} aria-label={outline ? '收起大纲' : '展开大纲'} aria-pressed={outline} title={outline ? '收起大纲' : '展开大纲'} onClick={onToggleOutline}><List size={15} /></button>
    </div>
  </div>;
}
