const { normalizeFilePath, filePathKey } = require('./pathIdentity.cjs');

function normalizeWindowsPath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replaceAll('/', '\\').replace(/\\{2,}/g, '\\');
  if (/^[a-z]:\\$/i.test(normalized)) return normalized;
  return normalized.replace(/\\+$/g, '');
}

function sameOrDescendantPath(candidate, parent) {
  const normalizedCandidate = filePathKey(candidate);
  const normalizedParent = filePathKey(parent);
  if (!normalizedCandidate || !normalizedParent) return false;
  const separator = normalizedParent.startsWith('/') ? '/' : '\\';
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(normalizedParent.endsWith(separator) ? normalizedParent : `${normalizedParent}${separator}`);
}

function remapDescendantPath(candidate, previousRoot, nextRoot) {
  const normalizedCandidate = normalizeFilePath(candidate);
  const normalizedPrevious = normalizeFilePath(previousRoot);
  const normalizedNext = normalizeFilePath(nextRoot);
  if (!sameOrDescendantPath(normalizedCandidate, normalizedPrevious)) return candidate;
  const separator = normalizedNext.startsWith('/') ? '/' : '\\';
  const relative = normalizedCandidate.slice(normalizedPrevious.length).replace(/^[\\/]+/, '');
  return normalizedNext + (relative ? (normalizedNext.endsWith(separator) ? '' : separator) + relative : '');
}

class MutationBarrier {
  constructor(ttlMs = 30_000) {
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 30_000);
    this.entries = new Map();
  }

  prune(now = Date.now()) {
    for (const [path, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(path);
  }

  block(path, now = Date.now()) {
    const normalized = filePathKey(path);
    if (!normalized) return;
    this.prune(now);
    this.entries.set(normalized, now + this.ttlMs);
  }

  release(path, now = Date.now()) {
    const normalized = filePathKey(path);
    if (!normalized) return;
    this.prune(now);
    for (const blocked of this.entries.keys()) {
      if (sameOrDescendantPath(normalized, blocked)) this.entries.delete(blocked);
    }
  }

  has(path, now = Date.now()) {
    const normalized = filePathKey(path);
    if (!normalized) return false;
    this.prune(now);
    return [...this.entries.keys()].some(blocked => sameOrDescendantPath(normalized, blocked));
  }
}

module.exports = { MutationBarrier, normalizeWindowsPath, sameOrDescendantPath, remapDescendantPath };
