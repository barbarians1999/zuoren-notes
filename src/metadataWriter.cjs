// Apply each change to the last successful write, never an optimistic snapshot.
// A failure leaves the base untouched; the next operation can retry safely.
class MetadataWriter {
  constructor() { this.tail = Promise.resolve(); this.current = null; this.lastFailure = null; }
  write({ key, initial, change, persist, commit }) {
    if (this.current?.key !== key) { this.current = { key, value: initial }; this.lastFailure = null; }
    const args = { key, initial, change, persist, commit };
    const context = this.current;
    const task = this.tail.catch(() => undefined).then(async () => {
      try {
        const value = change(context.value);
        if (value.id !== context.value.id) {
          if (this.current === context) this.lastFailure = { args, error: new Error('文档身份不一致，保存未确认') };
          return false;
        }
        await persist(value);
        context.value = value;
        if (this.current === context) this.lastFailure = null;
        commit(value);
        return true;
      } catch (error) {
        if (this.current === context) this.lastFailure = { args, error };
        throw error;
      }
    });
    this.tail = task;
    return task;
  }
  hasFailure(key) {
    return !!this.lastFailure && (key === undefined || this.lastFailure.args.key === key);
  }
  failureError(key) {
    return this.hasFailure(key) ? this.lastFailure.error : null;
  }
  retry(key) {
    if (!this.hasFailure(key)) return null;
    const { args } = this.lastFailure;
    this.lastFailure = null;
    return this.write(args);
  }
  discard(key) {
    if (key === undefined || this.current?.key === key || this.lastFailure?.args.key === key) {
      if (key === undefined || this.current?.key === key) this.current = null;
      this.lastFailure = null;
      this.tail = this.tail.catch(() => undefined);
    }
  }
}
module.exports = { MetadataWriter };
