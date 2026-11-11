'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64 = /^[a-f0-9]{64}$/i;
const IDENTITY = /^\d+:\d+$/;
const RECEIPT_BUSY_CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'ELOCKED', 'ESHARE']);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RECORDS = 512;
const NAMESPACE_POLICIES = new Set([
  'process-crash-only-with-directory-fsync',
  'process-crash-only-no-directory-flush',
]);
const PLAN_KEYS = ['operationId', 'root', 'source', 'target', 'rootIdentity', 'expectedIdentity', 'expectedHash', 'records'];
const RECORD_KEYS = ['source', 'relative', 'rawHash', 'nextHash'];

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function identity(stat) { return `${String(stat.dev)}:${String(stat.ino)}`; }
function fingerprint(stat) { return [identity(stat), String(stat.size), String(stat.mtimeNs ?? stat.mtimeMs), String(stat.ctimeNs ?? stat.ctimeMs)].join(':'); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableJson(value) { return JSON.stringify(value); }
function isMissing(error) { return error?.code === 'ENOENT'; }
function samePath(a, b) {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}
function isSameOrAncestor(ancestor, candidate) {
  const relative = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function hasExactKeys(value, keys) { return exactKeys(value, keys); }

function normalizePlan(input) {
  if (!exactKeys(input, [...PLAN_KEYS, ...(Object.hasOwn(input || {}, 'sessionState') ? ['sessionState'] : [])])) throw new Error('移动意图字段不完整或包含未允许字段');
  if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)) throw new Error('移动意图 operationId 无效');
  for (const key of ['root', 'source', 'target']) {
    if (typeof input[key] !== 'string' || !path.isAbsolute(input[key]) || input[key].includes('\0')) throw new Error(`移动意图 ${key} 必须是绝对路径`);
    if (!samePath(input[key], path.resolve(input[key]))) throw new Error(`移动意图 ${key} 不是规范路径`);
  }
  const root = path.resolve(input.root), source = path.resolve(input.source), target = path.resolve(input.target);
  if (!isSameOrAncestor(root, source) || !isSameOrAncestor(root, target) || samePath(source, target)) throw new Error('移动意图路径越过资料根目录或源目标相同');
  if (path.basename(source) !== path.basename(target)) throw new Error('移动意图必须保留文件名');
  if (!IDENTITY.test(input.rootIdentity) || !IDENTITY.test(input.expectedIdentity) || !HEX_64.test(input.expectedHash)) throw new Error('移动意图身份或正文摘要无效');
  if (!Array.isArray(input.records) || input.records.length > MAX_RECORDS) throw new Error('移动意图 records 无效或过多');
  if (input.sessionState !== undefined && (!exactKeys(input.sessionState, ['beforeHash', 'afterHash'])
    || !HEX_64.test(input.sessionState.beforeHash) || !HEX_64.test(input.sessionState.afterHash))) throw new Error('移动会话摘要无效');
  const seen = new Set();
  const records = input.records.map((record, index) => {
    if (!exactKeys(record, RECORD_KEYS)) throw new Error(`移动意图 records[${index}] 字段无效`);
    if (typeof record.source !== 'string' || !path.isAbsolute(record.source) || record.source.includes('\0')) throw new Error(`移动意图 records[${index}].source 必须是绝对路径`);
    if (typeof record.relative !== 'string' || !record.relative || record.relative.includes('\0') || path.isAbsolute(record.relative) || /^[a-z]:/i.test(record.relative)) throw new Error(`移动意图 records[${index}].relative 无效`);
    const pieces = record.relative.replaceAll('\\', '/').split('/');
    if (pieces.some(piece => !piece || piece === '.' || piece === '..' || piece.includes(':'))) throw new Error(`移动意图 records[${index}].relative 越界`);
    if (!HEX_64.test(record.rawHash) || !HEX_64.test(record.nextHash)) throw new Error(`移动意图 records[${index}] 摘要无效`);
    const normalizedRelative = pieces.join(path.sep);
    const expectedSource = path.resolve(path.dirname(source), '.reader', normalizedRelative);
    const recordSource = path.resolve(record.source);
    if (!samePath(recordSource, expectedSource) || !isSameOrAncestor(root, recordSource)) throw new Error(`移动意图 records[${index}] 不属于源文件辅助目录`);
    const key = process.platform === 'win32' ? recordSource.toLocaleLowerCase('en-US') : recordSource;
    if (seen.has(key)) throw new Error('移动意图包含重复辅助记录');
    seen.add(key);
    return { source: recordSource, relative: pieces.join('/'), rawHash: record.rawHash.toLowerCase(), nextHash: record.nextHash.toLowerCase() };
  });
  return {
    operationId: input.operationId.toLowerCase(), root, source, target,
    rootIdentity: input.rootIdentity, expectedIdentity: input.expectedIdentity,
    expectedHash: input.expectedHash.toLowerCase(), records,
    ...(input.sessionState ? { sessionState: { beforeHash: input.sessionState.beforeHash.toLowerCase(), afterHash: input.sessionState.afterHash.toLowerCase() } } : {}),
  };
}

