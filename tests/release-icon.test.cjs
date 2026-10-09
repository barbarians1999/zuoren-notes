const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('shipping icon references use the constructivist master and include every Windows size', () => {
  const manifest = require('../package.json'), icon = 'electron/assets/app-constructivist.ico';
  assert.equal(manifest.build.win.icon, icon);
  assert.equal(manifest.build.nsis.installerIcon, icon); assert.equal(manifest.build.nsis.uninstallerIcon, icon);
  assert.match(fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8'), /icon: path\.join\(__dirname, 'assets', 'app-constructivist\.ico'\)/);
  assert.match(fs.readFileSync(path.join(root, 'scripts/package.cjs'), 'utf8'), /icon: path\.resolve\(root, manifest\.build\.win\.icon\)/);
  const bytes = fs.readFileSync(path.join(root, icon));
  assert.equal(bytes.readUInt16LE(0), 0); assert.equal(bytes.readUInt16LE(2), 1); assert.equal(bytes.readUInt16LE(4), 7);
  const sizes = [];
  for (let i = 0; i < 7; i++) {
    const entry = 6 + i * 16, size = bytes[entry] || 256, offset = bytes.readUInt32LE(entry + 12), length = bytes.readUInt32LE(entry + 8);
    assert.equal(bytes[entry + 1] || 256, size); assert.ok(offset + length <= bytes.length);
    assert.equal(bytes.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a'); sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  assert.equal(bytes.equals(fs.readFileSync(path.join(root, 'electron/assets/app.ico'))), false, 'new resource must not silently alias the old icon');
});
