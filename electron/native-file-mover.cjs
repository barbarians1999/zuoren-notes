const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

class NativeFileMover {
  constructor({ platform = process.platform, arch = process.arch, spawn = childProcess.spawn, timeout = 45000, cleanupTimeout = 5000, workerPath, manifestPath } = {}) {
    this.platform = platform; this.arch = arch; this.spawn = spawn; this.timeout = timeout; this.cleanupTimeout = cleanupTimeout; this.active = false; this.probe = null;
    this.workerPath = workerPath || path.join(__dirname, 'native', 'FileMoveWorker.exe').replace(/\.asar([\\/])/, '.asar.unpacked$1');
    this.manifestPath = manifestPath || path.join(__dirname, 'native', 'FileMoveWorker.manifest.json');
  }
  async verify() {
    const manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
    const digest = crypto.createHash('sha256').update(await fs.readFile(this.workerPath)).digest('hex');
    if (manifest.protocol !== 2 || digest !== manifest.binary_sha256) throw new Error('安全移动工作程序身份不匹配，未启动');
    return manifest;
  }
  async capability() {
    if (this.platform !== 'win32' || this.arch !== 'x64') return { supported: false, reason: '文件移动目前支持 Windows x64 本地固定盘的 NTFS 或 exFAT 资料文件夹。' };
    if (this.active) return { supported: false, reason: '上一轮原生移动尚未退出，已阻止新操作。' };
    if (!this.probe) this.probe = (async () => {
      try { const manifest = await this.verify();
        if (manifest.release_ready !== true) return { supported: false, reason: '文件移动尚未完成全部安全验收，此版本暂未启用；文件未移动。' };
        const result = await this.run(['--probe'], null);
        if (result.status !== 'supported' || result.protocol !== 2 || !Array.isArray(result.cases) || !['relative-no-reparse-does-not-create-outside', 'held-sentinel-prevents-directory-reparse', 'relative-rename-and-no-replace', 'source-handle-excludes-concurrent-write'].every(name => result.cases.includes(name)))
          return { supported: false, reason: `原生无害前置检查未通过：${result.error || '不支持当前环境'}` };
        return { supported: true, evidence: result };
      } catch (error) { return { supported: false, reason: `安全移动能力不可用，未移动文件：${error.message}` }; }
    })();
    return this.probe;
  }
  async move(input) {
    const capability = await this.capability();
    if (!capability.supported) throw new Error(capability.reason);
    const manifest = await this.verify();
    if (manifest.release_ready !== true) throw new Error('原生移动尚未通过本机验收，文件未移动');
    const result = await this.run([], input);
    if (result.status === 'uncertain') { const error = new Error(result.error || '原子移动结果未确认'); error.code = 'MOVE_UNCERTAIN'; throw error; }
    if (result.status !== 'moved') throw new Error(result.error || '当前目录未通过安全移动检查，原文件未移动。');
    return result;
  }
  async readReceipt(input) {
    if (this.platform !== 'win32' || this.arch !== 'x64' || this.active) throw new Error('无法独占核验移动回执');
    await this.verify();
    // Read-only recovery is allowed while product writes remain unqualified.
    const response = await this.run(['--read-receipt'], input);
    const receipt = response.receipt;
    if (response.status !== 'receipt' || receipt?.schema !== 2 || receipt.operationId !== input.OperationId
      || receipt.nonce !== input.ReceiptNonce || receipt.binding !== input.RequestBinding
      || !['moved', 'failed', 'uncertain'].includes(receipt.result?.status)) throw new Error('移动回执未确认');
    return receipt.result;
  }
  run(args, input) {
    if (this.active) return Promise.reject(new Error('上一轮原生工作程序尚未退出'));
    let encoded; try { encoded = input ? JSON.stringify(input) : ''; } catch (error) { return Promise.reject(error); }
    this.active = true;
    return new Promise((resolve, reject) => {
      let child, ready = false, closed = false, timedOut = false, settled = false, output = '', stderr = '', timer, finalTimer;
      const fail = (message, uncertain) => { if (settled) return; settled = true; const error = new Error(message); if (uncertain) error.code = 'MOVE_UNCERTAIN'; reject(error); };
      const stop = () => {
        if (timedOut || closed) return;
        timedOut = true;
        // On Windows Node's ChildProcess owns a libuv process HANDLE. This
        // worker never starts children; do not kill by name or reopen a PID.
        try { child.kill(); } catch { /* Keep active/closed state until confirmed. */ }
        finalTimer = setTimeout(() => fail('原生移动超时且退出尚未确认；已阻止后续移动。', ready || input != null), this.cleanupTimeout);
      };
      try { child = this.spawn(this.workerPath, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }); }
      catch (error) { this.active = false; fail(error.message, false); return; }
      timer = setTimeout(stop, this.timeout);
      child.stdout.on('data', chunk => {
        if (Buffer.byteLength(output) + chunk.length > 256 * 1024) { stop(); return; }
        output += chunk.toString('utf8');
        if (/"event"\s*:\s*"ready"/.test(output)) ready = true;
        if (Buffer.byteLength(output) > 256 * 1024 && !timedOut) stop();
      });
      child.stdout.on('error', stop); child.stderr.on('error', stop);
      child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8').slice(0, 64 * 1024 - stderr.length); });
      child.stdin.on('error', () => {});
      child.on('error', error => { if (!ready) fail(error.message, input != null); });
      child.on('close', code => {
        closed = true; this.active = false; clearTimeout(timer); clearTimeout(finalTimer);
        if (settled) return;
        if (timedOut) { fail('原生移动超过时限，必须核对原位置和目标位置。', ready || input != null); return; }
        const lines = output.trim().split(/\r?\n/); let result;
        try {
          const messages = lines.map(line => JSON.parse(line));
          if (messages.length !== 2 || messages[0].event !== 'ready' || messages[0].protocol !== 2) throw new Error('ambiguous receipt');
          result = messages[1];
        } catch { fail('原生移动未返回唯一、可确认的结果。', ready || input != null); return; }
        const exitCodes = { supported: 0, moved: 0, unsupported: 3, failed: 4, uncertain: 5, receipt: 0, unresolved: 6 };
        if (!ready || !Object.hasOwn(exitCodes, result.status) || code !== exitCodes[result.status]) {
          fail(`原生移动工作程序异常退出（${code}）：${stderr.slice(0, 200)}`, ready || input != null); return;
        }
        settled = true; resolve(result);
      });
      try { child.stdin.end(encoded); } catch { stop(); }
    });
  }
}
module.exports = { NativeFileMover };
