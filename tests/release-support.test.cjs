const test = require('node:test');
const assert = require('node:assert/strict');
const { options, changes, checkMac, passed, tapResult, releaseForTag, checkPublication } = require('../scripts/release-support.cjs');

test('publication resume and Mac publishing find drafts without using the published-only tag endpoint', async () => {
  const draft = { id: 5, tag_name: 'v0.3.4', draft: true };
  const requests = [];
  const api = async endpoint => {
    requests.push(endpoint);
    return endpoint.endsWith('page=1') ? Array.from({ length: 100 }, () => ({ tag_name: 'v0.1.0' })) : [draft];
  };
  assert.equal(await releaseForTag(api, 'v0.3.4'), draft);
  assert.deepEqual(requests, ['releases?per_page=100&page=1', 'releases?per_page=100&page=2']);
  assert.equal(await releaseForTag(async () => [], 'v0.3.4'), null);
  await assert.rejects(releaseForTag(async () => [draft, draft], 'v0.3.4'), /Multiple releases/);
});

const windowsPosixNames = [
  'note saves preserve POSIX permissions while history stays owner-only',
  'new notes, atomic files and recovery drafts are private even with a permissive umask',
  'replacement restores the original mode rather than restricting it through the current umask',
  'atomic temporary files are private before any content is written',
  'save uses permissions changed during backup work and leaves conflicts untouched',
  'history writes restrict an existing permissive snapshot at the same destination',
  'permission and stat errors fail closed, preserving the original and cleaning the temporary file',
];
const skipReason = 'POSIX mode bits are not supported on Windows';
const windowsUnit = { platform: 'win32', stage: 'unit' };
function actualTap(names = [], passing = 2) {
  const { spawnSync } = require('node:child_process');
  const body = `const test=require('node:test');
    for(let i=0;i<${passing};i++)test('passing '+i,()=>{});
    for(const name of ${JSON.stringify(names)})test(name,{skip:${JSON.stringify(skipReason)}},()=>{throw Error('must not run')});`;
  const result = spawnSync(process.execPath, ['--test-reporter=tap', '-e', body], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('release gate accepts actual completed TAP and rejects incomplete or unsuccessful evidence', () => {
  const summary = actualTap();
  assert.equal(passed(summary), 2);
  assert.equal(passed(summary.replace(/\n/g, '\r\n')), 2);
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    assert.throws(() => passed(summary.replace(new RegExp('^# ' + key + ' [0-9]+\\n', 'm'), '')));
  }
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.throws(() => passed(summary.replace('# ' + key + ' 0', '# ' + key + ' 1')));
    assert.throws(() => passed(summary.replace('# ' + key + ' 0\n', '')));
  }
  for (const invalid of ['', summary.replace('# pass 2', '# pass 1'),
    summary + '# pass 2\n', summary.replace('1..2\n', ''),
    summary.replace('1..2\n', '1..3\n'), summary.replace('ok 2 -', 'ok 1 -'),
    summary.replace('ok 2 -', 'not ok 2 -'), summary.replace('# tests 2', '# tests 20')]) {
    assert.throws(() => passed(invalid));
  }
});

test('only Windows unit allows the seven exact POSIX skips and reports executed passes separately', () => {
  const summary = actualTap(windowsPosixNames, 435);
  assert.equal(passed(summary, windowsUnit), 435);
  const result = tapResult(summary, windowsUnit);
  assert.equal(result.total, 442);
  assert.equal(result.passed, 435);
  assert.equal(result.skipped, 7);
  assert.deepEqual(result.allowedSkips, windowsPosixNames.map(name => ({ name, reason: skipReason })));
  assert.equal(passed(summary, windowsUnit), 435);
  for (const context of [{}, { platform: 'linux', stage: 'unit' }, { platform: 'darwin', stage: 'unit' },
    ...['source', 'packaged', 'smoke'].map(stage => ({ platform: 'win32', stage }))]) {
    assert.throws(() => tapResult(summary, context));
  }
  for (const invalid of [summary.replace(windowsPosixNames[0] + ' # SKIP', 'unknown # SKIP'),
    summary.replace(' # SKIP ' + skipReason, ' # SKIP wrong reason'),
    summary.replace(windowsPosixNames[1] + ' # SKIP', windowsPosixNames[0] + ' # SKIP'),
    summary.replace('# skipped 7', '# skipped 6'), summary.replace('# pass 435', '# pass 442'),
    summary.replace(' # SKIP ' + skipReason, ''), summary.replace('# fail 0', '# fail 1')]) {
    assert.throws(() => tapResult(invalid, windowsUnit));
  }
  assert.throws(() => tapResult(actualTap(windowsPosixNames.slice(1)), windowsUnit));
  assert.throws(() => tapResult(actualTap([...windowsPosixNames, 'extra']), windowsUnit));
  assert.throws(() => tapResult(actualTap(windowsPosixNames, 0), windowsUnit));
});

