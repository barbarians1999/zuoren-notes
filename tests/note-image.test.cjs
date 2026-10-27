const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FileStore } = require('../electron/storage.cjs');
const { MAX_IMAGE_BYTES, noteImageBytes, openImage } = require('../electron/note-image.cjs');
const { createSmokeWorkspace, cleanupSmokeWorkspace } = require('./smokeWorkspace.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a82kAAAAASUVORK5CYII=', 'base64');

test('note images validate bytes, size and the requested format before writing', () => {
  assert.deepEqual(noteImageBytes({ data: png, extension: 'png' }), { bytes: png, extension: 'png' });
  const jpeg = Buffer.from([255, 216, 255, 224]);
  assert.equal(noteImageBytes({ data: jpeg, extension: 'jpg' }).extension, 'jpg');
  const webp = Buffer.from('RIFF0000WEBP', 'ascii');
  assert.equal(noteImageBytes({ data: webp, extension: 'webp' }).extension, 'webp');
  for (const input of [
    { data: png, extension: 'jpg' }, { data: png, extension: 'svg' },
    { data: Buffer.from('<script/>'), extension: 'png' }, { data: new Uint8Array(), extension: 'png' },
    { data: new Uint8Array(MAX_IMAGE_BYTES + 1), extension: 'png' }, { data: Array.from(png), extension: 'png' },
  ]) assert.throws(() => noteImageBytes(input));
});

test('the image opener checks file authorization and format and propagates viewer errors', async () => {
  const workspace = await createSmokeWorkspace('note-image-unit');
  try {
    await fs.mkdir(workspace.fixture, { recursive: true });
    const note = path.join(workspace.fixture, 'note.md'), image = path.join(workspace.fixture, 'pixel.png');
    const fake = path.join(workspace.fixture, 'fake.png'), executable = path.join(workspace.fixture, 'fake.exe');
    await fs.writeFile(note, 'original'); await fs.writeFile(image, png);
    await fs.writeFile(fake, 'not an image'); await fs.writeFile(executable, png);
    const store = new FileStore(); await store.grantFile(note);
    const paths = [], urls = [];
    const shell = { openPath: async file => { paths.push(file); return ''; }, openExternal: async url => { urls.push(url); } };
    await openImage(store, shell, image);
    assert.deepEqual(paths, [await fs.realpath(image)]);
    await assert.rejects(() => openImage(store, shell, fake));
    await assert.rejects(() => openImage(store, shell, executable));
    await assert.rejects(() => openImage({ checked: async () => { throw Error('not authorized'); } }, shell, image), /not authorized/);
    await assert.rejects(() => openImage(store, { ...shell, openPath: async () => 'no viewer' }, image), /no viewer/);
    await openImage(store, shell, 'https://example.test/image.png');
    assert.deepEqual(urls, ['https://example.test/image.png']);
    for (const url of ['javascript:alert(1)', 'data:image/png;base64,abc', 'file:///C:/fake.png'])
      await assert.rejects(() => openImage(store, shell, url));
    assert.equal(paths.length, 1, 'rejected files never reach the OS viewer');
    assert.equal(await fs.readFile(note, 'utf8'), 'original');
  } finally { await cleanupSmokeWorkspace(workspace); }
});
