const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
test('native UI input is serial across independent processes and an OS crash releases ownership', { timeout: 20000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const children = [];
  const start = hold => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/ui-lock-worker.cjs'), String(port), String(hold)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); children.push(child);
    const acquired = new Promise((resolve, reject) => { child.stdout.once('data', data => resolve(Number(data.toString().trim().split(' ')[1]))); child.once('error', reject); child.once('exit', code => { if (code) reject(Error('Lock worker failed')); }); });
    return { child, acquired, closed: new Promise(resolve => child.once('exit', resolve)) };
  };
  try {
    const first = start(600), firstAt = await first.acquired, second = start(100);
    assert.ok(await second.acquired - firstAt >= 500, 'second process cannot overlap the first'); await second.closed;
    const crashing = start(30000); await crashing.acquired; const waiting = start(1);
    crashing.child.kill(); await crashing.closed; assert.ok(await waiting.acquired > 0); await waiting.closed;
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
});