function safeError(error) { return error?.message || String(error); }

class MoveJournal {
  constructor(directory, { io = fs, platform = process.platform } = {}) {
    this.directory = typeof directory === 'string' && directory.trim() ? path.resolve(directory) : null;
    this.io = io;
    this.platform = platform;
    this.problem = this.directory ? null : '移动日志目录未配置';
    this.loaded = false;
    this.loading = null;
    this.preparing = false;
    this.preparingPlan = null;
    this.preparingPromise = null;
    this.entries = new Map();
  }

  get hasPending() { return Boolean(this.preparingPlan) || [...this.entries.values()].some(entry => entry.status === 'pending'); }
  get blocked() { return Boolean(this.problem) || this.hasPending; }

  _fail(message) {
    if (!this.problem) this.problem = message;
    return new Error(this.problem);
  }

  _snapshot() {
    return { problem: this.problem, hasPending: this.hasPending, pending: this.pendingEntries() };
  }

  pendingEntries() {
    return [...this.entries.values()].filter(entry => entry.status === 'pending').map(entry => ({
      operationId: entry.intent.operationId,
      intent: structuredClone(entry.intent),
      status: 'pending',
    }));
  }

  load() {
    if (this.loaded) return Promise.resolve(this._snapshot());
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (this.directory) {
        try {
          const exists = await this._validateDirectoryPath(false);
          if (exists) {
            const entries = await this.io.readdir(this.directory, { withFileTypes: true });
            for (const item of entries) {
              if (!item.isDirectory() || item.isSymbolicLink() || !OPERATION_ID.test(item.name) || item.name !== item.name.toLowerCase()) throw new Error(`日志根目录含非法项目：${item.name}`);
              const opDir = path.join(this.directory, item.name);
              const loaded = await this._loadOperation(item.name.toLowerCase(), opDir);
              this.entries.set(loaded.intent.operationId, loaded);
            }
            const pending = [...this.entries.values()].filter(entry => entry.status === 'pending');
            if (pending.length > 1) throw new Error('日志含多个未决移动，无法确定安全状态');
          }
        } catch (error) {
          this._fail(`移动日志无法安全读取：${safeError(error)}`);
        }
      }
      this.loaded = true;
      return this._snapshot();
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async _validateDirectoryPath(create) {
    if (!this.directory) throw new Error('移动日志目录未配置');
    const missing = [];
    let cursor = this.directory;
    let stat;
    while (true) {
      try { stat = await this.io.lstat(cursor); break; }
      catch (error) {
        if (!isMissing(error)) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw new Error('移动日志目录没有可验证的现存祖先');
        missing.push(cursor); cursor = parent;
      }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('移动日志路径祖先不是普通目录');
    const real = await this.io.realpath(cursor);
    if (!samePath(real, cursor)) throw new Error('移动日志路径含符号链接或非规范目录');
    if (!missing.length) {
      const canonical = await this.io.realpath(this.directory);
      if (!samePath(canonical, this.directory)) throw new Error('移动日志目录不是规范路径');
      return true;
    }
    if (!create) return false;
    for (const next of missing.reverse()) {
      try { await this.io.mkdir(next); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      const nextStat = await this.io.lstat(next);
      if (!nextStat.isDirectory() || nextStat.isSymbolicLink() || !samePath(await this.io.realpath(next), next)) throw new Error('创建移动日志目录时发现非规范目录');
      await this._syncDirectory(path.dirname(next));
      cursor = next;
    }
    return true;
  }

  async _syncDirectory(directory) {
    // Node/libuv does not promise directory FlushFileBuffers support on Windows.
    // File records remain individually synced; the journal's guarantee is process-crash
    // recovery, not recovery after OS/power loss.
    if (this.platform === 'win32') return false;
    const handle = await this.io.open(directory, 'r');
    let failure;
    try { await handle.sync(); } catch (error) { failure = error; }
    try { await handle.close(); } catch (error) { if (!failure) failure = error; }
    if (failure) throw failure;
  }

  async _readBounded(file, expectedIdentity = null) {
    const before = await this.io.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`日志文件不是普通文件：${path.basename(file)}`);
    if (expectedIdentity && identity(before) !== expectedIdentity) throw new Error(`日志文件身份改变：${path.basename(file)}`);
    if (Number(before.size) > MAX_JSON_BYTES) throw new Error(`日志 JSON 超过 ${MAX_JSON_BYTES} 字节：${path.basename(file)}`);
    if (!samePath(await this.io.realpath(file), file)) throw new Error(`日志文件路径非规范或为符号链接：${path.basename(file)}`);
    const handle = await this.io.open(file, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || identity(opened) !== identity(before)) throw new Error(`日志文件在读取前被替换：${path.basename(file)}`);
      const data = await handle.readFile();
      if (data.length > MAX_JSON_BYTES) throw new Error(`日志 JSON 超过 ${MAX_JSON_BYTES} 字节：${path.basename(file)}`);
      const after = await handle.stat({ bigint: true });
      const named = await this.io.lstat(file, { bigint: true });
      if (fingerprint(before) !== fingerprint(after) || identity(after) !== identity(named)) throw new Error(`日志文件在读取时发生变化：${path.basename(file)}`);
      return data;
    } finally { await handle.close(); }
  }

  async _writeExclusive(file, data) {
    const handle = await this.io.open(file, 'wx', 0o600);
    let primary;
    try {
      if (data.length) await handle.writeFile(data);
      await handle.sync();
      return identity(await handle.stat({ bigint: true }));
    } catch (error) { primary = error; throw error; }
    finally {
      try { await handle.close(); }
      catch (error) { if (!primary) throw error; }
    }
  }

  async _parseJson(file, expectedIdentity = null, allowEmpty = false) {
    const bytes = await this._readBounded(file, expectedIdentity);
    if (!bytes.length && allowEmpty) return null;
    if (!bytes.length) throw new Error(`日志 JSON 为空：${path.basename(file)}`);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`日志 JSON 损坏：${path.basename(file)}`); }
  }

  _validateIntent(intent, operationId, opDir, opDirIdentity) {
    const keys = ['schema', 'operationId', 'nonce', 'binding', 'plan', 'receiptPath', 'receiptIdentity', 'receiptDirectoryIdentity', 'preparedAt', 'namespacePolicy'];
    if (!exactKeys(intent, keys) || intent.schema !== 1 || intent.operationId !== operationId || !/^[a-f0-9]{64}$/.test(intent.nonce || '') || !/^[a-f0-9]{64}$/.test(intent.binding || '')) throw new Error('移动 intent schema 或字段无效');
    const plan = normalizePlan(intent.plan);
    if (plan.operationId !== operationId) throw new Error('移动 intent operationId 与 plan 不一致');
    const expectedBinding = hash(stableJson({ schema: 2, operationId, nonce: intent.nonce, plan }));
    if (intent.binding !== expectedBinding) throw new Error('移动 intent binding 校验失败');
    if (!samePath(intent.receiptPath, path.join(opDir, 'receipt.json')) || !IDENTITY.test(intent.receiptIdentity || '')
      || intent.receiptDirectoryIdentity !== opDirIdentity) throw new Error('移动 receipt 路径或目录身份不匹配');
    if (typeof intent.preparedAt !== 'string' || !Number.isFinite(Date.parse(intent.preparedAt))) throw new Error('移动 intent 时间无效');
    if (!NAMESPACE_POLICIES.has(intent.namespacePolicy)) throw new Error('移动 intent namespace policy 无效');
    return { ...intent, plan };
  }

  _validateReceipt(envelope, intent) {
    if (!exactKeys(envelope, ['schema', 'operationId', 'nonce', 'binding', 'result']) || envelope.schema !== 2
      || envelope.operationId !== intent.operationId || envelope.nonce !== intent.nonce || envelope.binding !== intent.binding
      || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new Error('worker receipt envelope 无效');
    const allowedResultKeys = ['status', 'identity', 'hash', 'error', 'warning'];
    if (Object.keys(envelope.result).some(key => !allowedResultKeys.includes(key)) || !['moved', 'failed', 'uncertain'].includes(envelope.result.status)) throw new Error('worker receipt status 或 result 字段无效');
    for (const key of ['error', 'warning']) if (envelope.result[key] !== undefined && (typeof envelope.result[key] !== 'string' || envelope.result[key].length > 1024)) throw new Error(`worker receipt ${key} 无效`);
    if (envelope.result.status === 'moved' && (typeof envelope.result.identity !== 'string' || !IDENTITY.test(envelope.result.identity)
      || envelope.result.identity.split(':')[0] !== intent.plan.expectedIdentity.split(':')[0] || envelope.result.hash !== intent.plan.expectedHash)) throw new Error('worker moved receipt 身份或摘要不匹配');
    if (envelope.result.status !== 'moved' && (envelope.result.identity !== undefined || envelope.result.hash !== undefined)) throw new Error('非 moved receipt 不得携带文件身份');
    return envelope;
  }

  _terminalSummary(kind, envelope) {
    const summary = { status: kind };
    if (kind === 'moved') {
      summary.identity = envelope.result.identity;
      summary.hash = envelope.result.hash;
    }
    return summary;
  }

  async _loadOperation(operationId, opDir) {
    const dirStat = await this.io.lstat(opDir, { bigint: true });
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !samePath(await this.io.realpath(opDir), opDir)) throw new Error(`移动 op 目录不规范：${operationId}`);
    const children = (await this.io.readdir(opDir)).sort();
    const expected = ['intent.json', 'receipt.json'];
    const hasFinished = children.includes('FINISHED.json');
    if (hasFinished) expected.push('FINISHED.json');
    expected.sort();
    if (children.length !== expected.length || children.some((name, index) => name !== expected[index])) throw new Error(`移动 op 目录不完整或含未识别文件：${operationId}`);
    const receiptPath = path.join(opDir, 'receipt.json');
    const intentValue = await this._parseJson(path.join(opDir, 'intent.json'));
    const intent = this._validateIntent(intentValue, operationId, opDir, identity(dirStat));
    let receiptStat;
    try { receiptStat = await this.io.lstat(receiptPath, { bigint: true }); }
    catch (error) {
      if (!hasFinished && RECEIPT_BUSY_CODES.has(error?.code)) return { intent, status: 'pending', envelope: null, receiptBusy: true };
      throw error;
    }
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) throw new Error(`receipt 不是普通文件：${operationId}`);
    if (identity(receiptStat) !== intent.receiptIdentity) throw new Error(`receipt 身份不匹配：${operationId}`);
    if (!hasFinished) return { intent, status: 'pending', envelope: null };
    const receiptBytes = await this._readBounded(receiptPath, intent.receiptIdentity);
    let envelope = null;
    if (receiptBytes.length) {
      try { envelope = this._validateReceipt(JSON.parse(receiptBytes.toString('utf8')), intent); }
      catch (error) { throw new Error(`worker receipt 无效：${safeError(error)}`); }
    }
    if (!envelope || !['moved', 'failed'].includes(envelope.result.status)) throw new Error(`FINISHED 缺少合法终态 receipt：${operationId}`);
    const finished = await this._parseJson(path.join(opDir, 'FINISHED.json'));
    if (!exactKeys(finished, ['schema', 'operationId', 'binding', 'kind', 'finishedAt', 'receiptHash', 'result'])
      || finished.schema !== 1 || finished.operationId !== operationId || finished.binding !== intent.binding
      || finished.kind !== envelope.result.status || !['moved', 'failed'].includes(finished.kind)
      || finished.receiptHash !== hash(receiptBytes) || !Number.isFinite(Date.parse(finished.finishedAt))
      || stableJson(finished.result) !== stableJson(this._terminalSummary(finished.kind, envelope))) throw new Error(`FINISHED 与 receipt 不一致：${operationId}`);
    return { intent, status: finished.kind, result: finished.result, envelope };
  }

  prepare(planInput) {
    if (this.preparing) return Promise.reject(new Error('移动日志正在预留另一项操作'));
    let plan;
    try { plan = normalizePlan(planInput); }
    catch (error) { return Promise.reject(error); }
    this.preparing = true;
    this.preparingPlan = plan;
    const operation = this._prepare(plan);
    this.preparingPromise = operation;
    return operation.finally(() => { this.preparing = false; this.preparingPlan = null; this.preparingPromise = null; });
  }

  async _prepare(plan) {
    if (!this.loaded) await this.load();
    if (this.problem) throw this._fail(`移动日志闭锁：${this.problem}`);
    if (this.entries.has(plan.operationId)) throw new Error('operationId 已在移动日志中使用');
    if ([...this.entries.values()].some(entry => entry.status === 'pending')) throw new Error('上一轮移动仍未确认，已阻止新操作');
    const opDir = path.join(this.directory, plan.operationId);
    let created = false;
    try {
      await this._validateDirectoryPath(true);
      await this.io.mkdir(opDir);
      created = true;
      const opDirStat = await this.io.lstat(opDir, { bigint: true });
      if (!opDirStat.isDirectory() || opDirStat.isSymbolicLink() || !samePath(await this.io.realpath(opDir), opDir)) throw new Error('新建移动 op 目录身份不安全');
      await this._syncDirectory(this.directory);
      const receiptPath = path.join(opDir, 'receipt.json');
      const receiptIdentity = await this._writeExclusive(receiptPath, Buffer.alloc(0));
      const receiptStat = await this.io.lstat(receiptPath, { bigint: true });
      if (identity(receiptStat) !== receiptIdentity || !receiptStat.isFile() || receiptStat.isSymbolicLink()) throw new Error('预创建 receipt 身份不稳定');
      const nonce = crypto.randomBytes(32).toString('hex');
      const binding = hash(stableJson({ schema: 2, operationId: plan.operationId, nonce, plan }));
      const intent = {
        schema: 1, operationId: plan.operationId, nonce, binding, plan,
        receiptPath, receiptIdentity, receiptDirectoryIdentity: identity(opDirStat), preparedAt: new Date().toISOString(),
        namespacePolicy: this.platform === 'win32'
          ? 'process-crash-only-no-directory-flush'
          : 'process-crash-only-with-directory-fsync',
      };
      await this._writeExclusive(path.join(opDir, 'intent.json'), Buffer.from(stableJson(intent) + '\n'));
      await this._syncDirectory(opDir);
      await this._syncDirectory(this.directory);
      const emptyReceipt = await this._readBounded(receiptPath, receiptIdentity);
      if (emptyReceipt.length !== 0) throw new Error('新预留 receipt 不是空文件');
      const loaded = await this._loadOperation(plan.operationId, opDir);
      if (loaded.status !== 'pending' || loaded.envelope) throw new Error('新预留 receipt 状态不是空 pending');
      this.entries.set(plan.operationId, loaded);
      return {
        operationId: plan.operationId, nonce, binding, receiptPath,
        receiptIdentity, receiptDirectoryIdentity: identity(opDirStat),
      };
    } catch (error) {
      if (created) this.entries.set(plan.operationId, { status: 'pending', intent: { operationId: plan.operationId, plan }, partial: true });
      throw this._fail(`移动日志预留失败，worker 不得启动：${safeError(error)}`);
    }
  }

  async complete(operationId, { kind, result } = {}) {
    if (!this.loaded) await this.load();
    if (this.problem) throw this._fail(`移动日志闭锁：${this.problem}`);
    const entry = this.entries.get(String(operationId || '').toLowerCase());
    if (!entry || entry.status !== 'pending' || entry.partial) throw new Error('没有可完成的完整 pending 移动');
    if (kind !== 'moved' && kind !== 'failed') throw new Error('只能完成已证明的 moved 或 failed 终态');
    const opDir = path.join(this.directory, entry.intent.operationId);
    try {
      const receiptBytes = await this._readBounded(entry.intent.receiptPath, entry.intent.receiptIdentity);
      if (!receiptBytes.length) throw new Error('worker receipt 仍为空');
      let parsed;
      try { parsed = JSON.parse(receiptBytes.toString('utf8')); }
      catch { throw new Error('worker receipt JSON 损坏'); }
      const envelope = this._validateReceipt(parsed, entry.intent);
      if (envelope.result.status !== kind) throw new Error('worker receipt 不是请求的已证明终态');
      if (result !== undefined && stableJson(result) !== stableJson(envelope.result)) throw new Error('调用方结果与独占 receipt 不一致');
      const finished = {
        schema: 1, operationId: entry.intent.operationId, binding: entry.intent.binding,
        kind, finishedAt: new Date().toISOString(), receiptHash: hash(receiptBytes),
        result: this._terminalSummary(kind, envelope),
      };
      await this._writeExclusive(path.join(opDir, 'FINISHED.json'), Buffer.from(stableJson(finished) + '\n'));
      await this._syncDirectory(opDir);
      await this._syncDirectory(this.directory);
      this.entries.set(entry.intent.operationId, { intent: entry.intent, status: kind, result: finished.result, envelope });
      return { status: kind, operationId: entry.intent.operationId, intent: structuredClone(entry.intent), result: finished.result };
    } catch (error) {
      throw this._fail(`移动终态无法持久确认，仍保持闭锁：${safeError(error)}`);
    }
  }

  async status(operationId) {
    if (this.preparingPlan?.operationId === String(operationId || '').toLowerCase() && this.preparingPromise) {
      try { await this.preparingPromise; } catch { /* problem below remains authoritative */ }
    }
    if (!this.loaded) await this.load();
    if (this.problem) return { status: 'problem', reason: this.problem };
    const entry = this.entries.get(String(operationId || '').toLowerCase());
    if (!entry) return { status: 'unknown' };
    return entry.status === 'pending'
      ? { status: 'pending', operationId: entry.intent.operationId, intent: structuredClone(entry.intent) }
      : { status: entry.status, operationId: entry.intent.operationId, intent: structuredClone(entry.intent), result: entry.result };
  }

  async _canonicalAccessPath(raw) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.includes('\0')) throw new Error('受保护路径必须是绝对路径');
    const lexical = path.resolve(raw);
    let cursor = lexical, missing = [];
    while (true) {
      try { await this.io.lstat(cursor); break; }
      catch (error) {
        if (!isMissing(error)) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw new Error('无法核验受保护路径');
        missing.unshift(path.basename(cursor)); cursor = parent;
      }
    }
    const base = await this.io.realpath(cursor);
    return { lexical, canonical: path.resolve(base, ...missing) };
  }

  async assertAccess(rawPath, { mutation = false, inspect = false } = {}) {
    if (!this.loaded) await this.load();
    if (inspect && mutation) throw new Error('inspect 只允许用于只读定位');
    if (inspect) return true; // Caller must still perform the ordinary grant/root authorization.
    if (this.problem) throw this._fail(`移动日志全局闭锁：${this.problem}`);
    if (!this.hasPending) return true;
    const requested = await this._canonicalAccessPath(rawPath);
    const plans = [...this.entries.values()].filter(entry => entry.status === 'pending' && !entry.partial).map(entry => entry.intent.plan);
    if (this.preparingPlan) plans.push(this.preparingPlan);
    for (const plan of plans) {
      const protectedPaths = [plan.source, plan.target];
      for (const record of plan.records) {
        protectedPaths.push(record.source);
        protectedPaths.push(path.resolve(path.dirname(plan.target), '.reader', ...record.relative.split('/')));
      }
      for (const protectedPath of protectedPaths) {
        const lexicalProtected = path.resolve(protectedPath);
        let canonicalProtected;
        try { canonicalProtected = (await this._canonicalAccessPath(protectedPath)).canonical; }
        catch { canonicalProtected = lexicalProtected; }
        const blocked = candidate => samePath(candidate, lexicalProtected) || samePath(candidate, canonicalProtected)
          || (mutation && (isSameOrAncestor(candidate, lexicalProtected) || isSameOrAncestor(candidate, canonicalProtected)));
        if (blocked(requested.lexical) || blocked(requested.canonical)) throw new Error(`路径受未决文件移动保护：${protectedPath}`);
      }
    }
    return true;
  }
}

module.exports = { MoveJournal };
