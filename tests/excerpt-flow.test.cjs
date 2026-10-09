const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let create;
before(async () => { ({ createExcerptFlow: create } = await import('../src/readers/excerptFlow.ts')); });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('slow save is single-flight and insertion failure retries only the captured second phase', async () => {
  const saveGate = deferred();
  let source = true, target = true, saves = 0, inserts = 0;
  const flow = create({
    sourceCurrent: () => source, targetCurrent: () => target,
    save: async () => { saves++; await saveGate.promise; return true; },
    insert: async () => ++inserts > 1,
  });
  const first = flow(), concurrent = flow();
  assert.equal(first, concurrent);
  saveGate.resolve();
  const partial = await first;
  assert.equal(partial.saved, true); assert.equal(partial.inserted, false); assert.equal(partial.failure, 'insert-failed');
  assert.equal(saves, 1); assert.equal(inserts, 1);
  const complete = await partial.retry();
  assert.equal(complete.done, true); assert.equal(complete.saved, true); assert.equal(complete.inserted, true);
  assert.equal(saves, 1); assert.equal(inserts, 2);
});

test('source or destination switches stop before an unsafe phase and retries remain identity-bound', async () => {
  let target = true, saves = 0, inserts = 0;
  const flow = create({ sourceCurrent: () => true, targetCurrent: () => target,
    save: async () => { saves++; target = false; return true; },
    insert: async () => { inserts++; return true; },
  });
  const partial = await flow();
  assert.equal(partial.failure, 'target-changed'); assert.equal(partial.saved, true); assert.equal(inserts, 0);
  assert.equal((await partial.retry()).failure, 'target-changed');
  assert.equal(saves, 1); assert.equal(inserts, 0);
});

test('a failed write does not start insertion; retry saves once before inserting', async () => {
  let saves = 0, inserts = 0;
  const flow = create({ sourceCurrent: () => true, targetCurrent: () => true,
    save: async () => ++saves > 1, insert: async () => { inserts++; return true; },
  });
  const failed = await flow();
  assert.equal(failed.failure, 'save-failed'); assert.equal(inserts, 0);
  const complete = await failed.retry();
  assert.equal(complete.done, true); assert.equal(saves, 2); assert.equal(inserts, 1);
});

test('insertion-only flows do not write marks and report a false editor transaction as incomplete', async () => {
  let saves = 0, inserts = 0;
  const flow = create({ sourceCurrent: () => true, targetCurrent: () => true,
    save: undefined, insert: async () => ++inserts > 1,
  });
  const failed = await flow();
  assert.equal(failed.failure, 'insert-failed'); assert.equal(failed.saved, false); assert.equal(saves, 0);
  assert.equal((await failed.retry()).done, true); assert.equal(inserts, 2);
});
