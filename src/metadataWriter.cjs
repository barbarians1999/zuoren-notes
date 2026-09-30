// Apply each change to the last successful write, never an optimistic snapshot.
// A failure leaves the base untouched; the next operation can retry safely.
class MetadataWriter {
  constructor() { this.tail = Promise.resolve(); this.current = null; }
  write({ key, initial, change, persist, commit }) {
    if (this.current?.key !== key) this.current = { key, value: initial };
    const context = this.current;
    const task = this.tail.catch(() => undefined).then(async () => {
      const value = change(context.value);
      if (value.id !== context.value.id) return false;
      await persist(value);
      context.value = value;
      commit(value);
      return true;
    });
    this.tail = task;
    return task;
  }
}
module.exports = { MetadataWriter };
