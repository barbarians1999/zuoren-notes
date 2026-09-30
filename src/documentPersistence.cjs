const { sameNoteContent } = require('./noteContent.cjs');

// One owner for save/poll ordering in either pane. UI supplies snapshots, not
// mutable editor DOM. Tokens invalidate disk reads started before a save.
class DocumentPersistence {
  constructor() { this.pending = null; this.epoch = 0; this.disposed = false; }
  invalidate() { this.epoch++; }
  async poll({ snapshot, read, apply, blocked }) {
    if (this.pending || this.disposed || blocked?.()) return;
    const before = snapshot(), epoch = this.epoch;
    if (!before.note) return;
    const disk = await read(before.note.path);
    const after = snapshot();
    if (this.disposed || this.pending || epoch !== this.epoch || blocked?.() ||
        before.note !== after.note || before.text !== after.text || before.revision !== after.revision) return;
    if (disk.hash !== before.note.hash) apply(disk, !sameNoteContent(after.text, before.note.content) && !sameNoteContent(after.text, disk.content));
  }
  save(options) {
    if (this.pending) return this.pending;
    this.invalidate();
    const task = Promise.resolve().then(async () => {
      while (!this.disposed) {
        const before = options.snapshot();
        if (!before.note || options.blocked?.()) return !options.blocked?.();
        if (sameNoteContent(before.text, before.note.content)) { options.clean?.(); return true; }
        try { await options.recovery?.(before); } catch (error) { options.recoveryError?.(error); }
        if (this.disposed || options.snapshot().note !== before.note) return true;
        if (options.blocked?.()) return false;
        const submitted = options.snapshot();
        options.saving?.();
        try {
          const result = await options.write(submitted);
          if (this.disposed || options.snapshot().note !== submitted.note) return true;
          if (result.conflict) { options.conflict(result); return false; }
          options.commit(result, submitted);
        } catch (error) { options.error(error); return false; }
      }
      return true;
    });
    this.pending = task;
    const clear = () => { if (this.pending === task) this.pending = null; };
    task.then(clear, clear);
    return task;
  }
}
module.exports = { DocumentPersistence };
