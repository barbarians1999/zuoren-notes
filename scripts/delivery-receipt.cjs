const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { digest } = require('./verification-plan.cjs');
const sha256 = async file => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file);
}
async function filesIdentity(root, files) {
  const entries = [];
  for (const file of [...new Set(files)].sort()) entries.push({ path: file, sha256: await sha256(path.join(root, file)) });
  return { sha256: digest(entries), files: entries };
}
async function sourceIdentity(root, git = process.env.ZUOREN_RELEASE_GIT || 'git') {
  const read = args => execFileSync(git, args, { cwd: root, encoding: 'utf8' }).trim();
  const tracked = execFileSync(git, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const inputs = tracked.filter(file => /^(src\/|electron\/|package\.json$|pnpm-lock\.yaml$|(?:vite|tsconfig)[^/]*|scripts\/(?:installer|release-paths)\.cjs$)/.test(file));
  return { commit: read(['rev-parse', 'HEAD']), dirty: !!read(['status', '--porcelain']),
    lockFile: { path: 'pnpm-lock.yaml', sha256: await sha256(path.join(root, 'pnpm-lock.yaml')), gitBlob: read(['rev-parse', 'HEAD:pnpm-lock.yaml']) },
    inputs: await filesIdentity(root, inputs), nodeVersion: process.version,
    snapshot: await filesIdentity(root, tracked),
    electronVersion: require(path.join(root, 'node_modules/electron/package.json')).version };
}
async function testIdentity(root, files) {
  const helpers = (await fs.readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.cjs') && !name.endsWith('-smoke.cjs') && !name.endsWith('.test.cjs')).map(name => 'tests/' + name);
  const fixtures = [];
  async function walk(directory) { for (const item of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    if (item.isDirectory()) await walk(directory + '/' + item.name); else fixtures.push(directory + '/' + item.name);
  } }
  await walk('tests/fixtures');
  const scripts = (await fs.readdir(path.join(root, 'scripts'))).filter(name => /\.(cjs|ps1)$/.test(name)).map(name => 'scripts/' + name);
  return filesIdentity(root, [...files, ...helpers, ...fixtures, ...scripts]);
}
async function directoryIdentity(root, directory) {
  const files = [];
  async function walk(relative) { for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw Error('Linked build output');
    if (item.isDirectory()) await walk(relative + '/' + item.name); else files.push(relative + '/' + item.name);
  } }
  await walk(directory); return filesIdentity(root, files);
}
function assertReceipt(report, { official = true } = {}) {
  if (report.schemaVersion !== 2 || report.localAcceptance?.status !== 'passed' || report.build !== 'passed') throw Error('No schema-2 local acceptance receipt; legacy reports cannot prove exact source identity');
  if (official && (report.kind !== 'official' || report.source?.dirty || !/^[a-f0-9]{40}$/.test(report.sourceCommit))) throw Error('Only committed official deliveries may be synchronized, cleaned or published');
  if (!/^\d+\.\d+\.\d+$/.test(report.version) || report.sourceCommit !== report.source?.commit) throw Error('Invalid version or inconsistent source commit');
  if (!/^[a-f0-9]{64}$/.test(report.source?.inputs?.sha256 || '') || !/^[a-f0-9]{64}$/.test(report.source?.lockFile?.sha256 || '')) throw Error('Missing source or dependency-lock identity');
  if (!report.plan?.sha256 || !report.plan.reason) throw Error('Missing verification plan');
  const { sha256: planHash, ...definition } = report.plan;
  if (digest(definition) !== planHash || report.profile !== report.plan.profile) throw Error('Verification plan identity mismatch');
  for (const name of ['unit', 'source', 'packaged']) {
    if (report.tests?.[name]?.status !== 'passed' || report.tests[name].count <= 0 || !report.tests[name].inputsSha256) throw Error('Incomplete test evidence: ' + name);
    if (JSON.stringify(report.tests[name].files) !== JSON.stringify(report.plan[name])) throw Error('Executed test files differ from plan: ' + name);
  }
  const payload = report.installerPayload;
  if (!payload?.embeddedAppAsarMatchesTestedProgram || !payload.executableAndInstallerIconsMatchConfiguredSource || payload.checked <= 0 || payload.missing !== 0 || payload.mismatched !== 0) throw Error('Incomplete installer payload verification');
  if (!path.isAbsolute(report.artifacts?.directory || '') || path.basename(report.installer || '') !== report.installer) throw Error('Invalid artifact path');
  for (const field of ['installerSha256', 'appAsarSha256', 'executableSha256']) if (!/^[a-f0-9]{64}$/.test(report[field] || '')) throw Error('Missing artifact hash: ' + field);
  return report;
}
function assertReusableBuild(checkpoint, source, version, kind) {
  if (checkpoint.schemaVersion !== 2 || checkpoint.version !== version || checkpoint.kind !== kind || checkpoint.source.inputs.sha256 !== source.inputs.sha256 ||
    checkpoint.source.lockFile.sha256 !== source.lockFile.sha256 || checkpoint.source.electronVersion !== source.electronVersion || checkpoint.source.nodeVersion !== source.nodeVersion) throw Error('Build inputs changed; prepare a new version instead of overwriting this package');
}
async function verifyReceipt(file, options) {
  const report = assertReceipt(await readJson(file), options), directory = report.artifacts.directory;
  if (path.resolve(file) !== path.join(directory, 'VALIDATION.json')) throw Error('Use the receipt next to its verified artifacts');
  for (const [name, expected] of [[report.installer, report.installerSha256], ['win-unpacked/resources/app.asar', report.appAsarSha256], ['win-unpacked/ZuorenNotes.exe', report.executableSha256]]) {
    const target = path.resolve(directory, name);
    if (!target.startsWith(path.resolve(directory) + path.sep) || await sha256(target) !== expected) throw Error('Accepted artifact changed: ' + name);
  }
  if ((await fs.stat(path.join(directory, report.installer))).size !== report.installerBytes) throw Error('Installer size mismatch');
  return report;
}
if (require.main === module) verifyReceipt(path.resolve(process.argv[2])).then(report => console.log(JSON.stringify({ version: report.version, directory: report.artifacts.directory, installer: report.installer, sha256: report.installerSha256 }))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { sha256, readJson, writeJson, filesIdentity, sourceIdentity, testIdentity, assertReceipt, verifyReceipt, assertReusableBuild, directoryIdentity };
