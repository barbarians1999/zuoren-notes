export interface LiteralMatch {
  from: number;
  to: number;
}

export interface ReplaceResult {
  text: string;
  count: number;
}

/** Find non-overlapping literal matches. Offsets use JavaScript/CodeMirror UTF-16 positions. */
export function findLiteralMatches(text: string, query: string, caseSensitive = false): LiteralMatch[] {
  if (!query) return [];
  const folded: string[] = [];
  const offsets: LiteralMatch[] = [];
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!;
    const character = String.fromCodePoint(point);
    const next = index + character.length;
    const mapped = caseSensitive ? character : character.toLowerCase();
    for (let offset = 0; offset < mapped.length; offset += 1) {
      folded.push(mapped[offset]);
      offsets.push({ from: index, to: next });
    }
    index = next;
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const haystack = folded.join('');
  const matches: LiteralMatch[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    matches.push({ from: offsets[found].from, to: offsets[found + needle.length - 1].to });
    cursor = found + needle.length;
  }
  return matches;
}

/** Select the next match index, wrapping in either direction. */
export function stepMatchIndex(length: number, currentIndex: number, direction: 1 | -1): number {
  if (length <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= length) return direction === 1 ? 0 : length - 1;
  return (currentIndex + direction + length) % length;
}

export function replaceLiteralMatch(text: string, matches: readonly LiteralMatch[], index: number, replacement: string): ReplaceResult {
  const match = matches[index];
  if (!match || match.from < 0 || match.to < match.from || match.to > text.length) return { text, count: 0 };
  return { text: text.slice(0, match.from) + replacement + text.slice(match.to), count: 1 };
}

export function replaceAllLiteralMatches(text: string, matches: readonly LiteralMatch[], replacement: string): ReplaceResult {
  if (!matches.length) return { text, count: 0 };
  let result = text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match.from < 0 || match.to < match.from || match.to > result.length) continue;
    result = result.slice(0, match.from) + replacement + result.slice(match.to);
  }
  return { text: result, count: matches.length };
}

export function replaceAllLiteral(text: string, query: string, replacement: string, caseSensitive = false): ReplaceResult {
  return replaceAllLiteralMatches(text, findLiteralMatches(text, query, caseSensitive), replacement);
}
