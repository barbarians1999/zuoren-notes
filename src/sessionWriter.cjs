// Serialize snapshots and deduplicate only after a successful write. A queued
// A -> B -> A sequence must still persist its final A; close can force a flush.
class SessionWriter {
  constructor() { this.tail = Promise.resolve(); this.committed = null; }
  write(snapshot, persist, force = false) {
    const serialized = JSON.stringify(snapshot);
    const task = this.tail.catch(() => undefined).then(async () => {
      if (!force && serialized === this.committed) return;
      await persist(snapshot);
      this.committed = serialized;
    });
    this.tail = task;
    return task;
  }
}
module.exports = { SessionWriter };
