const test = require('node:test');
const assert = require('node:assert/strict');
const { options, changes, checkMac, passed, releaseForTag, checkPublication } = require('../scripts/release-support.cjs');

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

test('release gate requires completed tests, without failures, cancellations, skips or todos', () => {
  const summary = '# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(passed(summary), 4);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.throws(() => passed(summary.replace('# ' + key + ' 0', '# ' + key + ' 1')));
    assert.throws(() => passed(summary.replace('# ' + key + ' 0\n', '')));
  }
  assert.throws(() => passed(summary.replace('# pass 4', '# pass 3')));
  assert.throws(() => passed(''));
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
