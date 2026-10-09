// Native-window activation and render-widget focus are separate on Windows.
// Restore only the active owner's content; never activate a background app,
// select a DOM element or interfere with a still-open native dialog.
function installWindowFocus(window) {
  const contents = window.webContents;
  let dialogs = 0;
  const restore = (force = false) => {
    if (dialogs || window.isDestroyed() || contents.isDestroyed() || !window.isFocused()) return;
    if (force || !contents.isFocused()) contents.focus();
  };
  const activate = () => restore(true);
  const mouse = (_event, input) => { if (input.type === 'mouseDown') restore(); };
  window.on('focus', activate);
  contents.on('before-mouse-event', mouse);
  window.once('closed', () => {
    window.removeListener('focus', activate);
    contents.removeListener('before-mouse-event', mouse);
  });
  return async function withDialog(operation) {
    dialogs++;
    try { return await operation(); }
    finally { dialogs--; restore(true); }
  };
}

module.exports = { installWindowFocus };
