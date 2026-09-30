const test = require('node:test');
const assert = require('node:assert/strict');
const { SettingsStore } = require('../electron/settings.cjs');

test('serializes full settings transactions so concurrent updates are merged', async () => {
  let value = { recentFiles: [], roots: [], session: null };
  const store = new SettingsStore({
    read: async () => {
      await new Promise(resolve => setTimeout(resolve, 2));
      return structuredClone(value);
    },
    write: async next => {
      await new Promise(resolve => setTimeout(resolve, 2));
      value = structuredClone(next);
      return value;
    },
  });

  await Promise.all([
    store.update(current => ({ ...current, recentFiles: ['C:\\notes\\a.md'] })),
    store.update(current => ({ ...current, session: { version: 1 } })),
    store.update(current => ({ ...current, roots: ['C:\\notes'] })),
  ]);

  assert.deepEqual(value, {
    recentFiles: ['C:\\notes\\a.md'],
    roots: ['C:\\notes'],
    session: { version: 1 },
  });
});

test('a failed settings transaction does not poison later updates', async () => {
  let value = { count: 0 };
  let fail = true;
  const store = new SettingsStore({
    read: async () => structuredClone(value),
    write: async next => {
      if (fail) { fail = false; throw new Error('temporary write failure'); }
      value = structuredClone(next);
      return value;
    },
  });

  await assert.rejects(store.update(current => ({ ...current, count: 1 })), /temporary write failure/);
  await store.update(current => ({ ...current, count: current.count + 2 }));
  assert.deepEqual(value, { count: 2 });
  await store.flush();
});
