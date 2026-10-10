const { isAbsoluteFilePath, filePathKey } = require('../src/pathIdentity.cjs');
const { MAX_SCROLL_MEMORY_ENTRIES, MAX_SCROLL_TOP, validScrollEntry } = require('../src/sessionState.cjs');

const recoveryIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const absolutePath = isAbsoluteFilePath;
const nullablePath = value => value === null || absolutePath(value);

function validateNote(value) {
  return value === null || (exactKeys(value, ['path', 'mode', 'recoveryId']) && absolutePath(value.path)
    && ['edit', 'source', 'preview'].includes(value.mode) && recoveryIdPattern.test(value.recoveryId));
}

const pathKey = filePathKey;
function validateGroups(value) {
  if (!exactKeys(value.noteGroups, ['primary', 'secondary']) || !['primary', 'secondary'].includes(value.activeNoteGroup)
    || !Array.isArray(value.noteDocuments) || value.noteDocuments.length > 100) return false;
  const documents = new Map(), ids = new Set();
  for (const doc of value.noteDocuments) {
    const legacy = exactKeys(doc, ['path', 'recoveryId', 'retainedRecoveryIds']);
    const current = exactKeys(doc, ['path', 'recoveryId', 'retainedRecoveries']);
    if ((!legacy && !current) || !absolutePath(doc.path) || !recoveryIdPattern.test(doc.recoveryId) || documents.has(pathKey(doc.path))) return false;
    if (legacy) {
      if (!Array.isArray(doc.retainedRecoveryIds) || doc.retainedRecoveryIds.length > 100
        || !doc.retainedRecoveryIds.every(id => recoveryIdPattern.test(id) && id !== doc.recoveryId)
        || new Set(doc.retainedRecoveryIds).size !== doc.retainedRecoveryIds.length) return false;
    } else {
      if (!Array.isArray(doc.retainedRecoveries) || doc.retainedRecoveries.length > 100) return false;
      const references = new Set();
      for (const item of doc.retainedRecoveries) {
        if (!exactKeys(item, ['sourcePath', 'recoveryId']) || !absolutePath(item.sourcePath) || !recoveryIdPattern.test(item.recoveryId)
          || item.recoveryId === doc.recoveryId || references.has(item.recoveryId)) return false;
        references.add(item.recoveryId);
      }
    }
    documents.set(pathKey(doc.path), doc);
  }
  let total = 0;
  const referenced = new Set();
  for (const group of Object.values(value.noteGroups)) {
    if (!exactKeys(group, ['tabs', 'activeId']) || !Array.isArray(group.tabs) || group.tabs.length > 100) return false;
    const paths = new Set(); let temporary = 0;
    for (const tab of group.tabs) {
      if (!exactKeys(tab, ['id', 'path', 'mode', 'preview', 'selection', 'scroll']) || !recoveryIdPattern.test(tab.id) || ids.has(tab.id)
        || !nullablePath(tab.path) || !['edit', 'preview'].includes(tab.mode) || typeof tab.preview !== 'boolean'
        || !exactKeys(tab.selection, ['anchor', 'head']) || !Object.values(tab.selection).every(n => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000)
        || !exactKeys(tab.scroll, ['edit', 'preview']) || !Object.values(tab.scroll).every(n => Number.isFinite(n) && n >= 0 && n <= MAX_SCROLL_TOP)) return false;
      ids.add(tab.id); total++; if (tab.preview) temporary++;
      if (tab.path) { const key = pathKey(tab.path); if (!documents.has(key) || paths.has(key)) return false; paths.add(key); referenced.add(key); }
    }
    if (temporary > 1 || (group.tabs.length ? !group.tabs.some(tab => tab.id === group.activeId) : group.activeId !== null)) return false;
  }
  return total <= 100 && referenced.size === documents.size;
}

function validateSession(value) {
  const baseKeys = ['version', 'root', 'currentDirectory', 'layout', 'sidebar', 'splitAt', 'noteTabs', 'primaryNote', 'secondaryNote', 'activePdf', 'activeEpub'];
  if (!isRecord(value)) return null;
  if (value.version === 1) {
    if (!exactKeys(value, baseKeys)) return null;
  } else if (value.version === 2 || value.version === 3) {
    const keys = [...baseKeys, 'scrollMemory', ...(value.version === 3 ? ['noteGroups', 'activeNoteGroup', 'noteDocuments'] : [])];
    if (!exactKeys(value, keys) || (value.version === 3 && !validateGroups(value)) || !Array.isArray(value.scrollMemory)
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

function sessionFilePaths(value) {
  const session = validateSession(value); if (!session) return [];
  const retainedSources = session.version === 3 ? session.noteDocuments.flatMap(doc =>
    'retainedRecoveries' in doc ? doc.retainedRecoveries.map(item => item.sourcePath) : [doc.path]) : [];
  return [...new Set([...session.noteTabs, session.primaryNote?.path, session.secondaryNote?.path,
    session.activePdf?.path, session.activeEpub, ...retainedSources].filter(Boolean))];
}

module.exports = { recoveryIdPattern, validateSession, sessionFilePaths };
