import type { PdfMeta, EpubMeta, PdfAnnotation, WorkspaceDirectoryEntry } from './types';
export type Layout = 'read' | 'note' | 'split';
export type { NoteMode } from './types';
export type { ThemePreference } from './appearanceTheme.cjs';
export type NoteBodyFont = 'default' | 'fangsong' | 'songti' | 'hanyi-shufang-55w';
export type SaveLabel = '已保存' | '编辑中' | '保存中' | '外部冲突' | '保存失败';
export type ActivePdf = { path: string; name: string; data: Uint8Array; meta: PdfMeta };
export type ActiveEpub = { path: string; name: string; data: Uint8Array; meta: EpubMeta };
export type FlatNavItem = { href: string; label: string; depth: number };
export type OcrDialog = { jobId: string; annotation: PdfAnnotation; imagePath: string; progress: number; status: string; text: string; error?: string };
export type FileContextMenu = { entry: WorkspaceDirectoryEntry; x: number; y: number };
export type InlineEntryEdit = { kind: 'note' | 'folder' | 'rename'; value: string; entry?: WorkspaceDirectoryEntry; parentPath?: string; error?: string; busy?: boolean };

export const NOTE_BODY_FONTS: Record<NoteBodyFont, string> = {
  default: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
  fangsong: '"字体管家仿宋体 (非商业使用)", "仿宋_GB2312", "仿宋", "FangSong", "华文仿宋", "STFangsong", serif',
  songti: '"宋体", "SimSun", "Songti SC", "STSong", "华文宋体", serif',
  'hanyi-shufang-55w': '"汉仪书仿 55W", "字体管家仿宋体 (非商业使用)", "仿宋", "FangSong", serif',
};
export const EPUB_MIN_SPREAD_WIDTH = 900;
export type FindCommand = { pane: 'primary' | 'secondary'; mode: 'find' | 'replace'; sequence: number };
export const reader = () => window.reader;
export function resolveLocal(baseFile: string, reference: string) {
  if (/^(data:|blob:|https?:|reader-asset:)/i.test(reference) || /^[a-zA-Z]:[\\/]/.test(reference)) return reference;
  const separator = baseFile.includes('\\') ? '\\' : '/';
  const pieces = baseFile.split(/[\\/]/); pieces.pop();
  for (const part of reference.split(/[\\/]/)) {
    if (!part || part === '.') continue;
    if (part === '..') pieces.pop(); else pieces.push(part);
  }
  return pieces.join(separator);
}
