const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syncReleaseBranch } = require('../scripts/release-support.cjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function withTempRepo(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuoren-branch-sync-'));
  try {
    git(dir, ['init', '-b', 'codex/release-0.4.17']);
    git(dir, ['config', 'user.name', 'Test User']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    await fs.writeFile(path.join(dir, 'package.json'), '{"version":"0.4.17"}\n');
    git(dir, ['add', 'package.json']);
    git(dir, ['commit', '-m', 'init 0.4.17']);
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('syncReleaseBranch creates and switches to target codex/release-<version> branch', async () => {
  await withTempRepo(async dir => {
    const firstSha = git(dir, ['rev-parse', 'HEAD']);
    const result = syncReleaseBranch(dir, '0.4.18');
    assert.deepEqual(result, { changed: true, created: true, from: 'codex/release-0.4.17', branch: 'codex/release-0.4.18' });
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'codex/release-0.4.18');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), firstSha);
  });
});

test('syncReleaseBranch switches cleanly when target branch exists at same commit', async () => {
  await withTempRepo(async dir => {
    git(dir, ['branch', 'codex/release-0.4.18']);
    const result = syncReleaseBranch(dir, '0.4.18');
    assert.deepEqual(result, { changed: true, created: false, from: 'codex/release-0.4.17', branch: 'codex/release-0.4.18' });
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'codex/release-0.4.18');
  });
});

test('syncReleaseBranch reports conflict without moving branch when target points elsewhere', async () => {
  await withTempRepo(async dir => {
    git(dir, ['branch', 'codex/release-0.4.18']);
    await fs.writeFile(path.join(dir, 'package.json'), '{"version":"0.4.18"}\n');
    git(dir, ['add', 'package.json']);
    git(dir, ['commit', '-m', 'advance on 0.4.17 branch']);
    const result = syncReleaseBranch(dir, '0.4.18');
    assert.deepEqual(result, { changed: false, conflict: true, branch: 'codex/release-0.4.17', target: 'codex/release-0.4.18' });
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'codex/release-0.4.17');
  });
});

test('syncReleaseBranch leaves non-release branches untouched', async () => {
  await withTempRepo(async dir => {
    git(dir, ['checkout', '-b', 'main']);
    const result = syncReleaseBranch(dir, '0.4.18');
    assert.deepEqual(result, { changed: false, branch: 'main', reason: 'non-release-branch' });
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  });
});
