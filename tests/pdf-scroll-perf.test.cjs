const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let PdfBitmapCache, pdfBitmapCacheKey, PdfRenderQueue;
before(async () => {
  ({ PdfBitmapCache, pdfBitmapCacheKey } = await import('../src/readers/pdfBitmapCache.ts'));
  ({ PdfRenderQueue } = await import('../src/readers/pdfRenderQueue.ts'));
});

test('PdfBitmapCache promotes MRU hits, evicts LRU entries within budget and zeroes disposed canvases', () => {
  const disposed = [];
  const cache = new PdfBitmapCache(100, canvas => {
    canvas.width = 0;
    canvas.height = 0;
    disposed.push(canvas);
  });
  const c1 = { width: 10, height: 10 }, c2 = { width: 10, height: 10 }, c3 = { width: 10, height: 10 };
  const k1 = pdfBitmapCacheKey('a.pdf', 1, 1, 2, false);
  const k2 = pdfBitmapCacheKey('a.pdf', 2, 1, 2, false);
  const k3 = pdfBitmapCacheKey('a.pdf', 3, 1, 2, false);
  const kDark = pdfBitmapCacheKey('a.pdf', 1, 1, 2, true);
  assert.notEqual(k1, kDark);
  assert.notEqual(k1, pdfBitmapCacheKey('a.pdf', 1, 1.15, 2, false));

  cache.set(k1, { canvas: c1, cssWidth: 10, cssHeight: 10, rotation: 0, bytes: 45, hasDarkImages: false });
  cache.set(k2, { canvas: c2, cssWidth: 10, cssHeight: 10, rotation: 0, bytes: 45, hasDarkImages: false });
  assert.equal(cache.bytes, 90);
  // Touch k1 so k2 becomes the oldest entry.
  assert.equal(cache.get(k1).canvas, c1);
  cache.set(k3, { canvas: c3, cssWidth: 10, cssHeight: 10, rotation: 0, bytes: 45, hasDarkImages: false });

  assert.equal(cache.size, 2);
  assert.equal(cache.bytes, 90);
  assert.equal(cache.get(k2), undefined);
  assert.ok(cache.get(k1));
  assert.ok(cache.get(k3));
  assert.deepEqual(disposed, [c2]);
  assert.equal(c2.width, 0);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal(c1.width, 0);
  assert.equal(c3.width, 0);
});

test('PdfRenderQueue bounds concurrency, prioritizes closest page and skips cancelled queued tasks', async () => {
  let priorityPage = 20;
  const queue = new PdfRenderQueue(2, () => priorityPage);
  const gates = [];
  let running = 0, maxRunning = 0;
  const executed = [];

  const enqueue = page => queue.enqueue(page, () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    executed.push(page);
    return new Promise(resolve => {
      gates.push(() => { running -= 1; resolve(page); });
    });
  });

  const p1 = enqueue(1);
  const p2 = enqueue(2);
  const pFar = enqueue(50);
  const pCancel = enqueue(21);
  const pNear = enqueue(19);
  const pMid = enqueue(25);

  // p1 and p2 start immediately (concurrency = 2); others wait.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maxRunning, 2);
  assert.equal(queue.activeCount, 2);
  assert.equal(queue.pendingCount, 4);

  // Cancel page 21 before it ever starts.
  pCancel.cancel();
  await assert.rejects(pCancel.promise, { name: 'RenderingCancelledException' });
  assert.equal(queue.pendingCount, 3);

  // Free active slots one wave at a time; closest pending page (19 -> 25 -> 50) runs first.
  while (gates.length || queue.pendingCount > 0) {
    const release = gates.splice(0, gates.length);
    for (const done of release) done();
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(maxRunning, 2);
  assert.deepEqual(executed, [1, 2, 19, 25, 50]);
  assert.deepEqual(await Promise.all([p1.promise, p2.promise, pNear.promise, pMid.promise, pFar.promise]), [1, 2, 19, 25, 50]);
});
