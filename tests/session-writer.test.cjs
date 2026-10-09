const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionWriter } = require('../src/sessionWriter.cjs');

test('unchanged session snapshots write once, with an explicit final flush on close', async () => {
  const writer = new SessionWriter(), writes = [], persist = async value => { writes.push(value); };
  await Promise.all(Array.from({ length: 5 }, () => writer.write({ path: 'note.md', page: 1 }, persist)));
  assert.equal(writes.length, 1);
  await writer.write({ path: 'note.md', page: 1 }, persist, true);
  assert.equal(writes.length, 2);
});

test('session changes remain ordered even when returning to a previously saved snapshot', async () => {
  const writer = new SessionWriter(), writes = [], persist = async value => { writes.push(value.path); };
  await writer.write({ path: 'A' }, persist);
  await Promise.all([writer.write({ path: 'B' }, persist), writer.write({ path: 'A' }, persist)]);
  assert.deepEqual(writes, ['A', 'B', 'A']);
});

test('a failed session write is never acknowledged or allowed to poison retries', async () => {
  const writer = new SessionWriter(), value = { path: 'A' };
  let attempts = 0;
  const persist = async () => { if (++attempts === 1) throw new Error('disk failure'); };
  const first = writer.write(value, persist), retry = writer.write(value, persist);
  await assert.rejects(first, /disk failure/); await retry;
  await writer.write(value, persist);
  assert.equal(attempts, 2);
  await assert.rejects(writer.write(value, async () => { throw new Error('close failure'); }, true), /close failure/);
});
