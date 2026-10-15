// Remote-only continuation, explicitly invoked by the GitHub conversation.
// No build, local sync, cleanup, or installation exists in this entry point.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createReadStream } = require('node:fs');
const { verifyReceipt, sha256, writeJson } = require('./delivery-receipt.cjs');
const { changes, releaseForTag, checkPublication, checkMac, tagCommit } = require('./release-support.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  const args = process.argv.slice(2), index = args.indexOf('--receipt');
  if (index < 0 || !args[index + 1] || args.some((arg, n) => n !== index + 1 && !['--receipt', '--with-mac', '--resume'].includes(arg))) throw Error('Use --receipt ABSOLUTE_VALIDATION_JSON [--with-mac] [--resume]');
  const reportFile = path.resolve(args[index + 1]), report = await verifyReceipt(reportFile);
  const { version, sourceCommit } = report, tag = 'v' + version;
  const git = process.env.ZUOREN_RELEASE_GIT || 'git';
  const gitRead = list => execFileSync(git, list, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  const committedManifest = JSON.parse(gitRead(['show', sourceCommit + ':package.json']));
  if (committedManifest.version !== version) throw Error('Commit version differs from receipt');
  if (gitRead(['rev-parse', sourceCommit + ':pnpm-lock.yaml']) !== report.source.lockFile.gitBlob) throw Error('Commit dependency lock differs from receipt');
  const repository = gitRead(['remote', 'get-url', 'origin']).match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
  if (!repository) throw Error('Expected credential-free HTTPS origin');
  const credential = execFileSync(git, ['credential', 'fill'], { cwd: root, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const token = credential.match(/^password=(.+)$/m)?.[1].trim();
  if (!token) throw Error('No GitHub credential; local delivery unchanged');
  const headers = { Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' };
  const api = async (endpoint, { method = 'GET', body, optional404 = false, raw = false } = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, { method,
      headers: { ...headers, Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    if (optional404 && response.status === 404) return null;
    if (!response.ok) throw Error('GitHub ' + response.status + ': ' + endpoint);
    return response.status === 204 ? null : raw ? response.text() : response.json();
  };
  // Push the receipt's commit, not whichever HEAD another conversation has.
  execFileSync(git, ['push', 'origin', sourceCommit + ':refs/heads/main'], { cwd: root, stdio: 'inherit' });
  if ((await api('git/ref/heads/main')).object.sha !== sourceCommit) throw Error('Remote main differs from tested commit');
  if (!await api('git/ref/tags/' + tag, { optional404: true })) await api('git/refs', { method: 'POST', body: { ref: 'refs/tags/' + tag, sha: sourceCommit } });
  if (await tagCommit(api, tag) !== sourceCommit) throw Error('Tag commit mismatch');
  let cloud = await releaseForTag(api, tag);
  const installerName = `ZuorenNotes-Setup-${version}.exe`;
  if (!cloud) cloud = await api('releases', { method: 'POST', body: { tag_name: tag, target_commitish: sourceCommit, name: tag, draft: true,
    body: changes(gitRead(['show', sourceCommit + ':CHANGELOG.md']), version) + `\n\nSource: \`${sourceCommit}\`\nVerification: \`${report.profile}\` - ${report.scope}\nWindows SHA256: \`${report.installerSha256}\`\n` } });
  if (cloud.tag_name !== tag) throw Error('Created release tag_name mismatch');
  const files = [[path.join(report.artifacts.directory, report.installer), installerName], [reportFile, 'Windows-VALIDATION.json']];
  // The public checksum uses the public download name, not the local Chinese name.
  const publicChecksums = path.join(root, 'logs', 'releases', version, 'PUBLIC-SHA256SUMS.txt');
  await fs.writeFile(publicChecksums, `${report.installerSha256}  ${installerName}\n`); files.push([publicChecksums, 'SHA256SUMS.txt']);
  const expected = [];
  for (const [file, name] of files) {
    const item = { name, size: (await fs.stat(file)).size, digest: 'sha256:' + await sha256(file) }; expected.push(item);
    const current = await api('releases/' + cloud.id);
    if (current.tag_name !== tag) throw Error('Release tag changed before upload');
    const existing = current.assets.find(asset => asset.name === name);
    if (existing) { if (existing.digest !== item.digest || existing.size !== item.size) throw Error('Different existing asset: ' + name); continue; }
    const stream = createReadStream(file);
    try {
      const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${cloud.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(item.size) }, body: stream, duplex: 'half', signal: AbortSignal.timeout(600000) });
      if (!response.ok) throw Error('Asset upload failed: ' + response.status);
      const uploaded = await response.json();
      if (uploaded.digest !== item.digest || uploaded.size !== item.size) throw Error('Uploaded bytes differ: ' + name);
    } finally { stream.destroy(); }
  }
  const macReports = [];
  if (args.includes('--with-mac')) {
    const stateFile = path.join(root, 'logs', 'releases', version, 'publish-state.json');
    const state = await fs.readFile(stateFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { version, sourceCommit }; throw error; });
    if (state.version !== version || state.sourceCommit !== sourceCommit) throw Error('Mac checkpoint differs');
    if (state.runId && args.includes('--resume')) { const run = await api('actions/runs/' + state.runId); if (run.status === 'completed' && run.conclusion !== 'success') state.runId = null; }
    const runsPath = 'actions/workflows/macos-release.yml/runs?event=workflow_dispatch&per_page=20';
    if (!state.runId) {
      const before = new Set((await api(runsPath)).workflow_runs.map(run => run.id));
      await api('actions/workflows/macos-release.yml/dispatches', { method: 'POST', body: { ref: tag, inputs: { release_tag: tag } } });
      for (let attempt = 0; attempt < 12 && !state.runId; attempt++) {
        const run = (await api(runsPath)).workflow_runs.find(run => !before.has(run.id) && run.head_sha === sourceCommit && run.head_branch === tag);
        if (run) state.runId = run.id; else await new Promise(resolve => setTimeout(resolve, 10000));
      }
      if (!state.runId) throw Error('Mac dispatch uncertain; inspect Actions before retrying');
      await writeJson(stateFile, state);
    }
    const deadline = Date.now() + 40 * 60000;
    while (true) {
      const run = await api('actions/runs/' + state.runId);
      if (run.head_sha !== sourceCommit) throw Error('Wrong Mac source');
      if (run.status === 'completed') { if (run.conclusion !== 'success') throw Error('Mac build failed; Windows package retained'); break; }
      if (Date.now() > deadline) throw Error('Mac wait expired; resume without rebuilding Windows');
      console.log('[github] Mac workflow ' + state.runId + ': ' + run.status);
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
    cloud = await api('releases/' + cloud.id);
    for (const architecture of ['arm64', 'x64']) {
      const name = `ZuorenNotes-${version}-macOS-${architecture}-VALIDATION.json`, asset = cloud.assets.find(item => item.name === name);
      if (!asset) throw Error('Missing Mac report: ' + name);
      const text = await api('releases/assets/' + asset.id, { raw: true });
      if ('sha256:' + require('node:crypto').createHash('sha256').update(text).digest('hex') !== asset.digest) throw Error('Mac report hash mismatch');
      const mac = JSON.parse(text), dmg = cloud.assets.find(item => item.name === mac.dmg.name);
      checkMac(mac, dmg, architecture, version, sourceCommit); macReports.push(mac);
      expected.push({ name: asset.name, size: asset.size, digest: asset.digest }, { name: dmg.name, size: dmg.size, digest: dmg.digest });
    }
  }
  await checkPublication(api, { releaseId: cloud.id, tag, sourceCommit, assets: expected, publicRelease: false });
  await api('releases/' + cloud.id, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  const final = await checkPublication(api, { releaseId: cloud.id, tag, sourceCommit, assets: expected });
  await writeJson(path.join(root, 'logs', 'releases', version, 'PUBLISHED.json'), { schemaVersion: 2, version, sourceCommit, releaseId: final.id, tag: final.tag_name, url: final.html_url, latestVerified: true, assets: expected, macReports });
  console.log('[github] final identity, latest and asset hashes verified: ' + final.html_url);
}
if (require.main === module) main().catch(error => { console.error('[github] stopped: ' + error.message); process.exitCode = 1; });
module.exports = { main };
