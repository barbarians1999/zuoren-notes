const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeEpubMeta, validAnnotation } = require('./epub-meta.cjs');
const { normalizePdfMeta } = require('./pdf-meta.cjs');
const { fileMoveVersion } = require('./file-moves.cjs');

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function digestFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(file, { highWaterMark: 1024 * 1024 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const recoveryIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const reservedWindowsNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function safeEntryName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === '.' || name === '..') throw new Error('请输入名称');
  if (name.length > 180) throw new Error('名称太长，请缩短后再试');
  if (name.startsWith('.') || /[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name) || reservedWindowsNames.test(name)) {
    throw new Error('名称中含有 Windows 不允许使用的字符');
  }
  if (path.basename(name) !== name) throw new Error('名称中不能包含路径');
  return name;
}

function recoveryDraftHash(content, { bom = false, eol = '\n' } = {}) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n');
  return digest(Buffer.from((bom ? '\ufeff' : '') + normalized, 'utf8'));
}

function validRecovery(value, recoveryId, sourcePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['version', 'recoveryId', 'sourcePath', 'paneHint', 'createdAt', 'updatedAt', 'baseHash', 'draftHash', 'content', 'encoding'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return false;
  if (value.version !== 1 || value.recoveryId !== recoveryId || value.sourcePath !== sourcePath
    || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return false;
  if (!['primary', 'secondary'].includes(value.paneHint) || typeof value.content !== 'string') return false;
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  if (!/^[a-f0-9]{64}$/i.test(value.baseHash) || !/^[a-f0-9]{64}$/i.test(value.draftHash)) return false;
  if (!value.encoding || typeof value.encoding !== 'object' || Array.isArray(value.encoding)) return false;
  if (Object.keys(value.encoding).length !== 2 || !Object.hasOwn(value.encoding, 'bom') || !Object.hasOwn(value.encoding, 'eol')) return false;
  if (typeof value.encoding.bom !== 'boolean' || !['\n', '\r\n'].includes(value.encoding.eol)) return false;
  return recoveryDraftHash(value.content, value.encoding) === value.draftHash;
}

async function atomicWrite(file, data, { mode } = {}) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let pending = false;
  try {
    // Never expose note or recovery content through a permissive temporary file.
    const handle = await fs.open(temp, 'wx', 0o600);
    pending = true;
    try {
      await handle.writeFile(data);
      if (process.platform !== 'win32') {
        let targetMode = mode;
        if (targetMode === undefined) {
          // Read just before replacement so chmod during backup/write work is
          // retained. Only a missing target uses the private new-file default.
          try { targetMode = (await fs.stat(file)).mode & 0o777; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        // Apply after writing, independent of umask. Failure must leave the
        // original intact, not silently publish a replacement with wrong access.
        if (targetMode !== undefined) await handle.chmod(targetMode);
      }
      await handle.sync();
    } finally { await handle.close(); }
    // Windows scanners and indexers can briefly deny replacing an open target.
    // Retry only transient sharing/access errors; keep the atomic replacement
    // and leave the original untouched if the bounded retries still fail.
    const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); pending = false; break; }
      catch (error) {
        if (process.platform !== 'win32' || !retryable.has(error.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (2 ** attempt)));
      }
    }
  } finally { if (pending) await fs.unlink(temp).catch(() => {}); }
}

async function realPathOrParent(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    const parent = path.dirname(file);
    if (error.code !== 'ENOENT' || parent === file) throw error;
    return path.join(await realPathOrParent(parent), path.basename(file));
  }
}

