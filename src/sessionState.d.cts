import type { MarkdownScrollMemory } from './types';
export const MAX_SCROLL_MEMORY_ENTRIES: 100;
export const MAX_SCROLL_TOP: 10000000;
export function movePathBefore(paths: string[], movedPath: string, beforePath: string): string[];
export function validScrollEntry(value: unknown): value is MarkdownScrollMemory;
export function sanitizeScrollMemory(entries: unknown, limit?: number): MarkdownScrollMemory[];
export function upsertScrollMemory(entries: unknown, entry: MarkdownScrollMemory, limit?: number): MarkdownScrollMemory[];
export function resolveScrollTop(entry: MarkdownScrollMemory, maxScrollTop: number): number;
