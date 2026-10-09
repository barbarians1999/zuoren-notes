const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

// Observe completed persistence instead of assuming a debounce plus I/O will
// always finish within a fixed sleep, including on a busy Windows desktop.
async function waitForFile(file, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let text, lastError;
  do {
    try {
      text = await fs.readFile(file, 'utf8');
      if (predicate(text)) return text;
    } catch (error) { lastError = error; }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('File did not reach the expected saved content: ' + file, { cause: lastError });
}
module.exports = { waitForFile };
