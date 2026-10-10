const assert = require('node:assert/strict');

function options(args) {
  const result = { profile: 'full', publish: false, cleanup: false, resume: false, version: null };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--') continue;
    if (['--publish', '--cleanup', '--resume'].includes(flag)) result[flag.slice(2)] = true;
    else if (flag === '--profile' || flag === '--version') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error('Missing value for ' + flag);
      result[flag.slice(2)] = value;
    } else throw Error('Unknown release argument: ' + flag);
  }
  if (!['ui', 'full'].includes(result.profile)) throw Error('Profile must be ui or full');
  if (result.version && !/^\d+\.\d+\.\d+$/.test(result.version)) throw Error('Invalid version');
  if (result.cleanup && !result.publish) throw Error('Cleanup requires verified publication');
  return result;
}

function changes(text, version) {
  const lines = text.split(/\r?\n/), start = lines.indexOf('## ' + version);
  if (start < 0) throw Error('CHANGELOG has no entry for ' + version);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  if (!body) throw Error('Empty release notes');
  return body;
}

function checkMac(report, asset, architecture, version, sourceCommit) {
  assert.equal(report.version, version);
  assert.equal(report.platform, 'darwin');
  assert.equal(report.architecture, architecture);
  assert.equal(report.sourceCommit, sourceCommit);
  assert.equal(report.nativePackageSmoke, 'passed');
  assert.ok(report.nativeUnitTests > 0);
  assert.equal(report.dmg.name, `ZuorenNotes-${version}-macOS-${architecture}.dmg`);
  assert.match(report.dmg.sha256, /^[a-f0-9]{64}$/);
  assert.equal(asset.name, report.dmg.name);
  assert.equal(asset.size, report.dmg.bytes);
  assert.equal(asset.digest, 'sha256:' + report.dmg.sha256);
}

function passed(text) {
  const count = Number(text.match(/^# tests (\d+)\s*$/m)?.[1]);
  const success = Number(text.match(/^# pass (\d+)\s*$/m)?.[1]);
  if (!count || success !== count || !['fail', 'cancelled', 'skipped', 'todo'].every(key =>
    new RegExp('^# ' + key + ' 0\\s*$', 'm').test(text))) throw Error('Incomplete or unsuccessful TAP result');
  return count;
}

// The tag endpoint omits draft releases, even for an authenticated owner.
async function releaseForTag(api, tag) {
  for (let page = 1; page <= 100; page++) {
    const releases = await api(`releases?per_page=100&page=${page}`);
    const matches = releases.filter(release => release.tag_name === tag);
    if (matches.length > 1) throw Error('Multiple releases use ' + tag + '; inspect drafts before continuing');
    if (matches.length) return matches[0];
    if (releases.length < 100) return null;
  }
  throw Error('Release lookup exceeded pagination limit');
}

module.exports = { options, changes, checkMac, passed, releaseForTag };