test('release gate counts nested tests and suites using actual Node TAP', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['--test-reporter=tap', '-e',
    "const {test,describe}=require('node:test');test('parent',async t=>{await t.test('child',()=>{})});describe('suite',()=>{test('leaf',()=>{})});"], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  assert.equal(result.status, 0);
  assert.equal(passed(result.stdout), 3);
});

test('release defaults to full verification and never silently enables publishing or cleanup', () => {
  assert.deepEqual(options([]), { profile: 'full', publish: false, cleanup: false, resume: false, version: null, plan: null, localTest: false, receipt: null });
  assert.equal(options(['--', '--profile', 'ui', '--publish', '--cleanup']).cleanup, true);
  assert.equal(options(['--cleanup']).publish, false, 'local cleanup does not depend on GitHub');
  assert.throws(() => options(['--local-test', '--cleanup']), /Local test/);
  assert.throws(() => options(['--profile', 'fast']), /Profile/);
  assert.throws(() => options(['--version', '--publish']), /Missing value/);
  assert.throws(() => options(['--version', '../0.3.4']), /Invalid version/);
  assert.throws(() => options(['--clobber']), /Unknown/);
});

test('final publication jointly rejects untagged, wrong commit/latest and altered assets', async () => {
  const expected = { releaseId: 19, tag: 'v0.3.12', sourceCommit: 'abc', assets: [{ name: 'Setup.exe', size: 9, digest: 'sha256:' + 'a'.repeat(64) }] };
  const release = { id: 19, tag_name: expected.tag, draft: false, prerelease: false, assets: expected.assets };
  const fake = (overrides = {}) => async endpoint => overrides[endpoint] || (endpoint === 'git/ref/tags/' + expected.tag ? { object: { type: 'commit', sha: 'abc' } } : release);
  assert.equal((await checkPublication(fake(), expected)).id, 19);
  for (const overrides of [
    { 'releases/19': { ...release, tag_name: 'untagged-123' } },
    { 'releases/latest': { ...release, tag_name: 'untagged-123' } },
    { 'releases/latest': { ...release, id: 18 } },
    { 'git/ref/tags/v0.3.12': { object: { type: 'commit', sha: 'wrong' } } },
    { 'releases/19': { ...release, assets: [{ ...expected.assets[0], digest: 'sha256:' + 'b'.repeat(64) }] } },
    { 'releases/19': { ...release, draft: true } },
  ]) await assert.rejects(checkPublication(fake(overrides), expected));
  await checkPublication(fake({ 'git/ref/tags/v0.3.12': { object: { type: 'tag', sha: 'tag-object' } }, 'git/tags/tag-object': { object: { type: 'commit', sha: 'abc' } } }), expected);
});

test('release notes select the exact version and cannot be empty', () => {
  assert.equal(changes('# Log\n\n## 0.3.4\n\n- New\n\n## 0.3.3\n- Old', '0.3.4'), '- New');
  assert.throws(() => changes('## 0.3.3\n- Old', '0.3.4'), /no entry/);
  assert.throws(() => changes('## 0.3.4\n\n## 0.3.3\n- Old', '0.3.4'), /Empty/);
});

test('Mac publication gate rejects stale source, wrong architecture, failed smoke and digest or size mismatch', () => {
  const report = { version: '0.3.4', platform: 'darwin', architecture: 'arm64', sourceCommit: 'abc', nativePackageSmoke: 'passed', nativeUnitTests: 179,
    dmg: { name: 'ZuorenNotes-0.3.4-macOS-arm64.dmg', bytes: 100, sha256: 'a'.repeat(64) } };
  const asset = { name: report.dmg.name, size: 100, digest: 'sha256:' + report.dmg.sha256 };
  checkMac(report, asset, 'arm64', '0.3.4', 'abc');
  for (const field of ['sourceCommit', 'architecture', 'version', 'nativePackageSmoke']) {
    assert.throws(() => checkMac({ ...report, [field]: 'wrong' }, asset, 'arm64', '0.3.4', 'abc'));
  }
  assert.throws(() => checkMac(report, { ...asset, size: 101 }, 'arm64', '0.3.4', 'abc'));
  assert.throws(() => checkMac(report, { ...asset, digest: 'sha256:' + 'b'.repeat(64) }, 'arm64', '0.3.4', 'abc'));
});
