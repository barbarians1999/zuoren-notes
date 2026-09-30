'use strict';

/**
 * Serializes the complete read -> mutate -> write transaction for the
 * app-level settings file. Atomic replacement keeps individual writes
 * intact, but only this queue prevents two stale snapshots from losing each
 * other's fields.
 */
class SettingsStore {
  constructor({ read, write }) {
    if (typeof read !== 'function' || typeof write !== 'function') throw new TypeError('SettingsStore requires read and write functions');
    this.read = read;
    this.write = write;
    this.queue = Promise.resolve();
  }

  update(mutator) {
    if (typeof mutator !== 'function') return Promise.reject(new TypeError('SettingsStore update requires a mutator'));
    const operation = this.queue.catch(() => undefined).then(async () => {
      const current = await this.read();
      const next = await mutator(current);
      return this.write(next);
    });
    this.queue = operation;
    return operation;
  }

  flush() {
    return this.queue.catch(() => undefined);
  }
}

module.exports = { SettingsStore };
