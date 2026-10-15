// A local listening socket is an OS-owned mutex: no stale lock files or PID
// guessing, and the kernel releases it even if a test process crashes.
const net = require('node:net');
const crypto = require('node:crypto');
const port = () => Number(process.env.ZUOREN_UI_LOCK_PORT || 48673);
async function acquireUiLock({ timeout = 600000, onWait = () => {}, lockPort = port() } = {}) {
  const token = crypto.randomUUID(), deadline = Date.now() + timeout;
  let notified = false;
  while (true) {
    const server = net.createServer(socket => {
      socket.setTimeout(2000, () => socket.destroy());
      socket.end(token + '\n');
    });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ port: lockPort, host: '127.0.0.1', exclusive: true }, resolve); });
      server.unref();
      return { token, release: () => new Promise(resolve => server.close(resolve)) };
    } catch (error) {
      server.close();
      if (error.code !== 'EADDRINUSE' || Date.now() >= deadline) throw Error('Native UI desktop is busy; no tests started: ' + error.message);
      if (!notified) { onWait(); notified = true; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
async function verifyUiLock(token) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: port(), host: '127.0.0.1' });
    let data = '';
    socket.setTimeout(2000, () => socket.destroy(Error('UI mutex owner unavailable')));
    socket.on('data', chunk => { data += chunk; });
    socket.on('error', reject);
    socket.on('end', () => data.trim() === token ? resolve() : reject(Error('UI mutex ownership mismatch')));
  });
}
module.exports = { acquireUiLock, verifyUiLock };
