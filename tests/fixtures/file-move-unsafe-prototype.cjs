// HISTORICAL REPRODUCTION ONLY. Confirmed namespace races; never imported by product.
const nativeFs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizePdfMeta } = require('../../electron/pdf-meta.cjs');
const { normalizeEpubMeta } = require('../../electron/epub-meta.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const identity = stat => [stat.dev, stat.ino].join(':');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class FileMoves {
  constructor(store, { io = nativeFs, prototypeForTests = false } = {}) { this.store = store; this.io = io; this.prototypeForTests = prototypeForTests; this.operations = new Map(); this.undos = new Map(); }
  capability() { return Promise.resolve({ supported: false, reason: '安全移动后端仍在复核；当前不会移动用户文件' }); }
  async canonical(raw, root) {
    const real = await this.store.checked(raw);
    if (this.store.queueKey(real) !== this.store.queueKey(path.resolve(raw)) || !inside(root, real) || (await this.io.lstat(real)).isSymbolicLink())
      throw new Error('移动位置必须位于当前资料根目录内，且不能经过符号链接或联接');
    return real;
  }
  async snapshot(file) {
    const handle = await this.io.open(file, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !before.ino) throw new Error('当前只支持具有可核验身份的普通文件');
      const digest = crypto.createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      const after = await handle.stat({ bigint: true }), named = await this.io.lstat(file, { bigint: true });
      if (version(before) !== version(after) || version(after) !== version(named) || named.isSymbolicLink()) throw new Error('文件正在被其他程序修改，请刷新后重试');
      return { hash: digest.digest('hex'), version: version(after), identity: identity(after) };
    } finally { await handle.close(); }
  }
  async directory(file, root, create = false) {
    if (!inside(root, file)) throw new Error('辅助资料位置越过根目录');
    if (create) {
      try { await this.io.mkdir(file, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await this.io.lstat(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await this.io.realpath(file) !== file) throw new Error('辅助资料目录不可用或指向其他位置');
    return file;
  }
  async records(source, target, root, digest) {
    const aux = path.join(path.dirname(source), '.reader'), records = []; let total = 0;
    try { await this.directory(aux, root); } catch (error) { if (error.code === 'ENOENT') return records; throw error; }
    const add = async (relative, transform) => {
      const file = path.join(aux, relative), stat = await this.io.lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20n * 1024n * 1024n) throw new Error('辅助资料无法安全读取，未移动文件');
      const raw = await this.io.readFile(file);
      if (version(stat) !== version(await this.io.lstat(file, { bigint: true }))) throw new Error('辅助资料正在改变，请稍后重试');
      total += raw.length; if (total > 40 * 1024 * 1024) throw new Error('待保留的辅助资料超过 40 MB，暂不能自动移动');
      const next = transform ? transform(raw) : raw;
      if (next) records.push({ file, relative, raw, next, version: version(stat) });
    };
    if (/\.(md|markdown)$/i.test(source)) {
      const recovery = path.join(aux, 'recovery');
      try {
        await this.directory(recovery, root);
        for (const name of await this.io.readdir(recovery)) if (uuid.test(name.replace(/\.json$/, '')) && name.endsWith('.json')) {
          await add(path.join('recovery', name), raw => {
            let value; try { value = JSON.parse(raw); } catch { throw new Error('目录中有损坏的恢复稿，无法确认归属，未移动文件'); }
            if (!this.store.validMoveRecovery(value, name.slice(0, -5))) throw new Error('目录中有无法确认归属的恢复稿，未移动文件');
            return this.store.queueKey(path.resolve(value.sourcePath)) === this.store.queueKey(source)
              ? Buffer.from(JSON.stringify({ ...value, sourcePath: target })) : null;
          });
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const history = path.join(aux, 'history'), prefix = hash(Buffer.from(path.basename(source))).slice(0, 16) + '-';
      try { await this.directory(history, root); for (const name of await this.io.readdir(history)) if (name.startsWith(prefix) && /^[a-f0-9]+-\d+\.md$/.test(name)) await add(path.join('history', name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      const epub = /\.epub$/i.test(source), relative = digest + (epub ? '.epub.json' : '.json');
      try { await add(relative, raw => { const value = JSON.parse(raw); if (epub) normalizeEpubMeta(value, digest); else normalizePdfMeta(value, digest); return raw; }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return records;
  }
  async preserveRecords(records, target, root) {
    if (!records.length) return;
    const aux = await this.directory(path.join(path.dirname(target), '.reader'), root, true);
    for (const record of records) {
      if (version(await this.io.lstat(record.file, { bigint: true })) !== record.version || hash(await this.io.readFile(record.file)) !== hash(record.raw))
        throw new Error('辅助资料已被其他程序修改，未移动文件');
      const destination = path.join(aux, record.relative);
      if (path.dirname(destination) !== aux) await this.directory(path.dirname(destination), root, true);
      const temporary = await this.io.mkdtemp(path.join(path.dirname(destination), 'move-metadata-')), staged = path.join(temporary, 'record');
      try {
        const handle = await this.io.open(staged, 'wx', 0o600);
        try { await handle.writeFile(record.next); await handle.sync(); } finally { await handle.close(); }
        try { await this.io.link(staged, destination); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const stat = await this.io.lstat(destination);
          if (!stat.isFile() || stat.isSymbolicLink() || hash(await this.io.readFile(destination)) !== hash(record.next)) throw new Error('目标位置已有不同的恢复稿、历史或阅读标记，未覆盖，也未移动文件');
        }
      } finally { await this.io.unlink(staged).catch(() => {}); await this.io.rmdir(temporary).catch(() => {}); }
    }
  }
  status(id) {
    const operation = this.operations.get(id);
    return operation ? operation.status === 'finished' ? { status: 'finished', result: operation.result }
      : operation.status === 'failed' ? { status: 'failed', error: operation.error } : { status: 'pending' } : { status: 'unknown' };
  }
  move(input) {
    if (!input || !uuid.test(input.operationId)) return Promise.reject(new Error('无效的移动请求标识'));
    const signature = JSON.stringify(input), previous = this.operations.get(input.operationId);
    if (previous) return previous.signature === signature ? previous.promise : Promise.reject(new Error('移动请求标识已用于其他操作'));
    if (this.operations.size >= 128) for (const [id, item] of this.operations) { if (item.status !== 'pending') { this.operations.delete(id); break; } }
    if (this.operations.size >= 128) return Promise.reject(new Error('已有过多未完成移动，已停止新操作'));
    const operation = { signature, status: 'pending' }; this.operations.set(input.operationId, operation);
    operation.promise = this.execute(input).then(result => { operation.status = 'finished'; operation.result = result; return result; }, error => {
      operation.status = 'failed'; operation.error = String(error.message || error); throw error;
    });
    return operation.promise;
  }
  async execute(input) {
    if (!this.prototypeForTests) throw new Error('安全移动后端仍在复核，暂未启用文件写入；当前文件未移动');
    const root = await this.store.checked(input.root);
    if (!this.store.roots.has(root)) throw new Error('请先打开当前资料根目录');
    const source = await this.canonical(input.path, root), directory = await this.canonical(input.directory, root);
    if (!(await this.io.stat(directory)).isDirectory()) throw new Error('目标不是文件夹');
    if (!(await this.io.lstat(source)).isFile() || !/\.(md|markdown|pdf|epub)$/i.test(source)) throw new Error('当前仅支持移动 Markdown、PDF、EPUB 文件；不能移动目录');
    const target = path.join(directory, path.basename(source));
    if (this.store.queueKey(source) === this.store.queueKey(target)) throw new Error('文件已经在这个文件夹中');
    Object.assign(this.operations.get(input.operationId), { root, source, target });
    return this.store.serialized(root, () => this.store.serialized(source, () => this.store.serialized(target, async () => {
      const snapshot = await this.snapshot(source);
      if (input.expectedHash ? !/^[a-f0-9]{64}$/.test(input.expectedHash) || input.expectedHash !== snapshot.hash : !input.expectedVersion || input.expectedVersion !== snapshot.version)
        throw new Error('文件在选择后发生变化，请刷新目录或处理笔记冲突后重试');
      try { await this.io.lstat(target); throw new Error('目标已有同名文件或文件夹，未覆盖'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const records = await this.records(source, target, root, snapshot.hash);
      await this.preserveRecords(records, target, root);
      const stage = await this.io.mkdtemp(path.join(path.dirname(source), '待恢复移动-'));
      const payload = path.join(stage, path.basename(source)), journal = path.join(stage, 'MOVE-RECOVERY.json');
      let destinationProbe, staged = false, committed = false;
      try {
        destinationProbe = await this.io.mkdtemp(path.join(directory, '待恢复移动-'));
        const probe = path.join(stage, 'probe'); await this.io.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
        await this.io.link(probe, path.join(destinationProbe, 'probe')); // Fail before touching the source on unsupported/cross-device filesystems.
        await this.io.unlink(path.join(destinationProbe, 'probe')); await this.io.rmdir(destinationProbe); destinationProbe = null; await this.io.unlink(probe);
        const handle = await this.io.open(journal, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, root, source, target, hash: snapshot.hash, identity: snapshot.identity, operationId: input.operationId })); await handle.sync(); } finally { await handle.close(); }
        await this.canonical(path.dirname(source), root); await this.canonical(directory, root);
        if ((await this.snapshot(source)).version !== snapshot.version) throw new Error('文件在移动前发生变化，未移动');
        await this.io.rename(source, payload); staged = true;
        const actual = await this.snapshot(payload);
        if (actual.identity !== snapshot.identity || actual.hash !== snapshot.hash) throw new Error('移动时检测到外部替换或修改，正在保留原位');
        await this.canonical(directory, root);
        await this.io.link(payload, target); committed = true; // Atomic no-replace commit; never rename over a user destination.
      } catch (error) {
        if (staged && !committed) {
          try { await this.io.link(payload, source); }
          catch (rollback) { return { ok: false, operationId: input.operationId, oldPath: source, recoveryPath: payload,
            error: `移动未完成，原内容保留在“${payload}”。原位置无法安全恢复，已停止后续移动：${error.message}；${rollback.message}` }; }
          try { await this.io.unlink(payload); staged = false; } catch { /* Original path restored; retain the extra recovery link. */ }
        }
        throw new Error(`文件未移动或已恢复原位：${error.message}。已复制的辅助资料会保留，不删除原记录。`);
      } finally {
        if (destinationProbe) { await this.io.unlink(path.join(destinationProbe, 'probe')).catch(() => {}); await this.io.rmdir(destinationProbe).catch(() => {}); }
        if (!staged) { await this.io.unlink(path.join(stage, 'probe')).catch(() => {}); await this.io.unlink(journal).catch(() => {}); await this.io.rmdir(stage).catch(() => {}); }
      }
      const published = await this.io.lstat(target, { bigint: true }).catch(() => null);
      if (!published || published.isSymbolicLink() || identity(published) !== snapshot.identity)
        return { ok: false, operationId: input.operationId, oldPath: source, recoveryPath: payload,
          error: `目标在提交后又发生变化，原内容仍保留在“${payload}”；已停止后续移动，请核对两个位置。` };
      let warning = '';
      try { await this.io.unlink(payload); await this.io.unlink(journal); await this.io.rmdir(stage); }
      catch { warning = `文件已移动；临时保留区未能完全清理：${stage}。请核对后手动处理。`; }
      const current = await this.io.lstat(target, { bigint: true }).catch(() => null);
      const token = crypto.randomUUID();
      this.undos.set(token, { root, from: source, to: target, version: current ? version(current) : '', expires: Date.now() + 10 * 60_000 });
      for (const [id, receipt] of this.undos) if (receipt.expires < Date.now() || this.undos.size > 32) this.undos.delete(id);
      this.store.files.delete(source); this.store.files.add(target);
      return { ok: true, operationId: input.operationId, oldPath: source, entry: { path: target, name: path.basename(target), relative: path.relative(root, target), kind: 'file',
        type: /\.pdf$/i.test(target) ? 'pdf' : /\.epub$/i.test(target) ? 'epub' : 'md', moveVersion: current ? version(current) : '' }, undoToken: token, warning };
    })));
  }
  undo(input) {
    const receipt = this.undos.get(input.token);
    if (!receipt || receipt.expires < Date.now()) {
      const error = new Error('撤销凭据已失效，请通过“移动到”重新选择位置');
      if (uuid.test(input.operationId) && !this.operations.has(input.operationId)) this.operations.set(input.operationId, { status: 'failed', error: error.message });
      return Promise.reject(error);
    }
    return this.move({ operationId: input.operationId, root: receipt.root, path: receipt.to, directory: path.dirname(receipt.from), expectedVersion: receipt.version, expectedHash: input.expectedHash }).then(result => {
      if (result.ok) this.undos.delete(input.token); return result;
    });
  }
  async recover(operationId) {
    const operation = this.operations.get(operationId), result = operation?.result;
    if (operation?.status !== 'finished' || !result || result.ok || !result.recoveryPath) throw new Error('没有可确认的暂存恢复操作，请先核对移动结果');
    const directory = path.dirname(result.recoveryPath); await this.canonical(directory, operation.root);
    const record = path.join(directory, 'MOVE-RECOVERY.json'), recordStat = await this.io.lstat(record);
    if (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.size > 16 * 1024) throw new Error('暂存恢复记录不可用');
    const journal = JSON.parse(await this.io.readFile(record, 'utf8'));
    if (journal.operationId !== operationId || journal.source !== result.oldPath || journal.root !== operation.root || journal.target !== operation.target || !this.store.roots.has(journal.root) || !inside(journal.root, directory)) throw new Error('暂存恢复身份不匹配，未操作');
    await this.canonical(result.recoveryPath, journal.root); await this.canonical(path.dirname(result.oldPath), journal.root);
    const snapshot = await this.snapshot(result.recoveryPath);
    await this.io.link(result.recoveryPath, result.oldPath); // Never replace a newer file at the original name.
    const stat = await this.io.lstat(result.oldPath, { bigint: true });
    if (identity(stat) !== snapshot.identity) throw new Error('恢复后原位置又发生变化，暂存内容继续保留');
    operation.result = { ok: true, restored: true, operationId, oldPath: result.oldPath, entry: { path: result.oldPath, name: path.basename(result.oldPath),
      relative: path.relative(journal.root, result.oldPath), kind: 'file', type: /\.pdf$/i.test(result.oldPath) ? 'pdf' : /\.epub$/i.test(result.oldPath) ? 'epub' : 'md', moveVersion: version(stat) },
      undoToken: '', warning: `已恢复原位置，暂存记录仍保留在 ${directory}，请核对后手动处理。` };
    this.store.files.add(result.oldPath); return operation.result;
  }
}
module.exports = { FileMoves, fileMoveVersion: version };
