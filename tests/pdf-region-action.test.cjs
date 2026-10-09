require('./typescript-loader.cjs');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let create;
before(async () => { ({ createPdfRegionAction: create } = await import('../src/readers/pdfRegionAction.ts')); });
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function fixture(overrides = {}) {
  const writes = [], attachments = [], insertions = [], textWrites = [];
  let source = true, target = true;
  const options = {
    context: { sourcePath: 'paper.pdf', sourceCurrent: () => source,
      target: { path: 'A.md', valid: () => target, insert: async (...args) => { insertions.push(args); return true; } } },
    annotation: { id: 'region-id', type: 'region', anchor: { pdfId: 'pdf', page: 3, rotation: 90, rects: [{ x: .1, y: .2, w: .3, h: .4 }] } },
    crop: async () => new Uint8Array([1]),
    attachment: async path => { attachments.push(path); return '.assets/region.png'; },
    save: async annotation => { writes.push({ ...annotation }); return true; },
    saveText: async (annotation, text) => { textWrites.push({ id: annotation.id, text }); return true; },
    ...overrides,
  };
  return { options, writes, attachments, insertions, textWrites, setSource: value => source = value, setTarget: value => target = value };
}
test('attachment I/O keeps its original owner; switching targets blocks insertion and retry reuses the image', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture();
  f.options.attachment = async path => { f.attachments.push(path); started.resolve(); await gate.promise; return '.assets/region.png'; };
  const action = create(f.options), pending = action.run();
  await started.promise; f.setTarget(false); gate.resolve();
  const failure = await pending;
  assert.equal(failure.failure, 'target-changed'); assert.equal(failure.saved, false);
  assert.deepEqual(f.attachments, ['A.md']); assert.equal(f.insertions.length, 0);
  f.setTarget(true);
  assert.equal((await failure.retry()).done, true);
  assert.equal(f.attachments.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.insertions.length, 1);
  assert.equal(f.insertions[0][0], '.assets/region.png'); assert.equal(f.insertions[0][1].page, 3);
});
test('saved regions survive insertion failure and single-flight retry does not repeat attachment or annotation writes', async () => {
  const f = fixture(), gate = deferred(); let insertCount = 0;
  f.options.context.target.insert = async (...args) => { if (++insertCount === 1) return false; await gate.promise; f.insertions.push(args); return true; };
  const action = create(f.options), failed = await action.run();
  assert.equal(failed.saved, true); assert.equal(failed.failure, 'insert-failed');
  const retry = failed.retry(), duplicate = failed.retry(); assert.equal(retry, duplicate);
  gate.resolve(); assert.equal((await retry).done, true);
  assert.equal(f.attachments.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.insertions.length, 1);
});
test('annotation failure retains the image for retry, and source replacement never inserts into a new document', async () => {
  const f = fixture(); let fail = true;
  f.options.save = async annotation => { if (fail) return false; f.writes.push(annotation); return true; };
  const action = create(f.options), failed = await action.run();
  assert.equal(failed.failure, 'save-failed'); assert.equal(f.insertions.length, 0);
  f.setSource(false); assert.equal((await failed.retry()).failure, 'source-changed');
  f.setSource(true); fail = false; assert.equal((await failed.retry()).done, true);
  assert.equal(f.attachments.length, 1); assert.equal(f.writes.length, 1);
});
test('OCR uses the original destination and retries only text insertion after its metadata has committed', async () => {
  const f = fixture(), action = create(f.options); await action.run();
  const textAction = action.createTextAction('OCR text');
  f.setTarget(false); assert.equal((await textAction()).failure, 'target-changed'); assert.equal(f.textWrites.length, 0);
  f.setTarget(true); let fail = true;
  f.options.context.target.insert = async (...args) => { if (fail) return false; f.insertions.push(args); return true; };
  const partial = await textAction(); assert.equal(partial.saved, true); assert.equal(partial.inserted, false);
  fail = false; assert.equal((await partial.retry()).done, true);
  assert.deepEqual(f.textWrites, [{ id: 'region-id', text: 'OCR text' }]);
  assert.equal(f.attachments.length, 1); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.insertions.at(-1).slice(0, 1), [null]); assert.equal(f.insertions.at(-1)[2], 'OCR text');
});
test('a reader without a note can save image and OCR metadata without attempting insertion', async () => {
  const f = fixture(); f.options.context.target = null;
  const action = create(f.options); assert.equal((await action.run()).done, true);
  assert.equal((await action.createTextAction('text')()).done, true);
  assert.deepEqual(f.attachments, ['paper.pdf']); assert.equal(f.insertions.length, 0);
});
