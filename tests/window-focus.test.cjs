const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installWindowFocus } = require('../electron/window-focus.cjs');
function fixture() {
  const win = new EventEmitter(), contents = new EventEmitter();
  const state = { windowFocused: true, contentFocused: false, destroyed: false, calls: 0 };
  win.webContents = contents;
  win.isDestroyed = contents.isDestroyed = () => state.destroyed;
  win.isFocused = () => state.windowFocused;
  contents.isFocused = () => state.contentFocused;
  contents.focus = () => { state.calls++; state.contentFocused = true; };
  return { win, contents, state, withDialog: installWindowFocus(win) };
}
test('active native window with lost content focus recovers on mouse-down without suppressing input', () => {
  const f = fixture(); const event = { preventDefault() { throw Error('must not swallow the user click'); } };
  f.contents.emit('before-mouse-event', event, { type: 'mouseMove' }); assert.equal(f.state.calls, 0);
  f.contents.emit('before-mouse-event', event, { type: 'mouseDown' }); assert.equal(f.state.calls, 1);
  f.contents.emit('before-mouse-event', event, { type: 'mouseDown' }); assert.equal(f.state.calls, 1, 'healthy clicks do not force focus');
});
test('activation restores content; background, destroyed and closed windows are not focused', () => {
  const f = fixture(); f.win.emit('focus'); assert.equal(f.state.calls, 1);
  f.state.windowFocused = false; f.win.emit('focus'); f.contents.emit('before-mouse-event', {}, { type: 'mouseDown' }); assert.equal(f.state.calls, 1);
  f.state.windowFocused = true; f.state.destroyed = true; f.win.emit('focus'); assert.equal(f.state.calls, 1);
  f.win.emit('closed'); assert.equal(f.contents.listenerCount('before-mouse-event'), 0); assert.equal(f.win.listenerCount('focus'), 0);
});
test('native dialog cancels, succeeds or rejects with one focus restore after completion', async () => {
  for (const fails of [false, true]) {
    const f = fixture();
    const operation = f.withDialog(async () => {
      f.win.emit('focus'); f.contents.emit('before-mouse-event', {}, { type: 'mouseDown' }); assert.equal(f.state.calls, 0);
      if (fails) throw Error('dialog failure'); return { canceled: true };
    });
    if (fails) await assert.rejects(operation, /dialog failure/); else assert.deepEqual(await operation, { canceled: true });
    assert.equal(f.state.calls, 1);
  }
});
test('overlapping dialogs wait for the last completion and never steal focus from another app', async () => {
  const f = fixture(); let firstDone, secondDone;
  const first = f.withDialog(() => new Promise(resolve => { firstDone = resolve; }));
  const second = f.withDialog(() => new Promise(resolve => { secondDone = resolve; }));
  firstDone(); await first; assert.equal(f.state.calls, 0);
  f.state.windowFocused = false; secondDone(); await second; assert.equal(f.state.calls, 0);
  f.state.windowFocused = true; f.win.emit('focus'); assert.equal(f.state.calls, 1);
});
