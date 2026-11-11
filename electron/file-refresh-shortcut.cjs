// Own F5 before Chromium can reload the renderer and lose an unsaved draft.
// Only a plain, non-repeated, non-IME key press requests a document check.
function installFileRefreshShortcut(contents) {
  const onInput = (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F5') return;
    event.preventDefault();
    if (input.isAutoRepeat || input.isComposing || input.control || input.alt || input.meta || input.shift) return;
    contents.send('refresh-note-request');
  };
  contents.on('before-input-event', onInput);
  const dispose = () => contents.removeListener('before-input-event', onInput);
  contents.once('destroyed', dispose);
  return dispose;
}
module.exports = { installFileRefreshShortcut };
