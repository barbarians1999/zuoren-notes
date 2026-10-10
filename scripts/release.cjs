// One release entry point. No automatic commits, installation, or permanent deletion.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createReadStream, createWriteStream } = require('node:fs');
const { releaseDirectory } = require('./release-paths.cjs');
const { options, changes, checkMac, passed, releaseForTag } = require('./release-support.cjs');
const root = path.resolve(__dirname, '..');
const git = process.env.ZUOREN_RELEASE_GIT || 'git';
const gitRead = args => execFileSync(git, args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const uiSmokeFiles = [
  'tests/window-startup-smoke.cjs', 'tests/path-reuse-smoke.cjs', 'tests/note-tabs-smoke.cjs',
  'tests/fullscreen-chrome-smoke.cjs', 'tests/epub-workspace-smoke.cjs', 'tests/epub-search-smoke.cjs',
];
let logs;

async function run(name, executable, args, environment = {}) {
  console.log('[release] ' + name);
  const file = path.join(logs, name + '.log'), output = createWriteStream(file);
  let tail = '';
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
      const capture = bytes => { output.write(bytes); tail = (tail + bytes.toString()).slice(-4000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(Error(name + ' failed (' + code + '):\n' + tail)));
    });
  } finally { await new Promise(resolve => output.end(resolve)); }
  return fs.readFile(file, 'utf8');
}
const node = (name, args, environment) => run(name, process.execPath, args, environment);
const cli = (module, file) => path.join(path.dirname(require.resolve(module + '/package.json')), file);
const json = async (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function main() {
  const args = options(process.argv.slice(2)), manifest = await readJson(path.join(root, 'package.json'));
  if (process.platform !== 'win32') throw Error('Run this entry point on Windows; Mac builds run in GitHub Actions');
  if (args.version && args.version !== manifest.version) throw Error('Version differs from package.json; prepare and commit the version/CHANGELOG first');
  if (gitRead(['status', '--porcelain'])) throw Error('Commit the reviewed source/version first; release never auto-stages working changes');
  const sourceCommit = gitRead(['rev-parse', 'HEAD']), version = manifest.version, tag = 'v' + version;
  const release = releaseDirectory(root), workspace = path.dirname(path.dirname(release));
  logs = path.join(workspace, 'logs', 'releases', version); await fs.mkdir(logs, { recursive: true });
  const outputs = path.join(workspace, 'outputs', 'ui-' + version), integrityDirectory = path.join(outputs, 'integrity');
  const installer = path.join(release, manifest.build.win.artifactName.replace('${version}', version).replace('${ext}', 'exe'));
  const executable = path.join(release, 'win-unpacked', 'ZuorenNotes.exe');
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const reportFile = path.join(release, 'VALIDATION.json');
  let report;
  if (args.resume) {
    report = await readJson(reportFile);
    if (report.version !== version || report.sourceCommit !== sourceCommit || report.profile !== args.profile || report.build !== 'passed'
      || report.sourceUi.failed !== 0 || report.packagedUi.failed !== 0 || !report.installerPayload.embeddedAppAsarMatchesTestedProgram
      || report.installerSha256 !== await hash(installer) || report.appAsarSha256 !== await hash(path.join(release, 'win-unpacked/resources/app.asar'))
      || report.executableSha256 !== await hash(executable)) throw Error('Verified files/source/profile changed; refusing resume');
    console.log('[release] resume verified package; no rebuild');
  } else {
    // Versioned targets must be fresh. Never overwrite a running or previous package.
    if (await fs.stat(release).catch(() => null)) throw Error('Release directory exists; use --resume after validation, or inspect a failed build before retrying');
    await fs.mkdir(outputs, { recursive: true });
    await node('typecheck', [cli('typescript', 'bin/tsc'), '--noEmit']);
    await node('build', [cli('vite', 'bin/vite.js'), 'build']);
    const unitFiles = (await fs.readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.test.cjs')).sort().map(name => 'tests/' + name);
    const unitTests = passed(await node('unit', ['--test', '--test-reporter=tap', ...unitFiles]));
    let sourceTests = 0;
    if (args.profile === 'ui') {
      sourceTests = passed(await node('source-ui', ['--test', '--test-reporter=tap', '--test-concurrency=1',
        ...uiSmokeFiles]));
    } else {
      for (const key of ['test:editor', 'test:readers', 'test:workspace']) {
        const words = manifest.scripts[key].split(/\s+/);
        if (words.shift() !== 'node' || words.includes('&&')) throw Error('Unsupported test script: ' + key);
        sourceTests += passed(await node(key.replace(':', '-'), [...words.slice(0, 1), '--test-reporter=tap', ...words.slice(1)]));
      }
    }
    await node('installer', ['scripts/installer.cjs']);
    const environment = { ZHAOYE_EXE: executable, ZHAOYE_SMOKE_EXECUTABLE: executable };
    const packagedTests = args.profile === 'ui'
      ? passed(await node('packaged-ui', ['--test', '--test-reporter=tap', '--test-concurrency=1',
        'tests/platform-package-smoke.cjs', ...uiSmokeFiles], environment))
      : passed(await node('packaged-full', ['tests/packaged-smoke.cjs'], { ...environment, ZUOREN_RELEASE_TAP: '1' }));
    await node('installer-integrity', ['scripts/verify-installer.cjs', integrityDirectory]);
    await run('icons', powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/verify-release-icons.ps1'), '-OutputDirectory', path.join(outputs, 'icon-check')]);
    const integrity = await readJson(path.join(integrityDirectory, 'installer-integrity.json'));
    const icons = await readJson(path.join(outputs, 'icon-check/summary.json'));
    if (!icons.executableMatchesSource || !icons.installerMatchesSource) throw Error('Icon verification incomplete');
    report = { version, sourceCommit, profile: args.profile, build: 'passed',
      sourceUi: { unitTests, tests: sourceTests, failed: 0 }, packagedUi: { tests: packagedTests, failed: 0, executable: 'win-unpacked/ZuorenNotes.exe' },
      installerPayload: { ...integrity.packagedFilesComparedToCurrentBuild, embeddedAppAsarMatchesTestedProgram: integrity.installerEmbeddedAppAsarMatchesTestedProgram, executableAndInstallerIconsMatchConfiguredSource: true },
      installer: path.basename(installer), installerBytes: integrity.installerBytes, installerSha256: integrity.installerSha256,
      appAsarSha256: integrity.testedAppAsarSha256, executableSha256: await hash(executable),
      scope: args.profile === 'ui' ? 'Directed UI, fullscreen, EPUB workspace/search, platform package, shared tab lifecycle and path-reuse checks; NOT full release regression' : 'Existing source and packaged regression suites' };
    await json(reportFile, report);
    await fs.copyFile(path.join(integrityDirectory, 'installer-integrity.json'), path.join(logs, 'installer-integrity.json'));
    await fs.copyFile(reportFile, path.join(logs, 'VALIDATION.json'));
  }
  if (gitRead(['rev-parse', 'HEAD']) !== sourceCommit || gitRead(['status', '--porcelain'])) throw Error('Source changed during release');
  const installerName = `ZuorenNotes-Setup-${version}.exe`, checksum = path.join(release, 'SHA256SUMS.txt');
  await fs.writeFile(checksum, `${report.installerSha256}  ${installerName}\n${report.appAsarSha256}  win-unpacked/resources/app.asar\n${report.executableSha256}  win-unpacked/ZuorenNotes.exe\n`);
  await fs.copyFile(checksum, path.join(logs, 'SHA256SUMS.txt'));
  if (!args.publish) { console.log('[release] verified local package: ' + installer); return; }

  const remote = gitRead(['remote', 'get-url', 'origin']);
  const repository = remote.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
  if (!repository) throw Error('Expected a credential-free HTTPS GitHub origin');
  const credential = execFileSync(git, ['credential', 'fill'], { cwd: root, encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const token = credential.match(/^password=(.+)$/m)?.[1].trim();
  if (!token) throw Error('No GitHub credential; verified local package retained');
  const headers = { Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' };
  const api = async (endpoint, { method = 'GET', body, accept = 'application/vnd.github+json', optional404 = false, raw = false } = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
      method, headers: { ...headers, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000),
    });
    if (optional404 && response.status === 404) return null;
    if (!response.ok) throw Error('GitHub ' + response.status + ' for ' + endpoint);
    return response.status === 204 ? null : raw ? response.text() : response.json();
  };
  await run('push', git, ['push', 'origin', 'HEAD:main']);
  if ((await api('git/ref/heads/main')).object.sha !== sourceCommit) throw Error('Remote source differs; refusing publication');
  const existingTag = await api('git/ref/tags/' + tag, { optional404: true });
  if (existingTag && existingTag.object.sha !== sourceCommit) throw Error('Release tag differs from tested source');
  if (!existingTag) await api('git/refs', { method: 'POST', body: { ref: 'refs/tags/' + tag, sha: sourceCommit } });
  let cloud = await releaseForTag(api, tag);
  if (!cloud) cloud = await api('releases', { method: 'POST', body: { tag_name: tag, target_commitish: sourceCommit,
    name: tag, draft: true, body: changes(await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), version)
      + `\n\nWindows: \`${installerName}\`\nSHA256: \`${report.installerSha256}\`\n\nVerification profile: \`${args.profile}\`. Source: \`${sourceCommit}\`.\n` } });
  // A tag is immutable for a release; resolving it checks an earlier interrupted run too.
  if (gitRead(['ls-remote', 'origin', 'refs/tags/' + tag]).split(/\s+/)[0] !== sourceCommit) throw Error('Release tag differs from tested source');
  const upload = async (file, name) => {
    const digest = 'sha256:' + await hash(file), size = (await fs.stat(file)).size;
    const current = await api('releases/' + cloud.id);
    const existing = current.assets.find(asset => asset.name === name);
    if (existing) {
      if (existing.digest !== digest || existing.size !== size) throw Error('Refusing to overwrite different release asset: ' + name);
      return;
    }
    console.log('[release] upload ' + name);
    const stream = createReadStream(file);
    const progress = setInterval(() => console.log('[release] uploading ' + name + ': ' + Math.floor(stream.bytesRead / size * 100) + '% read; awaiting server confirmation'), 30000);
    let response;
    try {
      response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${cloud.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
        body: stream, duplex: 'half', signal: AbortSignal.timeout(10 * 60000),
      });
    } finally { clearInterval(progress); stream.destroy(); }
    if (!response.ok) throw Error('GitHub upload failed: ' + response.status);
    const asset = await response.json();
    if (asset.digest !== digest || asset.size !== size) throw Error('Uploaded asset does not match local file');
  };
  for (const [file, name] of [[installer, installerName], [reportFile, 'Windows-VALIDATION.json'], [checksum, 'SHA256SUMS.txt']]) await upload(file, name);

  const stateFile = path.join(logs, 'publish-state.json');
  const state = await readJson(stateFile).catch(error => { if (error.code === 'ENOENT') return { sourceCommit, version }; throw error; });
  if (state.sourceCommit !== sourceCommit || state.version !== version) throw Error('Publication checkpoint belongs to another build');
  if (state.runId && args.resume) {
    const previous = await api('actions/runs/' + state.runId);
    if (previous.status === 'completed' && previous.conclusion !== 'success') state.runId = null;
  }
  const runsPath = 'actions/workflows/macos-release.yml/runs?event=workflow_dispatch&per_page=10';
  if (!state.runId) {
    const before = new Set((await api(runsPath)).workflow_runs.map(run => run.id));
    await api('actions/workflows/macos-release.yml/dispatches', { method: 'POST', body: { ref: tag, inputs: { release_tag: tag } } });
    const deadline = Date.now() + 120000;
    while (!state.runId && Date.now() < deadline) {
      const latest = (await api(runsPath)).workflow_runs.find(run => !before.has(run.id) && run.head_sha === sourceCommit && run.head_branch === tag);
      if (latest) state.runId = latest.id;
      else await sleep(10000);
    }
    if (!state.runId) throw Error('Mac dispatch not found; inspect Actions before retrying');
    await json(stateFile, state);
  }
  console.log('[release] Mac workflow https://github.com/' + repository + '/actions/runs/' + state.runId);
  const deadline = Date.now() + 40 * 60000;
  let lastStatus = '';
  while (true) {
    const workflow = await api('actions/runs/' + state.runId);
    if (workflow.head_sha !== sourceCommit) throw Error('Mac workflow belongs to another source');
    if (workflow.status === 'completed') {
      if (workflow.conclusion !== 'success') throw Error('Mac workflow failed; inspect logs. Windows draft and old release retained');
      break;
    }
    if (Date.now() > deadline) throw Error('Mac workflow exceeded wait limit; resume after checking Actions');
    const jobs = (await api('actions/runs/' + state.runId + '/jobs')).jobs;
    const status = jobs.map(job => job.name + ': ' + (job.conclusion || job.steps.find(step => step.status === 'in_progress')?.name || job.status)).join(' | ');
    if (status !== lastStatus) { console.log('[release] ' + status); lastStatus = status; }
    await sleep(30000);
  }
  cloud = await api('releases/' + cloud.id);
  const required = name => { const asset = cloud.assets.find(item => item.name === name); if (!asset) throw Error('Release asset missing: ' + name); return asset; };
  const assetText = async name => {
    const asset = required(name), text = await api('releases/assets/' + asset.id, { accept: 'application/octet-stream', raw: true });
    if ('sha256:' + crypto.createHash('sha256').update(text).digest('hex') !== asset.digest) throw Error('Validation asset checksum mismatch: ' + name);
    return text;
  };
  const macReports = [];
  for (const architecture of ['arm64', 'x64']) {
    const mac = JSON.parse(await assetText(`ZuorenNotes-${version}-macOS-${architecture}-VALIDATION.json`));
    checkMac(mac, required(mac.dmg.name), architecture, version, sourceCommit); macReports.push(mac);
  }
  const macChecksums = await assetText(`macOS-SHA256SUMS-${version}.txt`);
  for (const mac of macReports) if (!macChecksums.split(/\r?\n/).includes(`${mac.dmg.sha256}  ${mac.dmg.name}`)) throw Error('Mac checksum manifest mismatch');
  for (const [file, name] of [[installer, installerName], [reportFile, 'Windows-VALIDATION.json'], [checksum, 'SHA256SUMS.txt']]) {
    if (required(name).digest !== 'sha256:' + await hash(file)) throw Error('Windows download checksum changed');
  }
  cloud = await api('releases/' + cloud.id, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  if (cloud.draft || (await api('releases/latest')).id !== cloud.id) throw Error('Latest release publication not confirmed');
  await json(path.join(logs, 'PUBLISHED.json'), { version, sourceCommit, url: cloud.html_url, macWorkflow: state.runId,
    assets: cloud.assets.map(asset => ({ name: asset.name, size: asset.size, digest: asset.digest })), macReports });
  await fs.copyFile(path.join(logs, 'PUBLISHED.json'), path.join(release, 'PUBLISHED.json'));
  console.log('[release] verified publication: ' + cloud.html_url);
  if (args.cleanup) {
    await run('cleanup', powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/recycle-old-releases.ps1'), '-Apply']);
    console.log('[release] obsolete local artifacts recycled; see ' + logs);
  }
}

main().catch(error => { console.error('[release] stopped: ' + error.message); process.exitCode = 1; });
