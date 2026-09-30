const { recoveryIdPattern } = require('./session.cjs');
async function saveNoteAndCleanup(store, input, warn = console.warn) {
  const result = await store.saveNote(input);
  if (!result.conflict && recoveryIdPattern.test(input.recoveryId || '')) {
    try { await store.deleteRecoveryIfHash(input.path, input.recoveryId, result.hash); }
    catch (error) {
      // The document is committed. Cleanup failure must not hide its new hash.
      warn('Recovery cleanup deferred:', error.message);
      return { ...result, recoveryCleanupPending: true };
    }
  }
  return result;
}
module.exports = { saveNoteAndCleanup };

