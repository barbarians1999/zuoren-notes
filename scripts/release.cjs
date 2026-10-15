// Local delivery only. The GitHub entry point consumes a verified receipt;
// it never rebuilds a Windows package or participates in local cleanup.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { options, passed } = require('./release-support.cjs');
const { testPlan } = require('./verification-plan.cjs');
const { releaseDirectory } = require('./release-paths.cjs');
const { sha256, sourceIdentity, testIdentity, readJson, writeJson, verifyReceipt, assertReusableBuild, directoryIdentity } = require('./delivery-receipt.cjs');
const { acquireUiLock } = require('./native-ui-lock.cjs');
const root = path.resolve(__dirname, '..');
const cli = (module, file) => path.join(path.dirname(require.resolve(module + '/package.json')), file);
let logs;
async function run(name, executable, args, environment = {}) {
  console.log('[delivery] ' + name);
  const output = createWriteStream(path.join(logs, name + '.log')); let tail = '';
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: root, windowsHide: true, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
      const capture = bytes => { output.write(bytes); tail = (tail + bytes.toString()).slice(-5000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(name + ' failed (' + code + '):\n' + tail)));
    });
  } finally { await new Promise(resolve => output.end(resolve)); }
  return fs.readFile(path.join(logs, name + '.log'), 'utf8');
}
const node = (name, args, env) => run(name, process.execPath, args, env);
async function main() {
  const args = options(process.argv.slice(2));
  if (args.publish) throw Error('Use pnpm release:github --receipt PATH in the separate GitHub publication conversation');
  if (process.platform !== 'win32') throw Error('Local delivery runs on Windows');
  const manifest = await readJson(path.join(root, 'package.json')), source = await sourceIdentity(root);
  if (args.version && args.version !== manifest.version) throw Error('Version differs from package.json');
  if (source.dirty && !args.localTest) throw Error('Review and commit release source first; --local-test is explicitly non-publishable');
  const plan = testPlan(root, args.profile, args.plan && path.resolve(args.plan)), version = manifest.version;
  const directory = args.receipt ? path.dirname(path.resolve(args.receipt)) : args.localTest
    ? path.join(root, 'releases', `local-test-${version}-${source.inputs.sha256.slice(0, 12)}`) : releaseDirectory(root);
  if (path.dirname(directory) !== path.join(root, 'releases')) throw Error('Delivery must stay inside this repository releases directory');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logs = path.join(root, 'logs', 'releases', version, 'runs', stamp); await fs.mkdir(logs, { recursive: true });
  const outputs = path.join(root, 'outputs', `ui-${version}`), integrityDirectory = path.join(outputs, 'integrity');
  const installerName = (args.localTest ? 'LOCAL-TEST-' : '') + manifest.build.win.artifactName.replace('${version}', version).replace('${ext}', 'exe');
  const installer = path.join(directory, installerName);
  const executable = path.join(directory, 'win-unpacked', 'ZuorenNotes.exe'), archive = path.join(directory, 'win-unpacked', 'resources', 'app.asar');
  const receiptFile = path.join(directory, 'VALIDATION.json'), checkpointFile = path.join(directory, 'BUILD.json');
  const environment = { ZHAOYE_INSTALLER_OUTPUT: directory, ZHAOYE_INSTALLER_NAME: installerName, ZHAOYE_EXE: executable, ZHAOYE_SMOKE_EXECUTABLE: executable, ZUOREN_UI_DIAGNOSTICS: path.join(logs, 'diagnostics') };
  let checkpoint;
  if (args.resume) {
    checkpoint = await readJson(checkpointFile).catch(() => { throw Error('No modern build checkpoint; historical directed reports cannot prove exact source identity'); });
    assertReusableBuild(checkpoint, source, version, args.localTest ? 'local-test' : 'official');
    if (checkpoint.artifactHashes) for (const [file, expected] of Object.entries(checkpoint.artifactHashes)) if (await sha256(path.join(directory, file)) !== expected) throw Error('Existing build bytes changed: ' + file);
  } else {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory); // Exclusive: never overwrite a running/failed build.
    checkpoint = { schemaVersion: 2, version, kind: args.localTest ? 'local-test' : 'official', source, tests: {}, createdAt: new Date().toISOString() };
    await writeJson(checkpointFile, checkpoint);
  }
  const prior = await readJson(receiptFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (prior) {
    await fs.copyFile(receiptFile, path.join(logs, 'PREVIOUS-VALIDATION.json'));
    await writeJson(receiptFile, { ...prior, localAcceptance: { status: 'revalidation-required', startedAt: new Date().toISOString() } });
  }
  if (!checkpoint.buildComplete) {
    await node('typecheck', [cli('typescript', 'bin/tsc'), '--noEmit']);
    await node('build', [cli('vite', 'bin/vite.js'), 'build']);
    checkpoint.buildOutputs = await directoryIdentity(root, 'dist');
    checkpoint.buildComplete = true; await writeJson(checkpointFile, checkpoint);
  }
  for (const stage of ['unit', 'source', 'packaged']) {
    if (stage === 'packaged' && !checkpoint.artifactHashes) {
      if ((await directoryIdentity(root, 'dist')).sha256 !== checkpoint.buildOutputs.sha256) throw Error('Production build output changed; refusing to package a different build');
      await node('installer', ['scripts/installer.cjs'], { ZHAOYE_INSTALLER_OUTPUT: directory, ZHAOYE_INSTALLER_NAME: installerName });
      checkpoint.artifactHashes = { [path.basename(installer)]: await sha256(installer), 'win-unpacked/resources/app.asar': await sha256(archive), 'win-unpacked/ZuorenNotes.exe': await sha256(executable) };
      await writeJson(checkpointFile, checkpoint);
    }
    const identity = await testIdentity(root, plan[stage]);
    if (checkpoint.tests[stage]?.inputsSha256 === identity.sha256 && checkpoint.tests[stage].status === 'passed') { console.log('[delivery] reuse verified ' + stage + ' tests'); continue; }
    if (stage === 'source' && (await directoryIdentity(root, 'dist')).sha256 !== checkpoint.buildOutputs.sha256) throw Error('Source UI build output changed; inspect before revalidation');
    const text = stage === 'unit'
      ? await node(stage, ['--test', '--test-reporter=tap', ...plan.unit])
      : await node(stage, ['scripts/test-ui.cjs', '--files', ...plan[stage]], stage === 'packaged' ? environment : { ZUOREN_UI_DIAGNOSTICS: environment.ZUOREN_UI_DIAGNOSTICS });
    checkpoint.tests[stage] = { status: 'passed', count: passed(text), inputsSha256: identity.sha256, files: plan[stage], log: path.relative(root, path.join(logs, stage + '.log')), completedAt: new Date().toISOString() };
    await writeJson(checkpointFile, checkpoint);
  }
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!checkpoint.integrity) {
    await node('installer-integrity', ['scripts/verify-installer.cjs', integrityDirectory], { ZHAOYE_INSTALLER_OUTPUT: directory, ZHAOYE_INSTALLER_NAME: installerName });
    await run('icons', powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/verify-release-icons.ps1'), '-OutputDirectory', path.join(outputs, 'icon-check'), '-ReleaseDirectory', directory, '-InstallerName', installerName]);
    const integrity = await readJson(path.join(integrityDirectory, 'installer-integrity.json')), icons = await readJson(path.join(outputs, 'icon-check', 'summary.json'));
    if (!icons.executableMatchesSource || !icons.installerMatchesSource) throw Error('Icon verification incomplete');
    checkpoint.integrity = { ...integrity.packagedFilesComparedToCurrentBuild, embeddedAppAsarMatchesTestedProgram: integrity.installerEmbeddedAppAsarMatchesTestedProgram, executableAndInstallerIconsMatchConfiguredSource: true };
    await writeJson(checkpointFile, checkpoint);
  }
  const finalSource = await sourceIdentity(root);
  if (finalSource.commit !== source.commit || finalSource.inputs.sha256 !== source.inputs.sha256 || (!args.localTest && finalSource.dirty)) throw Error('Source changed during delivery; acceptance not granted');
  for (const stage of ['unit', 'source', 'packaged']) if ((await testIdentity(root, plan[stage])).sha256 !== checkpoint.tests[stage].inputsSha256) throw Error('Tests changed during delivery: ' + stage);
  const report = { schemaVersion: 2, version, kind: checkpoint.kind, sourceCommit: checkpoint.source.commit, source: checkpoint.source,
    verificationCommit: source.commit, profile: plan.profile, plan, build: 'passed', tests: checkpoint.tests,
    installerPayload: checkpoint.integrity, installer: path.basename(installer), installerBytes: (await fs.stat(installer)).size,
    installerSha256: checkpoint.artifactHashes[path.basename(installer)], appAsarSha256: checkpoint.artifactHashes['win-unpacked/resources/app.asar'], executableSha256: checkpoint.artifactHashes['win-unpacked/ZuorenNotes.exe'],
    artifacts: { directory, installerPath: installer }, scope: plan.reason, localAcceptance: { status: 'passed', completedAt: new Date().toISOString() } };
  await writeJson(receiptFile, report); await verifyReceipt(receiptFile, { official: !args.localTest });
  const checksum = `${report.installerSha256}  ${report.installer}\n${report.appAsarSha256}  win-unpacked/resources/app.asar\n${report.executableSha256}  win-unpacked/ZuorenNotes.exe\n`;
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), checksum);
  await writeJson(path.join(logs, 'VALIDATION.json'), report);
  await writeJson(path.join(root, 'logs', 'releases', version, 'VALIDATION.json'), report);
  const statusFile = path.join(root, 'logs', 'releases', version, 'LOCAL-DELIVERY.json');
  const status = { schemaVersion: 1, version, receipt: receiptFile, acceptance: 'passed', synchronization: 'not-requested', cleanup: 'not-requested', github: 'separate-conversation-not-run' };
  await writeJson(statusFile, status);
  if (!args.localTest) for (const [stage, script, enabled] of [['synchronization', 'sync-installer.ps1', true], ['cleanup', 'recycle-old-releases.ps1', args.cleanup]]) {
    if (!enabled) continue;
    try { await run(stage, powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', script), '-Receipt', receiptFile, '-NodeExecutable', process.execPath, '-Apply']); status[stage] = 'completed'; }
    catch (error) { status[stage] = 'pending'; status[stage + 'Error'] = error.message; process.exitCode = 2; console.error('[delivery] accepted package retained; ' + stage + ' pending: ' + error.message); }
    await writeJson(statusFile, status);
  }
  await writeJson(path.join(root, 'logs', 'releases', version, 'GITHUB-HANDOFF.json'), { schemaVersion: 1, version, expectedTag: 'v' + version, sourceCommit: report.sourceCommit, verificationCommit: report.verificationCommit,
    receipt: receiptFile, receiptSha256: await sha256(receiptFile), dependencyLock: report.source.lockFile, plan: report.plan, kind: report.kind,
    installer: { path: installer, name: `ZuorenNotes-Setup-${version}.exe`, bytes: report.installerBytes, sha256: report.installerSha256 },
    localAcceptance: report.localAcceptance, localStatus: statusFile, remoteActionsPerformed: false });
  console.log('[delivery] ' + report.kind + ' accepted: ' + installer + '\n[delivery] receipt: ' + receiptFile);
}
if (require.main === module) acquireUiLock({ lockPort: 48674, onWait: () => console.error('[delivery] another local delivery is running') })
  .then(lease => main().finally(() => lease.release())).catch(error => { console.error('[delivery] stopped: ' + error.message); process.exitCode = 1; });
module.exports = { main };
