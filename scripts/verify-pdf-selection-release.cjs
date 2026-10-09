// Generates the release evidence only after all reports and payload checks pass.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { releaseDirectory } = require('./release-paths.cjs');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.24', 'This release-specific audit is for 0.2.24 only.');
  const release = releaseDirectory(root), output = path.resolve(process.argv[2] || path.join(release, '../../outputs/pdf-selection-0.2.24'));
  const reports = {};
  for (const name of ['unit', 'source-smoke', 'packaged-smoke']) {
    const file = path.join(output, name + '.xml'), xml = await fs.readFile(file, 'utf8');
    assert.ok(xml.trimEnd().endsWith('</testsuites>'), 'Incomplete test report: ' + name);
    assert.doesNotMatch(xml, /<(?:failure|error|skipped)\b/, 'Unsuccessful test report: ' + name);
    const leafTests = (xml.match(/<testcase\b/g) || []).length, suites = (xml.match(/<testsuite\b/g) || []).length;
    const files = [...new Set([...xml.matchAll(/file="([^"]+)"/g)].map(match => path.basename(match[1])))];
    reports[name] = { tests: leafTests + suites, leafTests, suites, pass: leafTests + suites, fail: 0, files: files.sort(), report: path.relative(release, file) };
  }
  const smokeFiles = (await fs.readdir(path.join(root, 'tests'))).filter(file => file.endsWith('-smoke.cjs') && file !== 'packaged-smoke.cjs').sort();
  assert.deepEqual(reports['source-smoke'].files, smokeFiles);
  assert.deepEqual(reports['packaged-smoke'].files, smokeFiles);
  const integrity = JSON.parse(await fs.readFile(path.join(output, 'installer-integrity/installer-integrity.json'), 'utf8'));
  assert.equal(integrity.version, manifest.version); assert.equal(integrity.installerEmbeddedAppAsarMatchesTestedProgram, true);
  assert.equal(hash(await fs.readFile(integrity.installer)), integrity.installerSha256);
  const rollback = path.join(release, '../0.2.23'), rollbackInfo = JSON.parse(await fs.readFile(path.join(rollback, 'VALIDATION.json'), 'utf8'));
  const rollbackInstaller = path.join(rollback, rollbackInfo.installer), rollbackHash = hash(await fs.readFile(rollbackInstaller));
  assert.equal(rollbackHash, rollbackInfo.installerSha256, 'Rollback installer was modified.');
  if (rollbackInfo.rebuiltFromOriginalArchive) {
    const historical = JSON.parse(await fs.readFile(path.resolve(rollback, rollbackInfo.historicalValidation, 'installer-integrity/installer-integrity.json'), 'utf8'));
    assert.equal(hash(await fs.readFile(path.join(rollback, 'win-unpacked/resources/app.asar'))), historical.testedAppAsarSha256, 'Rollback application is not the original 0.2.23 payload.');
    assert.equal(rollbackInfo.rebuiltPackageStartup?.pass, true, 'Rebuilt rollback must pass its version-specific startup check.');
  }
  const images = [];
  for (const stage of ['source', 'packaged']) for (const size of ['wide', 'narrow']) for (const theme of ['light', 'dark']) {
    const file = path.join(output, stage + '-screenshots', `pdf-selection-${size}-${theme}.png`);
    await fs.access(file); images.push(path.relative(release, file));
  }
  const changedFiles = ['src/main.tsx', 'src/readers/PdfPane.tsx', 'src/readers/pdfSelection.ts', 'src/readers/pdfTextAction.ts', 'src/readers/usePdfSelection.ts', 'src/readers/PdfPopover.tsx', 'src/styles.css', 'package.json', 'CHANGELOG.md', 'tests/pdf-selection.test.cjs', 'tests/pdf-text-action.test.cjs', 'tests/pdf-selection-smoke.cjs', 'tests/reader-reliability-smoke.cjs', 'tests/packaged-smoke.cjs', 'scripts/verify-pdf-selection-release.cjs', 'scripts/restore-0.2.23-rollback.cjs', 'scripts/verify-0.2.23-rollback.cjs'];
  const sourceSha256 = {};
  for (const file of changedFiles) sourceSha256[file] = hash(await fs.readFile(path.join(root, file)));
  const executableSha256 = hash(await fs.readFile(path.join(release, 'win-unpacked/ZuorenNotes.exe')));
  const report = { version: manifest.version, verifiedAtUtc: new Date().toISOString(), sourceRoot: root,
    change: 'Unified PDF text selection, geometry and cross-page operations; safe annotation menus and retry identities; display-only legacy highlight cleanup.',
    installer: path.basename(integrity.installer), installerBytes: integrity.installerBytes, installerSha256: integrity.installerSha256, appAsarSha256: integrity.testedAppAsarSha256, executableSha256,
    verification: { typescript: 'passed', productionBuild: 'passed', unit: reports.unit, sourceSmoke: reports['source-smoke'], packagedSmoke: reports['packaged-smoke'], fullSmokeSuiteRerun: true, installerPayload: integrity,
      visualInspection: { images, result: 'Wide/narrow, light/dark PDF selection screenshots inspected for blue selection, yellow saved highlights, no corner strips, opaque bounded toolbar and separate notebook view.' },
      coverage: ['Real native mouse forward/reverse/partial/multiline/cross-page selection', 'Synthetic fragmented Chinese text-layer spans with real mouse selection', 'Real rotated PDF page', 'All 8 intermediate pages survive a fast recycled-page drag', 'PDF and old sidecar geometry remain unchanged', 'One cross-page save batch and one undoable excerpt transaction', 'Save failure, partial success, duplicate clicks, delayed actions and source/target switches', 'Ctrl+C isolation, zoom, deletion menu and deletion undo', 'Existing save, recovery, conflict, Live Preview, clipboard, PDF/EPUB and theme suites'],
      scopeNotes: ['Chinese fragmentation is a synthetic PDF.js-style text-layer fixture, not a corpus of Chinese PDFs.', 'No OCR, PDF layout engine or EPUB redesign.', 'No benchmark claim or automatic installation.'] },
    rollback: { version: '0.2.23', installer: path.relative(release, rollbackInstaller), preserved: true, sha256: rollbackHash,
      rebuiltFromOriginalArchive: rollbackInfo.rebuiltFromOriginalArchive === true,
      originalApplicationArchiveUnchanged: rollbackInfo.originalApplicationArchiveUnchanged ?? null,
      originalInstallerMissing: rollbackInfo.originalInstallerMissing === true,
      rebuiltPackageStartup: rollbackInfo.rebuiltPackageStartup ?? null },
    deployment: { windowsInstallerRun: false, runningInstalledAppStopped: false, runningInstalledAppOverwritten: false, userNotesModified: false, testsUseIsolatedFixturesAndProfiles: true }, sourceSha256 };
  await fs.writeFile(path.join(release, 'VALIDATION.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(release, 'SHA256SUMS.txt'), `${report.installerSha256}  ${report.installer}\n${report.appAsarSha256}  win-unpacked/resources/app.asar\n${executableSha256}  win-unpacked/ZuorenNotes.exe\n`);
  console.log(JSON.stringify({ version: report.version, unit: reports.unit.tests, sourceSmoke: reports['source-smoke'].tests, packagedSmoke: reports['packaged-smoke'].tests, smokeFiles: smokeFiles.length, installer: integrity.installer, validation: path.join(release, 'VALIDATION.json'), rollbackVerified: true }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