class FileStore {
  validMoveRecovery(value, id) { return validRecovery(value, id, value?.sourcePath); }
  constructor() { this.entryQueue = Promise.resolve(); this.roots = new Set(); this.rootIdentities = new Map(); this.files = new Set(); this.lastBackup = new Map(); this.queues = new Map(); this.identities = new Map(); this.identityCachePath = null; this.identityCacheTimer = null; this.identityCacheWrite = Promise.resolve(); }
  statFingerprint(stat) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  }
  async loadIdentityCache(cachePath) {
    this.identityCachePath = cachePath || null;
    if (!this.identityCachePath) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.identityCachePath, 'utf8'));
      if (!raw || raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) return;
      for (const [key, entry] of Object.entries(raw.entries)) {
        if (!entry || typeof entry !== 'object' || typeof entry.fingerprint !== 'string' || !entry.fingerprint) continue;
        if (typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.id)) continue;
        this.identities.set(key, {
          fingerprint: entry.fingerprint,
          id: entry.id.toLowerCase(),
          usedAt: Number.isFinite(entry.usedAt) ? entry.usedAt : 0,
        });
      }
    } catch { /* missing or unreadable cache is harmless */ }
  }
  scheduleIdentityCacheSave() {
    if (!this.identityCachePath || this.identityCacheTimer) return;
    this.identityCacheTimer = setTimeout(() => {
      this.identityCacheTimer = null;
      void this.flushIdentityCache().catch(() => {});
    }, 400);
    if (typeof this.identityCacheTimer.unref === 'function') this.identityCacheTimer.unref();
  }
  async flushIdentityCache() {
    if (this.identityCacheTimer) {
      clearTimeout(this.identityCacheTimer);
      this.identityCacheTimer = null;
    }
    if (!this.identityCachePath) return;
    const entries = {};
    const sorted = [...this.identities.entries()]
      .sort((a, b) => (b[1].usedAt || 0) - (a[1].usedAt || 0))
      .slice(0, 500);
    for (const [key, entry] of sorted) entries[key] = { fingerprint: entry.fingerprint, id: entry.id, usedAt: entry.usedAt || 0 };
    const target = this.identityCachePath;
    const payload = JSON.stringify({ version: 1, entries });
    const next = this.identityCacheWrite.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, payload);
    });
    this.identityCacheWrite = next;
    await next;
  }
  async contentIdentity(file) {
    const before = this.statFingerprint(await fs.stat(file));
    const key = this.queueKey(file), cached = this.identities.get(key);
    if (cached?.fingerprint === before) {
      cached.usedAt = Date.now();
      return cached.id;
    }
    const id = await digestFile(file);
    if (this.statFingerprint(await fs.stat(file)) !== before) throw new Error('文件正在被其他程序修改，请稍后重试');
    this.identities.set(key, { fingerprint: before, id, usedAt: Date.now() });
    this.scheduleIdentityCacheSave();
    return id;
  }
  async grantRoot(dir) {
    const real = await fs.realpath(dir), stat = await fs.lstat(real, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino) throw new Error('资料根目录必须有可核验的目录身份');
    this.roots.add(real); this.rootIdentities.set(real, [stat.dev, stat.ino].join(':')); return real;
  }
  async grantFile(file) { const real = await fs.realpath(file); this.files.add(real); return real; }
  async checked(file, { create = false, asset = false, mutation = false, inspect = false } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('需要绝对文件路径');
    await this.moveGuard?.(file, { mutation, inspect });
    let real;
    try { real = await fs.realpath(file); }
    catch (e) {
      if (!create || e.code !== 'ENOENT') throw e;
      real = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
    }
    await this.moveGuard?.(real, { mutation, inspect });
    if (this.files.has(real) || [...this.roots].some(root => inside(root, real))) return real;
    if (asset && [...this.files].some(f => inside(path.dirname(f), real))) return real;
    throw new Error('请先通过“打开文件”或“打开文件夹”选择这个位置');
  }
  async auxiliary(file) {
    const parent = path.dirname(await this.checked(file));
    const dir = path.join(parent, '.reader');
    await fs.mkdir(dir, { recursive: true });
    if (!inside(parent, await fs.realpath(dir))) throw new Error('辅助文件夹指向资料目录以外，已停止写入');
    return dir;
  }
  async list(root) {
    root = await this.checked(root);
    const files = []; let truncated = false;
    const walk = async (dir, depth) => {
      if (depth > 32 || files.length >= 20000) { truncated = true; return; }
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= 20000) { truncated = true; break; }
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (/\.(pdf|epub|md|markdown)$/i.test(entry.name)) files.push({ path: full, name: entry.name, relative: path.relative(root, full), type: /\.pdf$/i.test(entry.name) ? 'pdf' : /\.epub$/i.test(entry.name) ? 'epub' : 'md' });
      }
    };
    await walk(root, 0);
    return { files: files.sort((a,b) => a.relative.localeCompare(b.relative, 'zh-CN', { numeric: true })), truncated };
  }
  async listDirectory(root, directory) {
    root = await this.checked(root);
    directory = await this.checked(directory);
    if (!inside(root, directory)) throw new Error('只能浏览当前资料文件夹以内的位置');
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error('这个位置不是文件夹');
    const entries = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) entries.push({ path: full, name: entry.name, kind: 'folder' });
      else if (/\.(pdf|epub|md|markdown)$/i.test(entry.name)) {
        let snapshot; try { snapshot = await fs.lstat(full, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (snapshot.isFile() && !snapshot.isSymbolicLink()) entries.push({ path: full, name: entry.name, relative: path.relative(root, full), kind: 'file', type: /\.pdf$/i.test(entry.name) ? 'pdf' : /\.epub$/i.test(entry.name) ? 'epub' : 'md', moveVersion: fileMoveVersion(snapshot) });
      }
    }
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'folder' ? -1 : 1);
    const breadcrumbs = [{ name: path.basename(root) || root.replace(/[\\/]+$/, '') || root, path: root }];
    let cursor = root;
    const relative = path.relative(root, directory);
    if (relative) for (const piece of relative.split(path.sep)) {
      cursor = path.join(cursor, piece);
      breadcrumbs.push({ name: piece, path: cursor });
    }
    return { directory, parent: directory === root ? null : path.dirname(directory), breadcrumbs, entries };
  }
  async createNoteAt(directory, requestedName, content = '') {
    return this.entryMutation(async () => {
      directory = await this.checked(directory, { mutation: true });
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('当前地址不是文件夹');
      let name = safeEntryName(requestedName);
      if (!/\.(md|markdown)$/i.test(name)) name += '.md';
      const file = path.join(directory, name);
      await this.checked(file, { create: true });
      try { await fs.writeFile(file, typeof content === 'string' ? content : '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('同名笔记已经存在'); throw error; }
      const granted = await this.grantFile(file);
      return this.readNote(granted);
    });
  }

  async historyMigrations(source, target) {
    const historyDir = path.join(path.dirname(source), '.reader', 'history');
    let realHistory, entries;
    try {
      const realAux = await fs.realpath(path.dirname(historyDir));
      realHistory = await fs.realpath(historyDir);
      if (!inside(path.dirname(source), realAux) || !inside(realAux, realHistory)) throw new Error('历史目录指向资料目录以外，已停止重命名');
      entries = await fs.readdir(realHistory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const oldPrefix = digest(path.basename(source)).slice(0, 16) + '-';
    const newPrefix = digest(path.basename(target)).slice(0, 16) + '-';
    if (oldPrefix === newPrefix) return [];
    const suffixPattern = new RegExp('^' + oldPrefix + '(\\d+\\.md)$');
    return entries.flatMap(name => {
      const match = name.match(suffixPattern);
      return match ? [{ from: path.join(realHistory, name), to: path.join(realHistory, newPrefix + match[1]) }] : [];
    });
  }

  async createFolderAt(directory, requestedName) {
    return this.entryMutation(async () => {
      directory = await this.checked(directory, { mutation: true });
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('当前地址不是文件夹');
      const folder = path.join(directory, safeEntryName(requestedName));
      await this.checked(folder, { create: true });
      try { await fs.mkdir(folder); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('同名文件或文件夹已经存在'); throw error; }
      return { path: await fs.realpath(folder), name: path.basename(folder), kind: 'folder' };
    });
  }

  async recoveryMigrations(source, target, isDirectory) {
    const directories = [];
    if (!isDirectory) directories.push(path.join(path.dirname(source), '.reader', 'recovery'));
    else {
      const visit = async directory => {
        directories.push(path.join(directory, '.reader', 'recovery'));
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== '.reader') await visit(path.join(directory, entry.name));
        }
      };
      await visit(source);
    }
    const rootKey = path.resolve(source), foldedRoot = rootKey.toLocaleLowerCase('en-US');
    const migrations = [];
    for (let directory of directories) {
      let entries; try {
        const realAux = await fs.realpath(path.dirname(directory)), realRecovery = await fs.realpath(directory);
        if (!inside(path.dirname(path.dirname(directory)), realAux) || !inside(realAux, realRecovery)) throw new Error('恢复目录指向资料目录以外，已停止重命名');
        entries = await fs.readdir(realRecovery);
        directory = realRecovery;
      }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const name of entries) {
        if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
        const recoveryId = name.slice(0, -5);
        if (!recoveryIdPattern.test(recoveryId)) continue;
        const file = path.join(directory, name);
        const raw = await fs.readFile(file);
        let value; try { value = JSON.parse(raw.toString('utf8')); }
        catch { continue; } // Damaged records are preserved byte-for-byte and remain addressable by ID.
        if (!validRecovery(value, recoveryId, value?.sourcePath)) continue;
        const foldedSource = path.resolve(value.sourcePath).toLocaleLowerCase('en-US');
        if (isDirectory ? !(foldedSource === foldedRoot || foldedSource.startsWith(foldedRoot + path.sep)) : foldedSource !== foldedRoot) continue;
        // Canonicalize aliases, but never merge distinct case-sensitive names.
        const sourceKey = await realPathOrParent(value.sourcePath);
        if (isDirectory ? !(sourceKey === rootKey || sourceKey.startsWith(rootKey + path.sep)) : sourceKey !== rootKey) continue;
        const nextSource = isDirectory ? path.join(target, path.relative(source, sourceKey)) : target;
        migrations.push({ file, raw, next: Buffer.from(JSON.stringify({ ...value, sourcePath: nextSource })) });
      }
    }
    return migrations;
  }
  writeRecoveryRecord(file, data) { return atomicWrite(file, data); }
  async renameEntry(source, requestedName) {
    return this.entryMutation(async () => {
      source = await this.checked(source, { mutation: true });
      const stat = await fs.stat(source);
      let name = safeEntryName(requestedName);
      if (stat.isFile()) {
        const oldExtension = path.extname(source);
        const newExtension = path.extname(name);
        if (!newExtension) name += oldExtension;
        else if (newExtension.toLocaleLowerCase() !== oldExtension.toLocaleLowerCase()) throw new Error('重命名时不能更改文件类型');
      } else if (!stat.isDirectory()) throw new Error('只能重命名文件或文件夹');
      const target = path.join(path.dirname(source), name);
      await this.checked(target, { create: true, mutation: true });
      if (target === source) {
        const real = await fs.realpath(source);
        if (stat.isDirectory()) return { path: real, name: path.basename(real), kind: 'folder' };
        return { path: real, name: path.basename(real), relative: real, kind: 'file', type: /\.pdf$/i.test(real) ? 'pdf' : /\.epub$/i.test(real) ? 'epub' : 'md' };
      }
      let sameIdentity = false;
      try {
        const existing = await fs.stat(target);
        const sameEntity = stat.ino && existing.ino ? stat.dev === existing.dev && stat.ino === existing.ino
          : await fs.realpath(target) === source;
        sameIdentity = target.toLocaleLowerCase() === source.toLocaleLowerCase() && sameEntity;
        if (!sameIdentity) throw new Error('同名文件或文件夹已经存在');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const migrations = stat.isFile() && /\.(md|markdown)$/i.test(source)
        ? await this.recoveryMigrations(source, target, false)
        : stat.isDirectory() ? await this.recoveryMigrations(source, target, true) : [];
      const historyMoves = stat.isFile() && /\.(md|markdown)$/i.test(source)
        ? await this.historyMigrations(source, target) : [];
      let moved = false;
      const moveEntity = async (from, to) => {
        if (sameIdentity && from !== to) {
          const temporary = path.join(path.dirname(source), `.__zuoren_rename_${crypto.randomUUID()}`);
          await fs.rename(from, temporary);
          try { await fs.rename(temporary, to); } catch (error) { await fs.rename(temporary, from).catch(() => {}); throw error; }
        } else await fs.rename(from, to);
      };
      await moveEntity(source, target); moved = true;
      const committed = [];
      const committedHistory = [];
      try {
        for (const item of migrations) {
          const relative = path.relative(source, item.file);
          const movedFile = stat.isDirectory() ? path.join(target, relative) : item.file;
          committed.push({ file: movedFile, raw: item.raw });
          await this.writeRecoveryRecord(movedFile, item.next);
        }
        for (const item of historyMoves) {
          await fs.rename(item.from, item.to);
          committedHistory.push(item);
        }
      } catch (error) {
        const rollbackErrors = [];
        for (const item of committedHistory.reverse()) try { await fs.rename(item.to, item.from); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        for (const item of committed.reverse()) try { await this.writeRecoveryRecord(item.file, item.raw); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (moved) try { await moveEntity(target, source); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (rollbackErrors.length) throw new Error(`恢复稿路径迁移失败且回滚未完全成功：${error.message}；${rollbackErrors.map(item => item.message).join('；')}`);
        throw new Error(`恢复稿路径迁移失败，文件名已回滚：${error.message}`);
      }
      const remapSet = values => new Set([...values].map(item => inside(source, item) ? path.join(target, path.relative(source, item)) : item));
      this.files = remapSet(this.files);
      this.roots = remapSet(this.roots);
      this.rootIdentities = new Map([...this.rootIdentities].map(([key, value]) => [inside(source, key) ? path.join(target, path.relative(source, key)) : key, value]));
      const real = await fs.realpath(target);
      if (stat.isDirectory()) return { path: real, name: path.basename(real), kind: 'folder' };
      const type = /\.pdf$/i.test(real) ? 'pdf' : /\.epub$/i.test(real) ? 'epub' : 'md';
      return { path: real, name: path.basename(real), relative: real, kind: 'file', type };
    });
  }

  forgetEntry(entry) {
    this.files = new Set([...this.files].filter(file => !inside(entry, file)));
    this.roots = new Set([...this.roots].filter(root => !inside(entry, root)));
  }
  async readNote(file) {
    file = await this.checked(file);
    if (!/\.(md|markdown)$/i.test(file)) throw new Error('只能编辑 Markdown 文件');
    const stat = await fs.stat(file);
    if (stat.size > 20 * 1024 * 1024) throw new Error('这份 Markdown 超过 20 MB，请拆分后打开');
    const buffer = await fs.readFile(file);
    // Reject a read that crossed an in-place write or atomic replacement.
    // Keep the caller's existing document and retry on a later poll/F5.
    const after = await fs.stat(file);
    if (await this.checked(file) !== file || [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') !==
        [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') || buffer.length !== after.size)
      throw new Error('文件正在被其他程序修改，请稍后重试');
    if (buffer.length > 20 * 1024 * 1024) throw new Error('这份 Markdown 超过 20 MB，请拆分后打开');
    if (buffer[0] === 0xff && buffer[1] === 0xfe || buffer[0] === 0xfe && buffer[1] === 0xff) throw new Error('请先将 Markdown 转存为 UTF-8 编码');
    const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('这份文件不是 UTF-8 编码，请先在原编辑器中转换编码'); }
    return { path: file, content, hash: digest(buffer), bom: hasBom, eol: content.includes('\r\n') ? '\r\n' : '\n' };
  }
  entryMutation(job) {
    const task = this.entryQueue.catch(() => {}).then(job); this.entryQueue = task; return task;
  }
  queueKey(file) {
    // Windows paths are case-insensitive.  Without a canonical queue key,
    // two IPC calls that spell the same file differently can write in
    // parallel and defeat the conditional-save barrier.
    return process.platform === 'win32' ? path.resolve(file).toLocaleLowerCase('en-US') : file;
  }
  async serialized(file, job) {
    const key = this.queueKey(file);
    const previous = this.queues.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(job);
    this.queues.set(key, task);
    try { return await task; } finally { if (this.queues.get(key) === task) this.queues.delete(key); }
  }
  async saveNote({ path: file, content, hash, bom = false, eol = '\n' }) {
    file = await this.checked(file);
    if (!/\.(md|markdown)$/i.test(file) || typeof content !== 'string') throw new Error('无效的笔记');
    return this.serialized(file, async () => {
      await this.checked(file, { mutation: true });
      const old = await fs.readFile(file);
      if (digest(old) !== hash) return { conflict: true, ...(await this.readNote(file)) };
      const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n');
      const data = Buffer.from((bom ? '\ufeff' : '') + normalized, 'utf8');
      if (digest(data) === hash) return { hash, content: normalized };
      // Back up the previous version before replacing the user's file.
      const aux = await this.auxiliary(file);
      if (Date.now() - (this.lastBackup.get(file) || 0) > 30000) {
        const dir = path.join(aux, 'history'); await fs.mkdir(dir, { recursive: true });
        if (!inside(aux, await fs.realpath(dir))) throw new Error('历史目录不在资料文件夹内');
        const prefix = digest(path.basename(file)).slice(0, 16) + '-';
        await atomicWrite(path.join(dir, prefix + Date.now() + '.md'), old, { mode: 0o600 });
        const previous = (await fs.readdir(dir)).filter(n => n.startsWith(prefix) && /^\w+-\d+\.md$/.test(n)).sort().reverse();
        for (const name of previous.slice(20)) await fs.unlink(path.join(dir, name));
        this.lastBackup.set(file, Date.now());
      }
      // Recheck after backup work: another editor may have saved meanwhile.
      if (digest(await fs.readFile(file)) !== hash) return { conflict: true, ...(await this.readNote(file)) };
      await atomicWrite(file, data);
      return { hash: digest(data), content: normalized };
    });
  }
  async recoveryLocation(file, recoveryId, { create = false } = {}) {
    if (typeof recoveryId !== 'string' || !recoveryIdPattern.test(recoveryId)) throw new Error('无效的恢复稿编号');
    file = await this.checked(file);
    const aux = await this.auxiliary(file);
    const dir = path.join(aux, 'recovery');
    if (create) await fs.mkdir(dir, { recursive: true });
    try {
      const realDir = await fs.realpath(dir);
      if (!inside(aux, realDir)) throw new Error('恢复目录指向资料目录以外');
      const target = path.join(realDir, `${recoveryId}.json`);
      try { if (!inside(realDir, await fs.realpath(target))) throw new Error('恢复稿文件指向资料目录以外'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { file, dir: realDir, target };
    } catch (error) {
      if (error.code === 'ENOENT' && !create) return { file, dir, target: path.join(dir, `${recoveryId}.json`), missing: true };
      throw error;
    }
  }
  async writeRecovery(input) {
    if (!input || typeof input !== 'object' || !recoveryIdPattern.test(input.recoveryId || '') || !['primary', 'secondary'].includes(input.paneHint)) throw new Error('无效的恢复稿');
    if (typeof input.content !== 'string' || !/^[a-f0-9]{64}$/i.test(input.baseHash || '')) throw new Error('无效的恢复稿内容');
    if (!input.encoding || typeof input.encoding.bom !== 'boolean' || !['\n', '\r\n'].includes(input.encoding.eol)) throw new Error('无效的恢复稿编码');
    const encoding = { bom: input.encoding.bom, eol: input.encoding.eol };
    const { recoveryId, paneHint } = input;
    const sourcePath = await this.checked(input.sourcePath);
    return this.serialized(sourcePath, async () => {
      await this.checked(sourcePath, { mutation: true });
      const { file, target } = await this.recoveryLocation(sourcePath, recoveryId, { create: true });
      let previous = null;
      try {
        previous = JSON.parse(await fs.readFile(target, 'utf8'));
        if (!validRecovery(previous, recoveryId, file)) throw new Error('已有恢复稿损坏，已保留原文件');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const record = {
        version: 1,
        recoveryId,
        sourcePath: file,
        paneHint,
        createdAt: previous ? previous.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        baseHash: input.baseHash,
        draftHash: recoveryDraftHash(input.content, encoding),
        content: input.content,
        encoding,
      };
      if (!validRecovery(record, recoveryId, file)) throw new Error('恢复稿校验失败');
      await atomicWrite(target, JSON.stringify(record));
      return record;
    });
  }
  async readRecovery(file, recoveryId) {
    const location = await this.recoveryLocation(file, recoveryId);
    if (location.missing) return null;
    let raw;
    await this.checked(location.target, { create: true, asset: true });
    try { raw = await fs.readFile(location.target, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    await this.checked(file);
    await this.checked(location.target, { asset: true });
    let recovery;
    try { recovery = JSON.parse(raw); } catch { return { corrupt: true, recoveryId, sourcePath: location.file }; }
    if (!validRecovery(recovery, recoveryId, location.file)) return { corrupt: true, recoveryId, sourcePath: location.file };
    return recovery;
  }
  async checkRecovery(file, recoveryId) {
    file = await this.checked(file);
    return this.serialized(file, async () => {
      await this.checked(file, { mutation: true });
      const recovery = await this.readRecovery(file, recoveryId);
      if (!recovery) return { status: 'none' };
      if (recovery.corrupt) return { status: 'corrupt' };
      const note = await this.readNote(file);
      if (note.hash === recovery.draftHash) {
        const { target } = await this.recoveryLocation(file, recoveryId);
        const latest = await this.readRecovery(file, recoveryId);
        if (latest && !latest.corrupt && latest.draftHash === recovery.draftHash) await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        return { status: 'already-saved', note };
      }
      if (note.hash === recovery.baseHash) return { status: 'recoverable', note, recovery };
      return { status: 'conflict', note, recovery };
    });
  }
  async deleteRecoveryIfHash(file, recoveryId, draftHash) {
    file = await this.checked(file);
    return this.serialized(file, async () => {
      await this.checked(file, { mutation: true });
      const recovery = await this.readRecovery(file, recoveryId);
      if (!recovery || recovery.corrupt || recovery.draftHash !== draftHash) return false;
      const { target } = await this.recoveryLocation(file, recoveryId);
      await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return true;
    });
  }
  async readPdfSidecar(file, id) {
    let meta = { version: 1, id, page: 1, annotations: [] };
    try {
      const dir = path.join(path.dirname(file), '.reader');
      if (inside(path.dirname(file), await fs.realpath(dir))) {
        const p = path.join(dir, `${id}.json`);
        if (!inside(dir, await fs.realpath(p))) throw new Error('标记文件路径异常');
        await this.checked(p, { asset: true });
        meta = normalizePdfMeta(JSON.parse(await fs.readFile(p, 'utf8')), id);
        await this.checked(p, { asset: true });
      }
    } catch (e) { if (e.code !== 'ENOENT') throw new Error('PDF 标记文件无法读取，已保留原文件：' + e.message); }
    return meta;
  }
  async pdf(file) {
    file = await this.checked(file);
    if (!/\.pdf$/i.test(file)) throw new Error('请选择 PDF 文件');
    const before = this.statFingerprint(await fs.stat(file));
    const data = await fs.readFile(file);
    const id = digest(data);
    if (this.statFingerprint(await fs.stat(file)) === before) {
      this.identities.set(this.queueKey(file), { fingerprint: before, id, usedAt: Date.now() });
      this.scheduleIdentityCacheSave();
    }
    const meta = await this.readPdfSidecar(file, id);
    await this.checked(file);
    return { data: new Uint8Array(data), meta, path: file };
  }
  async openPdfDescriptor(file, { inlineThresholdBytes = 1024 * 1024 } = {}) {
    file = await this.checked(file);
    if (!/\.pdf$/i.test(file)) throw new Error('请选择 PDF 文件');
    const stat = await fs.stat(file);
    const size = stat.size;
    if (size <= inlineThresholdBytes) {
      const before = this.statFingerprint(stat);
      const data = await fs.readFile(file);
      const id = digest(data);
      if (this.statFingerprint(await fs.stat(file)) === before) {
        this.identities.set(this.queueKey(file), { fingerprint: before, id, usedAt: Date.now() });
        this.scheduleIdentityCacheSave();
      }
      const meta = await this.readPdfSidecar(file, id);
      await this.checked(file);
      return { data: new Uint8Array(data), size, rangeMode: false, meta, path: file };
    }
    const id = await this.contentIdentity(file);
    const meta = await this.readPdfSidecar(file, id);
    await this.checked(file);
    return { size, rangeMode: true, meta, path: file };
  }
  async readPdfRange(file, begin, end) {
    file = await this.checked(file);
    if (!/\.pdf$/i.test(file)) throw new Error('请选择 PDF 文件');
    if (!Number.isFinite(begin) || !Number.isFinite(end)) throw new Error('PDF 读取范围无效');
    const maxChunk = 16 * 1024 * 1024;
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const start = Math.max(0, Math.min(Math.floor(begin), stat.size));
      const finish = Math.max(start, Math.min(Math.floor(end), stat.size, start + maxChunk));
      const length = finish - start;
      if (length <= 0) return new Uint8Array(0);
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
    } finally {
      await handle.close();
    }
  }
  async savePdf(file, meta) {
    const normalized = normalizePdfMeta(meta, meta?.id);
    file = await this.checked(file);
    if (!/\.pdf$/i.test(file)) throw new Error('只能为 PDF 保存标记');
    return this.serialized(file, async () => {
      await this.checked(file, { mutation: true });
      const currentId = await this.contentIdentity(file);
      if (currentId !== normalized.id) throw new Error('PDF 内容已变化，请重新打开后再保存标记');
      const dir = await this.auxiliary(file);
      const target = path.join(dir, normalized.id + '.json');
      await this.checked(target, { create: true, asset: true, mutation: true });
      try { if (!inside(dir, await fs.realpath(target))) throw new Error('标记文件指向资料目录以外'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
      try {
        // The sidecar may have changed after opening (another app or version).
        // Validate it again inside the write queue before replacing its bytes.
        normalizePdfMeta(JSON.parse(await fs.readFile(target, 'utf8')), normalized.id);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await atomicWrite(target, JSON.stringify(normalized, null, 2));
      return true;
    });
  }
  async epub(file) {
    file = await this.checked(file);
    if (!/\.epub$/i.test(file)) throw new Error('请选择 EPUB 文件');
    const data = await fs.readFile(file);
    const id = digest(data);
    let meta = { version: 2, id, cfi: '', progress: 0, fontSize: 100, annotations: [] };
    let warnings = [];
    try {
      const dir = path.join(path.dirname(file), '.reader');
      if (inside(path.dirname(file), await fs.realpath(dir))) {
        const target = path.join(dir, `${id}.epub.json`);
        if (!inside(dir, await fs.realpath(target))) throw new Error('阅读进度文件路径异常');
        await this.checked(target, { asset: true });
        const saved = JSON.parse(await fs.readFile(target, 'utf8'));
        await this.checked(target, { asset: true });
        const normalized = normalizeEpubMeta(saved, id);
        meta = normalized.meta;
        warnings = normalized.warnings;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('EPUB 阅读进度无法读取，已保留原文件：' + error.message); }
    await this.checked(file);
    return { data: new Uint8Array(data), meta, warnings, path: file };
  }
  async saveEpub(file, meta) {
    const normalized = normalizeEpubMeta(meta, meta?.id, { strict: true }).meta;
    file = await this.checked(file);
    if (!/\.epub$/i.test(file)) throw new Error('只能为 EPUB 保存阅读进度');
    return this.serialized(file, async () => {
      await this.checked(file, { mutation: true });
      const currentId = await this.contentIdentity(file);
      if (currentId !== normalized.id) throw new Error('EPUB 内容已变化，请重新打开后继续阅读');
      const dir = await this.auxiliary(file);
      const target = path.join(dir, `${normalized.id}.epub.json`);
      await this.checked(target, { create: true, asset: true, mutation: true });
      try { if (!inside(dir, await fs.realpath(target))) throw new Error('阅读进度文件指向资料目录以外'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let preserved = [];
      if (await fs.access(target).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
        const existing = JSON.parse(await fs.readFile(target, 'utf8'));
        // Revalidate the original inside the queue, including external changes.
        // The renderer can omit damaged records for display, never for storage.
        normalizeEpubMeta(existing, normalized.id);
        if (existing.version === 2) {
          if (!Array.isArray(existing.annotations)) throw new Error('EPUB 标注列表损坏，已禁止覆盖原文件');
          preserved = existing.annotations.filter(annotation => !validAnnotation(annotation));
        }
      }
      await atomicWrite(target, JSON.stringify({ ...normalized, annotations: [...normalized.annotations, ...preserved] }, null, 2));
      return true;
    });
  }
  async search(root, query) {
    if (!query.trim()) return [];
    const { files } = await this.list(root); const q = query.toLocaleLowerCase(); const results = [];
    for (const file of files) {
      if (results.length >= 300) break;
      const nameMatch = file.relative.toLocaleLowerCase().includes(q);
      let snippet = '', line = 0;
      if (file.type === 'md') {
        try {
          const real = await this.checked(file.path);
          const stat = await fs.stat(real);
          if (stat.size <= 20 * 1024 * 1024) {
            const content = await fs.readFile(real, 'utf8'); const index = content.toLocaleLowerCase().indexOf(q);
            if (index >= 0) { snippet = content.slice(Math.max(0, index - 35), index + q.length + 90).replace(/\s+/g, ' '); line = content.slice(0,index).split('\n').length; }
          }
        } catch { /* unreadable files remain searchable by name */ }
      }
      if (nameMatch || snippet) results.push({ ...file, snippet, line });
    }
    return results;
  }
  async history(file) {
    file = await this.checked(file); const dir = await this.auxiliary(file); const history = path.join(dir, 'history');
    const prefix = digest(path.basename(file)).slice(0,16) + '-';
    try {
      if (!inside(dir, await fs.realpath(history))) throw new Error('历史目录异常');
      const names = (await fs.readdir(history)).filter(n => n.startsWith(prefix) && /^\w+-\d+\.md$/.test(n)).sort().reverse();
      return await Promise.all(names.map(async name => {
        const full = await fs.realpath(path.join(history, name));
        if (!inside(history, full)) throw new Error('历史文件异常');
        return { time: Number(name.slice(prefix.length, -3)), content: await fs.readFile(full, 'utf8') };
      }));
    } catch(e) { if (e.code === 'ENOENT') return []; throw e; }
  }
}
module.exports = { FileStore, atomicWrite, digest, inside, recoveryDraftHash };
