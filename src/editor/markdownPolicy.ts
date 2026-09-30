// Shared non-standard syntax contract. Highlight is single-line, respects
// escaped delimiters and ignores == inside matching inline-code fences.
export function matchHighlight(source: string): { raw: string; inner: string } | null {
  if (!source.startsWith('==')) return null;
  for (let cursor = 2; cursor < source.length;) {
    if (source[cursor] === '\n' || source[cursor] === '\r') return null;
    if (source[cursor] === '\\') { cursor += 2; continue; }
    if (source[cursor] === '`') {
      const run = /^`+/.exec(source.slice(cursor))![0];
      const rest = source.slice(cursor + run.length).split(/\r?\n/, 1)[0];
      let closing = -1;
      for (const candidate of rest.matchAll(/`+/g)) {
        if (candidate[0].length === run.length) { closing = candidate.index!; break; }
      }
      if (closing >= 0) { cursor += run.length * 2 + closing; continue; }
    }
    if (source.startsWith('==', cursor)) return cursor > 2 ? { raw: source.slice(0, cursor + 2), inner: source.slice(2, cursor) } : null;
    cursor++;
  }
  return null;
}
