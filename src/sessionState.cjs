const MAX_SCROLL_MEMORY_ENTRIES = 100;
const MAX_SCROLL_TOP = 10_000_000;
const panes = new Set(['primary', 'secondary']);
const modes = new Set(['edit', 'preview']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const absoluteWindowsPath = value => /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);

function normalizeWindowsPath(value) {
  const normalized = value.replaceAll('/', '\\');
  const prefix = normalized.startsWith('\\\\') ? '\\\\' : normalized.slice(0, 3);
  const rest = normalized.startsWith('\\\\') ? normalized.slice(2) : normalized.slice(3);
  const pieces = [];
  for (const piece of rest.split(/\\+/)) {
    if (!piece || piece === '.') continue;
    if (piece === '..' && pieces.length) pieces.pop();
    else if (piece !== '..') pieces.push(piece);
  }
  return prefix + pieces.join('\\');
}

function movePathBefore(paths, movedPath, beforePath) {
  const result = [...paths];
  const from = result.indexOf(movedPath);
  const to = result.indexOf(beforePath);
  if (from < 0 || to < 0 || from === to) return result;
  const [moved] = result.splice(from, 1);
  result.splice(result.indexOf(beforePath), 0, moved);
  return result;
}

function validScrollEntry(value) {
  return exactKeys(value, ['pane', 'path', 'mode', 'scrollTop', 'ratio'])
    && panes.has(value.pane)
    && typeof value.path === 'string' && value.path.length > 0 && !value.path.includes('\0') && absoluteWindowsPath(value.path)
    && modes.has(value.mode)
    && Number.isFinite(value.scrollTop) && value.scrollTop >= 0
    && Number.isFinite(value.ratio) && value.ratio >= 0 && value.ratio <= 1;
}

function scrollKey(entry) {
  return JSON.stringify([entry.pane, normalizeWindowsPath(entry.path), entry.mode]);
}

function sanitizeScrollMemory(entries, limit = MAX_SCROLL_MEMORY_ENTRIES) {
  if (!Array.isArray(entries)) return [];
  const cap = Math.max(0, Math.min(MAX_SCROLL_MEMORY_ENTRIES, Math.floor(Number.isFinite(limit) ? limit : MAX_SCROLL_MEMORY_ENTRIES)));
  if (!cap) return [];
  const seen = new Map();
  for (const entry of entries) {
    if (!validScrollEntry(entry)) continue;
    const normalized = {
      pane: entry.pane,
      path: normalizeWindowsPath(entry.path),
      mode: entry.mode,
      scrollTop: Math.min(MAX_SCROLL_TOP, entry.scrollTop),
      ratio: entry.ratio,
    };
    const key = scrollKey(normalized);
    if (seen.has(key)) seen.delete(key);
    seen.set(key, normalized);
  }
  return [...seen.values()].slice(-cap);
}

function upsertScrollMemory(entries, entry, limit = MAX_SCROLL_MEMORY_ENTRIES) {
  return sanitizeScrollMemory([...sanitizeScrollMemory(entries, limit), entry], limit);
}

function resolveScrollTop(entry, maxScrollTop) {
  if (!validScrollEntry(entry) || !Number.isFinite(maxScrollTop) || maxScrollTop < 0) return 0;
  return entry.scrollTop <= maxScrollTop ? entry.scrollTop : entry.ratio * maxScrollTop;
}

module.exports = {
  MAX_SCROLL_MEMORY_ENTRIES,
  MAX_SCROLL_TOP,
  movePathBefore,
  validScrollEntry,
  sanitizeScrollMemory,
  upsertScrollMemory,
  resolveScrollTop,
};
