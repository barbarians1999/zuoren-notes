export interface LiteralMatch {
  from: number;
  to: number;
}

export interface ReplaceResult {
  text: string;
  count: number;
}

/** Find non-overlapping literal matches. Offsets use JavaScript/CodeMirror UTF-16 positions. */
export function findLiteralMatches(text: string, query: string, caseSensitive = false, limit = Infinity): LiteralMatch[] {
  if (!query || limit <= 0) return [];
  // Most case folds keep their UTF-16 length. Record only expansions, rather
  // than allocating an object for every character of every searched document.
  const expansions: { from: number; to: number; source: number; length: number; delta: number }[] = [];
  let delta = 0;
  const haystack = caseSensitive ? text : text.replace(/[A-Z]|[^\x00-\x7f]/gu, (character: string, index: number) => {
    const mapped = character.toLowerCase();
    if (mapped.length !== character.length) {
      const from = index + delta;
      delta += mapped.length - character.length;
      expansions.push({ from, to: from + mapped.length, source: index, length: character.length, delta });
    }
    return mapped;
  });
  const sourceOffset = (position: number, end: boolean) => {
    let low = 0, high = expansions.length;
    const at = end ? position - 1 : position;
    while (low < high) { const middle = (low + high) >>> 1; if (expansions[middle].from <= at) low = middle + 1; else high = middle; }
    const expansion = expansions[low - 1];
    let offset = expansion && at < expansion.to ? expansion.source + (end ? expansion.length : 0) : position - (expansion?.delta || 0);
    // A literal half-surrogate match must still cover the complete code point,
    // matching the old offset map without retaining that map for all text.
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] || '') && /[\uD800-\uDBFF]/.test(text[offset - 1])) offset += end ? 1 : -1;
    return offset;
  };
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: LiteralMatch[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    matches.push({ from: sourceOffset(found, false), to: sourceOffset(found + needle.length, true) });
    if (matches.length >= limit) break;
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
