// Restore the missing rollback installer from its verified original payload.
// Never substitute current renderer code or install the resulting package.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  const current = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const releases = path.resolve(root, current.build.directories.output);
  const evidence = path.resolve(releases, '../outputs/editor-border-0.2.23');
  const original = JSON.parse(await fs.readFile(path.join(evidence, 'installer-integrity/installer-integrity.json'), 'utf8'));
  const archive = path.join(original.extractedDirectory, 'app.asar');
  assert.equal(hash(await fs.readFile(archive)), original.testedAppAsarSha256);
  const via = path.dirname(require.resolve('electron-builder'));
  const asar = require(require.resolve('@electron/asar', { paths: [via] }));
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(manifest.version, '0.2.23');
  assert.equal(manifest.productName, current.productName);
  const output = path.join(releases, '0.2.23');
  // This operation only creates a missing release directory.
  await fs.mkdir(output);
  const work = path.join(root, 'work');
  const staging = await fs.mkdtemp(path.join(work, 'restore-rollback-'));
  const electronManifestPath = require.resolve('electron/package.json');
  const electron = JSON.parse(await fs.readFile(electronManifestPath, 'utf8'));
  const electronDist = path.join(path.dirname(electronManifestPath), 'dist');
  assert.equal((await fs.readFile(path.join(electronDist, 'version'), 'utf8')).trim(), electron.version);
  const cli = require.resolve('electron-builder/out/cli/cli.js');
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--projectDir', staging, ...args], {
      cwd: root, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Rollback builder failed: ' + code)));
  });
  try {
    asar.extractAll(archive, staging);
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ ...manifest, build: {
      ...current.build, electronVersion: electron.version, electronDist,
      files: [...current.build.files, 'node_modules/**/*'], directories: { output },
    } }, null, 2));
    // Stamp the runtime as 0.2.23 first; then restore the EXACT original archive.
    await run(['--win', '--dir', '--x64']);
    const runtime = path.join(output, 'win-unpacked');
    const restoredArchive = path.join(runtime, 'resources/app.asar');
    await fs.copyFile(archive, restoredArchive);
    assert.equal(hash(await fs.readFile(restoredArchive)), original.testedAppAsarSha256);
    await run(['--win', 'nsis', '--x64', '--prepackaged', runtime]);
    const installerName = current.build.win.artifactName.replace('${version}', '0.2.23').replace('${ext}', 'exe');
    const installer = path.join(output, installerName);
    const seven = require(require.resolve('7zip-bin', { paths: [via] })).path7za;
    const check = await fs.mkdtemp(path.join(work, 'rollback-integrity-'));
    await new Promise((resolve, reject) => {
      const child = spawn(seven, ['e', '-y', '-o' + check, installer, 'resources\\app.asar'], { stdio: 'inherit' });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Rollback extraction failed')));
    });
    assert.equal(hash(await fs.readFile(path.join(check, 'app.asar'))), original.testedAppAsarSha256);
    const report = { version: '0.2.23', installer: installerName, installerSha256: hash(await fs.readFile(installer)),
      appAsarSha256: original.testedAppAsarSha256, rebuiltFromOriginalArchive: true,
      originalInstallerMissing: true, originalInstallerSha256: original.installerSha256,
      originalApplicationArchiveUnchanged: true, installerEmbeddedArchiveMatches: true,
      historicalValidation: path.relative(output, evidence), automaticInstallation: false,
      verifiedAtUtc: new Date().toISOString() };
    await fs.writeFile(path.join(output, 'VALIDATION.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${report.installerSha256}  ${installerName}\n${report.appAsarSha256}  win-unpacked/resources/app.asar\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    const relative = path.relative(work, staging);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(staging, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
