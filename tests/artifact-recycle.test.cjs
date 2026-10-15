const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('shared recycle implementation rejects broad targets and preserves originals; PS 5.1 native interface compiles', async () => {
  const root = path.resolve(__dirname, '..');
  for (const name of ['artifact-recycle', 'accepted-artifact', 'recycle-old-releases', 'sync-installer']) {
    const source = await fs.readFile(path.join(root, 'scripts', name + '.ps1'), 'utf8');
    assert.equal(/[^\x00-\x7f]/.test(source), false, 'PowerShell launcher is encoding-independent');
    assert.ok(!/Set-ItemProperty|NukeOnDelete\s*=|MaxCapacity\s*=|Stop-Process/.test(source));
  }
  if (process.platform !== 'win32') return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recycle-policy-'));
  try {
    const output = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'artifact-recycle-policy.ps1'), '-TemporaryRoot', directory], { encoding: 'utf8', windowsHide: true });
    assert.equal(output.status, 0, output.stdout + output.stderr);
    assert.equal(await fs.readFile(path.join(directory, 'fixture/sample.txt'), 'utf8'), 'abc');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
