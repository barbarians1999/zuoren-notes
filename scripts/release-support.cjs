const assert = require('node:assert/strict');

function options(args) {
  const result = { profile: 'full', publish: false, cleanup: false, resume: false, version: null, plan: null, localTest: false, receipt: null };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--') continue;
    if (['--publish', '--cleanup', '--resume'].includes(flag)) result[flag.slice(2)] = true;
    else if (flag === '--local-test') result.localTest = true;
    else if (['--profile', '--version', '--plan', '--receipt'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error('Missing value for ' + flag);
      result[flag.slice(2)] = value;
    } else throw Error('Unknown release argument: ' + flag);
  }
  if (!['ui', 'full', 'markdown', 'directed'].includes(result.profile)) throw Error('Profile must be ui, full, markdown, or directed');
  if (result.version && !/^\d+\.\d+\.\d+$/.test(result.version)) throw Error('Invalid version');
  if (result.localTest && (result.publish || result.cleanup)) throw Error('Local test packages cannot publish or retire accepted deliveries');
  if (result.receipt && !result.resume) throw Error('--receipt requires --resume');
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

const windowsPosixSkips = new Set([
  'note saves preserve POSIX permissions while history stays owner-only',
  'new notes, atomic files and recovery drafts are private even with a permissive umask',
  'replacement restores the original mode rather than restricting it through the current umask',
  'atomic temporary files are private before any content is written',
  'save uses permissions changed during backup work and leaves conflicts untouched',
  'history writes restrict an existing permissive snapshot at the same destination',
  'permission and stat errors fail closed, preserving the original and cleaning the temporary file',
]);
const posixSkipReason = 'POSIX mode bits are not supported on Windows';

// Validate Node's complete TAP stream, not just a possibly duplicated summary.
// Only the Windows unit caller may opt into the exact platform exclusions.
function tapResult(text, { platform, stage } = {}) {
  const reject = () => { throw Error('Incomplete or unsuccessful TAP result'); };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.filter(line => line === 'TAP version 13').length !== 1) reject();
  const counts = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = lines.filter(line => line.startsWith('# ' + key + ' '));
    if (matches.length !== 1 || !new RegExp('^# ' + key + ' ([0-9]+)$').test(matches[0])) reject();
    counts[key] = Number(matches[0].slice(key.length + 3));
    if (!Number.isSafeInteger(counts[key])) reject();
  }
  if (counts.pass <= 0 || counts.fail || counts.cancelled || counts.todo ||
      counts.pass + counts.skipped !== counts.tests) reject();
  const allowPosix = platform === 'win32' && stage === 'unit';
  if (counts.skipped && (!allowPosix || counts.skipped !== windowsPosixSkips.size)) reject();
  let records = 0, suites = 0, topPlan = -1;
  const pending = new Map(), allowedSkips = [], seenSkips = new Set();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(?:not ok\b|Bail out!)/i.test(line)) reject();
    const plan = line.match(/^( *)(?:1\.\.)([0-9]+)$/);
    if (plan) {
      const depth = plan[1].length, expected = Number(plan[2]);
      if (!Number.isSafeInteger(expected) || (pending.get(depth) || 0) !== expected) reject();
      pending.delete(depth);
      if (!depth) { if (topPlan !== -1) reject(); topPlan = index; }
      continue;
    }
    const record = line.match(/^( *)ok ([0-9]+) - (.*)$/);
    if (!record) continue;
    if (topPlan !== -1) reject();
    const depth = record[1].length, number = Number(record[2]);
    if (number !== (pending.get(depth) || 0) + 1) reject();
    pending.set(depth, number); records++;
    const directive = record[3].match(/^(.*?) # (SKIP|TODO)(?: (.*))?$/i);
    if (directive) {
      const [, name, kind, reason] = directive;
      if (depth || kind !== 'SKIP' || !allowPosix || !windowsPosixSkips.has(name) ||
          reason !== posixSkipReason || seenSkips.has(name)) reject();
      seenSkips.add(name); allowedSkips.push({ name, reason });
    }
    // A suite has an ok record but is excluded from Node's tests/pass totals.
    for (let next = index + 1; next < lines.length; next++) {
      if (lines[next] === ' '.repeat(depth + 2) + "type: 'suite'") { suites++; break; }
      if (lines[next] === ' '.repeat(depth + 2) + '...' ||
          !lines[next].startsWith(' '.repeat(depth + 2))) break;
    }
  }
  if (topPlan < 0 || pending.size || records !== counts.tests + counts.suites ||
      suites !== counts.suites || allowedSkips.length !== counts.skipped) reject();
  if (lines.slice(0, topPlan).some(line => /^# (?:tests|suites|pass|fail|cancelled|skipped|todo) /.test(line))) reject();
  return { total: counts.tests, passed: counts.pass, skipped: counts.skipped, allowedSkips };
}
function passed(text, context) { return tapResult(text, context).passed; }

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

// Resolve annotated tags too. Tag existence alone says nothing about which
// release page, latest pointer, or asset bytes were published.
async function tagCommit(api, tag) {
  let object = (await api('git/ref/tags/' + tag)).object;
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = (await api('git/tags/' + object.sha)).object;
  if (object.type !== 'commit') throw Error('Tag does not resolve to a commit');
  return object.sha;
}
async function checkPublication(api, { releaseId, tag, sourceCommit, assets, publicRelease = true }) {
  const release = await api('releases/' + releaseId);
  assert.equal(release.id, releaseId, 'Release identity changed');
  assert.equal(release.tag_name, tag, 'Release tag_name mismatch');
  assert.equal(await tagCommit(api, tag), sourceCommit, 'Tag commit mismatch');
  assert.ok(!release.prerelease, 'Unexpected prerelease');
  if (publicRelease) {
    assert.equal(release.draft, false, 'Release still draft');
    const latest = await api('releases/latest');
    assert.equal(latest.id, releaseId, 'Latest points elsewhere');
    assert.equal(latest.tag_name, tag, 'Latest tag_name mismatch');
  }
  for (const expected of assets) {
    const matches = release.assets.filter(item => item.name === expected.name);
    assert.equal(matches.length, 1, 'Missing/duplicate asset: ' + expected.name);
    assert.equal(matches[0].size, expected.size, 'Asset size mismatch: ' + expected.name);
    assert.equal(matches[0].digest, expected.digest, 'Asset hash mismatch: ' + expected.name);
  }
  return release;
}
module.exports = { options, changes, checkMac, passed, tapResult, releaseForTag, checkPublication, tagCommit };
