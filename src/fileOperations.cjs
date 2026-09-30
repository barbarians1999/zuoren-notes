function normalizeWindowsPath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replaceAll('/', '\\').replace(/\\{2,}/g, '\\');
  if (/^[a-z]:\\$/i.test(normalized)) return normalized;
  return normalized.replace(/\\+$/g, '');
}

function sameOrDescendantPath(candidate, parent) {
  const normalizedCandidate = normalizeWindowsPath(candidate).toLocaleLowerCase('en-US');
  const normalizedParent = normalizeWindowsPath(parent).toLocaleLowerCase('en-US');
  if (!normalizedCandidate || !normalizedParent) return false;
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}\\`);
}

function remapDescendantPath(candidate, previousRoot, nextRoot) {
  const normalizedCandidate = normalizeWindowsPath(candidate);
  const normalizedPrevious = normalizeWindowsPath(previousRoot);
  const normalizedNext = normalizeWindowsPath(nextRoot);
  if (!sameOrDescendantPath(normalizedCandidate, normalizedPrevious)) return candidate;
  return normalizedNext + normalizedCandidate.slice(normalizedPrevious.length);
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
    const normalized = normalizeWindowsPath(path);
    if (!normalized) return;
    this.prune(now);
    this.entries.set(normalized.toLocaleLowerCase('en-US'), now + this.ttlMs);
  }

  release(path, now = Date.now()) {
    const normalized = normalizeWindowsPath(path);
    if (!normalized) return;
    this.prune(now);
    for (const blocked of this.entries.keys()) {
      if (sameOrDescendantPath(normalized, blocked)) this.entries.delete(blocked);
    }
  }

  has(path, now = Date.now()) {
    const normalized = normalizeWindowsPath(path);
    if (!normalized) return false;
    this.prune(now);
    return [...this.entries.keys()].some(blocked => sameOrDescendantPath(normalized, blocked));
  }
}

module.exports = { MutationBarrier, normalizeWindowsPath, sameOrDescendantPath, remapDescendantPath };
