const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LatestRequest } = require('../src/asyncRequest.cjs');
const { MetadataWriter } = require('../src/metadataWriter.cjs');
const { DiagnosticRing } = require('../src/diagnostics.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };

test('request generations reject out-of-order responses and cleared query results', () => {
  const requests = new LatestRequest(), first = requests.begin(), second = requests.begin();
  assert.equal(first(), false); assert.equal(second(), true);
  requests.invalidate(); assert.equal(second(), false);
});
test('metadata changes compose against committed state, even across a slow write', async () => {
  const writer = new MetadataWriter(), slow = deferred(), saved = [];
  const initial = { id: 'book', progress: 0, annotations: [] };
  const options = { key: 'book', initial, persist: async value => { saved.push(value); if (saved.length === 1) await slow.promise; }, commit() {} };
  const annotation = writer.write({ ...options, change: current => ({ ...current, annotations: ['annotation'] }) });
  const progress = writer.write({ ...options, change: current => ({ ...current, progress: 0.5 }) });
  slow.resolve(); await Promise.all([annotation, progress]);
  assert.deepEqual(saved[1], { id: 'book', progress: 0.5, annotations: ['annotation'] });
});
test('failed metadata write cannot be resurrected by progress, retry or a different reader', async () => {
  const writer = new MetadataWriter(), saved = [];
  const initial = { id: 'book', annotations: [], progress: 0 };
  const options = { key: 'book', initial, persist: async value => saved.push(value), commit() {} };
  await assert.rejects(writer.write({ ...options, change: value => ({ ...value, annotations: ['failed'] }), persist: async () => { throw Error('disk busy'); } }));
  await writer.write({ ...options, change: value => ({ ...value, progress: 0.8 }) });
  assert.deepEqual(saved[0].annotations, []);
  await writer.write({ ...options, change: value => ({ ...value, annotations: ['retry'] }) });
  assert.equal(saved[1].progress, 0.8);
  await writer.write({ ...options, key: 'other', initial: { id: 'other', annotations: [], progress: 0 }, change: value => value });
  assert.equal(saved[2].id, 'other'); assert.deepEqual(saved[2].annotations, []);
});
test('diagnostics stay bounded and never store supplied source text or full paths', () => {
  const ring = new DiagnosticRing(3);
  for (let revision = 0; revision < 1000; revision++) ring.record('save', { revision, text: 'private', path: 'C:/private.md' });
  const events = ring.snapshot(); assert.equal(events.length, 3); assert.equal(events[0].revision, 997);
  assert.equal(JSON.stringify(events).includes('private'), false);
  events[0].revision = 0; assert.equal(ring.snapshot()[0].revision, 997);
});
