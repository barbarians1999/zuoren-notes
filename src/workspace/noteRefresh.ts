import type { Layout } from '../readerContext';
import type { NoteWorkspace } from './noteWorkspace';

// Shared by the native F5 bridge and non-graphical integration tests. Keep
// presentation/close gates ahead of reading any document or disk state.
export async function requestNoteRefresh(workspace: NoteWorkspace, context: {
  ready: boolean; blocked: boolean; layout: Layout; activeSurface: 'reader' | 'note';
}, message: (text: string) => void) {
  if (!context.ready || context.blocked || workspace.committing) return 'blocked' as const;
  if (context.layout === 'read' || (context.layout === 'split' && context.activeSurface === 'reader')) {
    message('F5 目前用于刷新 Markdown 笔记；PDF、EPUB 的批注和阅读进度按文件身份保护，未重新载入。');
    return 'reader' as const;
  }
  const doc = workspace.currentDocument();
  if (!doc) { message('请先打开要刷新的 Markdown 笔记。'); return 'empty' as const; }
  return doc.refresh();
}
