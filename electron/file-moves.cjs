const nativeFs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MoveJournal } = require('./move-journal.cjs');
const { NativeFileMover } = require('./native-file-mover.cjs');
const { normalizePdfMeta } = require('./pdf-meta.cjs');
const { normalizeEpubMeta } = require('./epub-meta.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const identity = stat => [stat.dev, stat.ino].join(':');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class FileMoves {
  constructor(store, { io = nativeFs, native = new NativeFileMover(), journal = new MoveJournal(null), onFinalize = async () => {}, onPrepare = async () => {} } = {}) {
    this.store = store; this.io = io; this.native = native; this.journal = journal; this.onFinalize = onFinalize; this.onPrepare = onPrepare;
    this.operations = new Map(); this.undos = new Map(); this.outcomes = new Map(); this.rechecks = new Map(); this.finalizing = new Map();
  }
  async capability() {
    await this.journal.load();
    if (this.journal.problem || this.journal.hasPending) return { supported: false, reason: this.journal.problem || '上一轮持久移动事务尚未确认，已停止新移动。' };
    return this.native.capability();
  }
  // Established synchronously by move(), before any await. onPrepare.flush() then
  // drains every settings write admitted before this gate was established.
  get sessionLocked() {
    return Boolean(this.journal.problem || this.journal.hasPending || [...this.operations.values()].some(item => item.status === 'pending' || item.status === 'unknown'));
  }
  assertAccess(file, options) { return this.journal.assertAccess(file, options); }
  async canonical(raw, root, inspect = false) {
    const real = await this.store.checked(raw, { inspect });
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
  async directory(file, root) {
    if (!inside(root, file)) throw new Error('辅助资料位置越过根目录');
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
  pendingIntents() { return this.journal.pendingEntries().map(entry => entry.intent || entry); }
  receiptFields(intent) {
    return { OperationId: intent.operationId, ReceiptNonce: intent.nonce, RequestBinding: intent.binding,
      ReceiptPath: intent.receiptPath, ReceiptIdentity: intent.receiptIdentity, ReceiptDirectoryIdentity: intent.receiptDirectoryIdentity };
  }
  publicResult(intent, native, recovered = false) {
    const old = this.operations.get(intent.operationId)?.result;
    if (old) return old;
    const { root, source, target, expectedHash } = intent.plan, token = crypto.randomUUID();
    this.undos.set(token, { root, from: source, to: target, identity: native.identity, hash: expectedHash, expires: Date.now() + 10 * 60_000 });
    this.store.files.delete(source); this.store.files.add(target);
    return { ok: true, operationId: intent.operationId, oldPath: source, entry: { path: target, name: path.basename(target), relative: path.relative(root, target), kind: 'file',
      type: /\.pdf$/i.test(target) ? 'pdf' : /\.epub$/i.test(target) ? 'epub' : 'md' }, undoToken: token, recovered, warning: native.warning || '' };
  }
  async verifyOutcome(intent, result) {
    const plan = intent.plan, root = await this.store.checked(plan.root, { inspect: true });
    if (!this.store.roots.has(root) || identity(await this.io.lstat(root, { bigint: true })) !== plan.rootIdentity) throw new Error('移动根目录身份已变化');
    if (!['moved', 'failed'].includes(result?.status)) throw new Error('没有可确认的移动终态');
    if (result.status === 'moved' && (typeof result.identity !== 'string' || !/^\d+:\d+$/.test(result.identity) || result.identity.split(':')[0] !== plan.expectedIdentity.split(':')[0] || result.hash !== plan.expectedHash)) throw new Error('移动回执身份不匹配');
    const file = await this.canonical(result.status === 'moved' ? plan.target : plan.source, root, true), snapshot = await this.snapshot(file);
    // exFAT may change its file ID during a rename. The trusted worker binds
    // the original ID before moving and reports the same handle's final ID.
    const expectedIdentity = result.status === 'moved' ? result.identity : plan.expectedIdentity;
    if (snapshot.identity !== expectedIdentity || snapshot.hash !== plan.expectedHash) throw new Error('当前位置或内容已变化，保持保护');
    if (result.status === 'moved') for (const record of plan.records) {
      const target = path.join(path.dirname(plan.target), '.reader', ...record.relative.split(/[\\/]/));
      await this.canonical(target, root, true);
      if ((await this.snapshot(target)).hash !== record.nextHash) throw new Error('目标辅助记录无法确认，保持保护');
    }
  }
  async reconcile(id) {
    if (this.rechecks.has(id)) return this.rechecks.get(id);
    const task = (async () => {
      await this.journal.load();
      const early = this.operations.get(id);
      if (early?.status === 'failed' && !this.pendingIntents().some(intent => intent.operationId === id)) return { status: 'failed', error: early.error };
      if (this.journal.problem) return { status: 'unknown' };
      const persisted = await this.journal.status(id);
      if (persisted.status === 'failed') return { status: 'failed', error: '已确认正文未移动。' };
      if (persisted.status === 'moved' || persisted.status === 'finished') {
        const entry = persisted.intent || this.pendingIntents().find(item => item.operationId === id);
        if (entry) return { status: 'finished', result: this.publicResult(entry, persisted.result, true) };
        return this.operations.get(id)?.result ? { status: 'finished', result: this.operations.get(id).result } : { status: 'unknown' };
      }
      const intent = this.pendingIntents().find(item => item.operationId === id);
      if (!intent) {
        const local = this.operations.get(id);
        return local?.status === 'failed' ? { status: 'failed', error: local.error } : { status: local?.status === 'pending' ? 'pending' : 'unknown' };
      }
      if (this.native.active) return { status: 'pending' };
      let result;
      try {
        result = await this.native.readReceipt(this.receiptFields(intent));
        await this.verifyOutcome(intent, result);
        if (result.status === 'failed') {
          await this.journal.complete(id, { kind: 'failed', result });
          this.operations.set(id, { ...this.operations.get(id), status: 'failed', error: '已确认正文未移动。' });
          return { status: 'failed', error: '已确认正文未移动；原始辅助记录保留。' };
        }
      } catch { return { status: 'unknown' }; }
      this.outcomes.set(id, { intent, native: result });
      const response = this.publicResult(intent, result, !this.operations.has(id) || this.operations.get(id).status === 'unknown');
      this.operations.set(id, { ...this.operations.get(id), status: 'finished', result: response });
      return { status: 'finished', result: response };
    })();
    this.rechecks.set(id, task);
    try { return await task; } finally { this.rechecks.delete(id); }
  }
  status(id) { return this.reconcile(id); }
  async pendingIssue() {
    await this.journal.load();
    if (this.journal.problem) return { operationId: 'unreadable-move-journal', oldPath: this.journal.directory || '', message: '移动事务日志无法完整核验，文件读写及新移动已停止。请保留日志并先核对；不会自动删除或重置日志。' };
    const intent = this.pendingIntents()[0];
    return intent ? { operationId: intent.operationId, oldPath: intent.plan.source, targetPath: intent.plan.target,
      message: '有尚未确认的持久移动事务。原位置和目标位置保持保护；重新核对只读取本次工作程序回执并核验文件，不会重试移动或覆盖内容。' } : null;
  }
  finalize(id) {
    if (this.finalizing.has(id)) return this.finalizing.get(id);
    const task = this.finalizeOne(id).finally(() => this.finalizing.delete(id)); this.finalizing.set(id, task); return task;
  }
  async finalizeOne(id) {
    const state = await this.reconcile(id);
    if (state.status === 'failed') return true;
    if (state.status !== 'finished') throw new Error('移动结果尚未确认，继续保持闭锁');
    if (!this.pendingIntents().some(intent => intent.operationId === id)) return true;
    const outcome = this.outcomes.get(id);
    if (!outcome) throw new Error('缺少持久移动回执，继续保持闭锁');
    await this.verifyOutcome(outcome.intent, outcome.native);
    await this.onFinalize(state.result, outcome.intent);
    await this.verifyOutcome(outcome.intent, outcome.native);
    await this.journal.complete(id, { kind: 'moved', result: outcome.native });
    return true;
  }
  async resumeKnown() {
    await this.journal.load();
    if (this.journal.problem) return;
    for (const intent of this.pendingIntents()) {
      const status = await this.reconcile(intent.operationId);
      if (status.status === 'finished') try { await this.finalize(intent.operationId); } catch { /* Preserve journal and guards if settings/receipt cannot be committed. */ }
    }
  }
  move(input) {
    if (!input || !uuid.test(input.operationId)) return Promise.reject(new Error('无效的移动请求标识'));
    const signature = JSON.stringify(input), previous = this.operations.get(input.operationId);
    if (previous) return previous.signature === signature && previous.promise ? previous.promise : Promise.reject(new Error('移动请求标识已用于其他操作'));
    if ([...this.operations.values()].some(item => item.status === 'pending' || item.status === 'unknown')) return Promise.reject(new Error('上一轮移动结果尚未确认，已阻止新操作'));
    const operation = { signature, status: 'pending' }; this.operations.set(input.operationId, operation);
    operation.promise = this.execute(input).then(result => { operation.status = 'finished'; operation.result = result; return result; }, error => {
      operation.status = error.code === 'MOVE_UNCERTAIN' ? 'unknown' : 'failed'; operation.error = String(error.message || error); throw error;
    });
    return operation.promise;
  }
  async execute(input) {
    const capability = await this.capability(); if (!capability.supported) throw new Error(capability.reason || '当前环境未通过安全移动前置检查');
    const root = await this.store.checked(input.root); if (!this.store.roots.has(root) || !this.store.rootIdentities.get(root)) throw new Error('请先打开当前资料根目录');
    if (path.parse(root).root === root) throw new Error('请先打开资料所在的具体文件夹；暂不支持从卷根目录移动文件。');
    const source = await this.canonical(input.path, root), directory = await this.canonical(input.directory, root);
    if (!(await this.io.stat(directory)).isDirectory()) throw new Error('目标不是文件夹');
    if (!(await this.io.lstat(source)).isFile() || !/\.(md|markdown|pdf|epub)$/i.test(source)) throw new Error('当前仅支持移动 Markdown、PDF、EPUB 文件；不能移动目录');
    const target = path.join(directory, path.basename(source)); if (this.store.queueKey(source) === this.store.queueKey(target)) throw new Error('文件已经在这个文件夹中');
    return this.store.entryMutation(() => this.store.serialized(root, () => this.store.serialized(source, () => this.store.serialized(target, async () => {
      await this.canonical(source, root); await this.canonical(directory, root);
      if (!this.store.roots.has(root)) throw new Error('资料根目录已变化，文件未移动');
      const snapshot = await this.snapshot(source);
      if (input.expectedHash ? !/^[a-f0-9]{64}$/.test(input.expectedHash) || input.expectedHash !== snapshot.hash : !input.expectedVersion || input.expectedVersion !== snapshot.version) throw new Error('文件在选择后发生变化，请刷新目录或处理笔记冲突后重试');
      if (input.expectedIdentity && input.expectedIdentity !== snapshot.identity) throw new Error('原移动文件已被其他程序替换，不能撤销其他文件');
      try { await this.io.lstat(target); throw new Error('目标已有同名文件或文件夹，未覆盖'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const records = await this.records(source, target, root, snapshot.hash);
      const plan = { operationId: input.operationId, root, source, target, rootIdentity: this.store.rootIdentities.get(root), expectedIdentity: snapshot.identity, expectedHash: snapshot.hash,
        records: records.map(record => ({ source: record.file, relative: record.relative.replaceAll('\\', '/'), rawHash: hash(record.raw), nextHash: hash(record.next) })) };
      const sessionState = await this.onPrepare(plan);
      if (sessionState) plan.sessionState = sessionState;
      let intent;
      try {
        const prepared = await this.journal.prepare(plan);
        intent = prepared?.plan ? prepared : this.pendingIntents().find(item => item.operationId === input.operationId);
        if (!intent) throw new Error('移动意图尚未持久记录');
      } catch (error) {
        if (this.journal.problem || this.journal.hasPending) error.code = 'MOVE_UNCERTAIN';
        throw error;
      }
      try { await this.native.move({ Root: root, RootIdentity: plan.rootIdentity, Source: source, Target: target, ExpectedIdentity: snapshot.identity, ExpectedHash: snapshot.hash,
        Records: records.map(record => ({ Source: record.file, Relative: record.relative.replaceAll('/', '\\'), RawHash: hash(record.raw), NextBase64: record.next.toString('base64') })), ...this.receiptFields(intent) }); }
      catch { /* A lost transport can still have a durable terminal receipt. */ }
      const state = await this.reconcile(input.operationId);
      if (state.status === 'finished') return state.result;
      const error = new Error(state.status === 'failed' ? state.error : '移动结果尚未确认，持久闭锁已保留；不会自动重试。');
      if (state.status !== 'failed') error.code = 'MOVE_UNCERTAIN'; throw error;
    }))));
  }
  undo(input) {
    const receipt = this.undos.get(input.token);
    if (!receipt || receipt.expires < Date.now()) {
      const error = new Error('撤销凭据已失效，请通过“移动到”重新选择位置');
      if (uuid.test(input.operationId) && !this.operations.has(input.operationId)) this.operations.set(input.operationId, { status: 'failed', error: error.message });
      return Promise.reject(error);
    }
    return this.move({ operationId: input.operationId, root: receipt.root, path: receipt.to, directory: path.dirname(receipt.from), expectedIdentity: receipt.identity, expectedHash: input.expectedHash || receipt.hash }).then(result => {
      if (result.ok) this.undos.delete(input.token); return result;
    });
  }
  recover() { return Promise.reject(new Error('未知结果保持持久闭锁；请保留原位置、目标位置及日志，不自动回滚或覆盖正文。')); }
}
module.exports = { FileMoves, fileMoveVersion: version };
