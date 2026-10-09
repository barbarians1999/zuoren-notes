import { findLiteralMatches } from '../findReplace';

export type EpubSectionMatch = { cfi: string; excerpt: string };
export type EpubSearchResult = EpubSectionMatch & { href: string; sectionIndex: number };
export type EpubSearchStatus = { processed: number; total: number; errors: number; truncated: boolean; results: EpubSearchResult[] };
export const EPUB_SEARCH_LIMIT = 500;

// One detached chapter at a time. Never unload sections owned by the reader.
export async function collectEpubMatches<T extends { href: string; index: number }>(
  sections: readonly T[], search: (section: T, limit: number) => Promise<EpubSectionMatch[]>,
  options: { signal: AbortSignal; onProgress?: (status: EpubSearchStatus) => void; limit?: number },
): Promise<EpubSearchStatus> {
  const limit = options.limit ?? EPUB_SEARCH_LIMIT;
  const status: EpubSearchStatus = { processed: 0, total: sections.length, errors: 0, truncated: false, results: [] };
  const cancelled = () => { if (options.signal.aborted) throw new DOMException('Search cancelled', 'AbortError'); };
  for (const section of sections) {
    cancelled();
    try {
      const matches = await search(section, Math.max(0, limit - status.results.length) + 1);
      cancelled();
      for (const match of matches) {
        if (status.results.length >= limit) { status.truncated = true; break; }
        status.results.push({ ...match, href: section.href, sectionIndex: section.index });
      }
    } catch (error) {
      cancelled();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      status.errors++;
    }
    status.processed++;
    options.onProgress?.({ ...status, results: [...status.results] });
    if (status.truncated) break;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  cancelled();
  return status;
}

export function findEpubSectionMatches(section: { contents: Element; document: Document; cfiFromRange(range: Range): string }, query: string, caseSensitive: boolean, limit: number): EpubSectionMatch[] {
  const root = section.document.querySelector('body') || section.contents;
  const nodes: { from: number; to: number; node: Text }[] = [];
  const parts: string[] = [];
  let length = 0, previousBlock: Element | null = null;
  const walker = section.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, parent = node.parentElement;
    if (!node.data || parent?.closest('script,style,noscript,head,[hidden],[aria-hidden="true"]')) continue;
    const block = parent?.closest('p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') || root;
    // Inline nodes are contiguous; different paragraphs must not create
    // invented words or matches spanning unrelated blocks.
    if (previousBlock && block !== previousBlock) { parts.push('\n'); length++; }
    nodes.push({ from: length, to: length + node.data.length, node });
    parts.push(node.data); length += node.data.length; previousBlock = block;
  }
  const text = parts.join('');
  return findLiteralMatches(text, query, caseSensitive, limit).flatMap(match => {
    const start = nodes.find(item => match.from >= item.from && match.from < item.to);
    const end = nodes.find(item => match.to > item.from && match.to <= item.to);
    if (!start || !end) return [];
    const range = section.document.createRange();
    range.setStart(start.node, match.from - start.from); range.setEnd(end.node, match.to - end.from);
    const from = Math.max(0, match.from - 45), to = Math.min(text.length, match.to + 70);
    return [{ cfi: section.cfiFromRange(range), excerpt: (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '') }];
  });
}
