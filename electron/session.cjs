const path = require('node:path');
const { MAX_SCROLL_MEMORY_ENTRIES, MAX_SCROLL_TOP, validScrollEntry } = require('../src/sessionState.cjs');

const recoveryIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const absolutePath = value => typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
const nullablePath = value => value === null || absolutePath(value);

function validateNote(value) {
  return value === null || (exactKeys(value, ['path', 'mode', 'recoveryId']) && absolutePath(value.path)
    && ['edit', 'source', 'preview'].includes(value.mode) && recoveryIdPattern.test(value.recoveryId));
}

function validateSession(value) {
  const baseKeys = ['version', 'root', 'currentDirectory', 'layout', 'sidebar', 'splitAt', 'noteTabs', 'primaryNote', 'secondaryNote', 'activePdf', 'activeEpub'];
  if (!isRecord(value)) return null;
  if (value.version === 1) {
    if (!exactKeys(value, baseKeys)) return null;
  } else if (value.version === 2) {
    if (!exactKeys(value, [...baseKeys, 'scrollMemory']) || !Array.isArray(value.scrollMemory)
      || value.scrollMemory.length > MAX_SCROLL_MEMORY_ENTRIES
      || !value.scrollMemory.every(entry => validScrollEntry(entry) && entry.scrollTop <= MAX_SCROLL_TOP)) return null;
  } else return null;
  if (!nullablePath(value.root) || !nullablePath(value.currentDirectory)) return null;
  if (!['read', 'note', 'split'].includes(value.layout) || typeof value.sidebar !== 'boolean') return null;
  if (!Number.isFinite(value.splitAt) || value.splitAt < 25 || value.splitAt > 75) return null;
  if (!Array.isArray(value.noteTabs) || value.noteTabs.length > 100 || !value.noteTabs.every(absolutePath) || new Set(value.noteTabs).size !== value.noteTabs.length) return null;
  if (!validateNote(value.primaryNote) || !validateNote(value.secondaryNote)) return null;
  if (value.activePdf !== null && !(exactKeys(value.activePdf, ['path', 'page', 'scale'])
    && absolutePath(value.activePdf.path) && Number.isSafeInteger(value.activePdf.page) && value.activePdf.page >= 1
    && Number.isFinite(value.activePdf.scale) && value.activePdf.scale >= 0.5 && value.activePdf.scale <= 3)) return null;
  if (!nullablePath(value.activeEpub)) return null;
  if (value.activePdf && value.activeEpub) return null;
  return value;
}

module.exports = { recoveryIdPattern, validateSession };
