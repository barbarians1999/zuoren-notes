import type { EpubAnchor, ReaderAnchor } from './types';
export function isEpubAnchor(anchor: ReaderAnchor | null | undefined): anchor is EpubAnchor;
export function encodeReaderAnchor(anchor: ReaderAnchor): string;
export function decodeReaderAnchor(href: string): ReaderAnchor | null;
export function formatEpubAnchor(anchor: EpubAnchor, bookName: string): string;
