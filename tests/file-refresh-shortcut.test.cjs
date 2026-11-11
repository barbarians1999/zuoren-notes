const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installFileRefreshShortcut } = require('../electron/file-refresh-shortcut.cjs');
function fixture() {
  const contents = new EventEmitter(), sent = []; contents.send = channel => sent.push(channel);
  const dispose = installFileRefreshShortcut(contents);
  const key = input => { let prevented = false; contents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'F5', ...input }); return prevented; };
  return { contents, sent, key, dispose };
}
test('plain F5 suppresses Chromium reload and requests a document check once', () => {
  const f = fixture(); assert.equal(f.key(), true); assert.deepEqual(f.sent, ['refresh-note-request']);
});
for (const flag of ['isAutoRepeat', 'isComposing', 'control', 'alt', 'meta', 'shift']) test(`${flag} F5 cannot reload the window or submit a refresh`, () => {
  const f = fixture(); assert.equal(f.key({ [flag]: true }), true); assert.equal(f.sent.length, 0);
});
test('other shortcuts and key-up retain their existing handling', () => {
  const f = fixture(); assert.equal(f.key({ key: 'F11' }), false); assert.equal(f.key({ type: 'keyUp' }), false); assert.equal(f.sent.length, 0);
});
test('window destruction or explicit cleanup detaches the native listener', () => {
  const f = fixture(); f.contents.emit('destroyed'); assert.equal(f.key(), false); assert.equal(f.contents.listenerCount('before-input-event'), 0);
  const other = fixture(); other.dispose(); other.dispose(); assert.equal(other.key(), false);
});
test('preload passes no Electron event or arbitrary payload through the refresh bridge and unsubscribes', () => {
  const ipc = new EventEmitter(); let api, args;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (_name, value) => api = value }, ipcRenderer: ipc }; },
  });
  const off = api.onRefreshNote((...value) => args = value);
  ipc.emit('refresh-note-request', { secret: 'main event' }, { path: 'untrusted' }); assert.deepEqual(args, []);
  off(); assert.equal(ipc.listenerCount('refresh-note-request'), 0);
});
