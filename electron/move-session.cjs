const crypto = require('node:crypto');
const { filePathKey } = require('../src/pathIdentity.cjs');
const { validateSession, sessionFilePaths } = require('./session.cjs');
const same = (a, b) => typeof a === 'string' && filePathKey(a) === filePathKey(b);
function assertMoveSession(settings, plan) {
  if (sessionFilePaths(settings.session).some(file => same(file, plan.target)))
    throw new Error('目标位置已有工作现场或恢复引用，未移动文件；请先处理原目标标签和恢复稿。');
}
function remapMoveSettings(settings, result) {
  const remap = value => same(value, result.oldPath) ? result.entry.path : value;
  const next = { ...settings, recentFiles: [...new Set((settings.recentFiles || []).map(remap))] };
  const original = validateSession(settings.session);
  if (!original) return next;
  const session = JSON.parse(JSON.stringify(original));
  session.noteTabs = session.noteTabs.map(remap);
  for (const key of ['primaryNote','secondaryNote']) if (session[key]) session[key].path = remap(session[key].path);
  if (session.activePdf) session.activePdf.path = remap(session.activePdf.path);
  session.activeEpub = remap(session.activeEpub);
  if (session.scrollMemory) for (const item of session.scrollMemory) item.path = remap(item.path);
  if (session.version === 3) {
    for (const group of Object.values(session.noteGroups)) for (const tab of group.tabs) tab.path = remap(tab.path);
    for (const item of [...session.noteDocuments, ...(session.pendingNoteDocuments || [])]) {
      item.path = remap(item.path);
      if (item.retainedRecoveries) for (const reference of item.retainedRecoveries) reference.sourcePath = remap(reference.sourcePath);
    }
  }
  // A collision must never discard a document, recovery ID or tab to make it validate.
  if (!validateSession(session)) throw new Error('移动后工作现场存在冲突，原现场已保留，移动事务继续锁定。');
  return { ...next, session };
}
function sessionHash(session) {
  const canonical = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return crypto.createHash('sha256').update(JSON.stringify(canonical(session))).digest('hex');
}
module.exports = { assertMoveSession, remapMoveSettings, sessionHash };
