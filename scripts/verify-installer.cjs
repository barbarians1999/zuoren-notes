const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { releaseDirectory } = require('./release-paths.cjs');
const root = path.resolve(__dirname, '..');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function files(directory) {
  const result = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(file));
    else if (item.isFile()) result.push(file);
  }
  return result;
}
async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const release = releaseDirectory(root, process.env.ZHAOYE_INSTALLER_OUTPUT);
  const installerName = process.env.ZHAOYE_INSTALLER_NAME || manifest.build.win.artifactName.replace('${version}', manifest.version).replace('${ext}', 'exe');
  if (path.basename(installerName) !== installerName) throw Error('Invalid installer name');
  const installer = path.join(release, installerName);
  const via = path.dirname(require.resolve('electron-builder'));
  const seven = require(require.resolve('7zip-bin', { paths: [via] })).path7za;
  const asar = require(require.resolve('@electron/asar', { paths: [via] }));
  const outputs = path.resolve(process.argv[2] || path.join(root, 'outputs', 'installer-verification'));
  await fs.mkdir(outputs, { recursive: true });
  const extracted = await fs.mkdtemp(path.join(outputs, 'installer-content-'));
  const run = spawnSync(seven, ['e', '-y', '-o' + extracted, installer, 'resources\\app.asar'], { encoding: 'utf8' });
  await fs.writeFile(path.join(extracted, 'extraction.log'), run.stdout + run.stderr);
  if (run.status !== 0) throw Error('Installer extraction failed: ' + run.stderr);
  const archive = path.join(release, 'win-unpacked', 'resources', 'app.asar');
  const tested = hash(await fs.readFile(archive)), embedded = hash(await fs.readFile(path.join(extracted, 'app.asar')));
  if (tested !== embedded) throw Error('Installer payload differs from the tested application.');
  const checked = [...await files(path.join(root, 'dist')), ...await files(path.join(root, 'electron')),
    path.join(root, 'src', 'sessionState.cjs'), path.join(root, 'src', 'pathIdentity.cjs')];
  for (const file of checked) {
    const entry = path.relative(root, file);
    if (hash(await fs.readFile(file)) !== hash(asar.extractFile(archive, entry))) throw Error('Packaged content mismatch: ' + entry);
  }
  const packagedManifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  for (const key of ['name', 'version', 'main', 'productName']) if (manifest[key] !== packagedManifest[key]) throw Error('Packaged manifest mismatch: ' + key);
  const installerSha256 = hash(await fs.readFile(installer));
  const report = { version: manifest.version, installer, installerBytes: (await fs.stat(installer)).size, installerSha256,
    testedAppAsarSha256: tested, installerEmbeddedAppAsarMatchesTestedProgram: true,
    packagedFilesComparedToCurrentBuild: { checked: checked.length, missing: 0, mismatched: 0 }, extractedDirectory: extracted };
  await fs.writeFile(path.join(outputs, 'installer-integrity.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
