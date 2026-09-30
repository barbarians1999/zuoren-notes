import { findLiteralMatches, type LiteralMatch } from './findReplace.ts';

export type PdfSearchMatch = LiteralMatch & { page: number; occurrence: number; stableKey: string };
export type NormalizedPdfText = { text: string; starts: number[]; ends: number[] };

function needsWordSpace(previous: string, next: string) {
  return /[A-Za-z0-9]/u.test(previous) && /[A-Za-z0-9]/u.test(next);
}

export function normalizePdfSearchTextWithMap(raw: string): NormalizedPdfText {
  let text = '';
  const starts: number[] = [], ends: number[] = [];
  for (let index = 0; index < raw.length;) {
    if (/\s/u.test(raw[index])) {
      const start = index;
      while (index < raw.length && /\s/u.test(raw[index])) index += 1;
      if (text && text.at(-1) !== ' ') { text += ' '; starts.push(start); ends.push(index); }
      continue;
    }
    text += raw[index]; starts.push(index); ends.push(index + 1); index += 1;
  }
  return { text, starts, ends };
}

export function normalizePdfSearchText(raw: string): string {
  return normalizePdfSearchTextWithMap(raw).text;
}

export function pdfPageText(items: readonly { str?: unknown; hasEOL?: unknown }[]): string {
  let raw = '';
  for (const item of items) {
    const value = typeof item.str === 'string' ? item.str : '';
    if (value) {
      const previous = raw.at(-1) || '';
      if (previous && !/\s/u.test(previous) && needsWordSpace(previous, value[0] || '')) raw += ' ';
      raw += value;
    }
    if (item.hasEOL) raw += '\n';
  }
  return normalizePdfSearchText(raw);
}

export function findPdfPageMatches(text: string, query: string, caseSensitive = false): LiteralMatch[] {
  const normalizedQuery = normalizePdfSearchText(query).trim();
  return normalizedQuery ? findLiteralMatches(normalizePdfSearchText(text), normalizedQuery, caseSensitive) : [];
}

export function collectPdfSearchMatches(pageTexts: readonly string[], query: string, caseSensitive = false, limit = 5000): PdfSearchMatch[] {
  if (!query || limit <= 0) return [];
  const results: PdfSearchMatch[] = [];
  for (let pageIndex = 0; pageIndex < pageTexts.length && results.length < limit; pageIndex += 1) {
    const matches = findPdfPageMatches(pageTexts[pageIndex], query, caseSensitive);
    for (let occurrence = 0; occurrence < matches.length && results.length < limit; occurrence += 1) {
      results.push({ page: pageIndex + 1, occurrence, stableKey: `${pageIndex + 1}:${occurrence}`, ...matches[occurrence] });
    }
  }
  return results;
}
