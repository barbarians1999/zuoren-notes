const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeEpubMeta } = require('./epub-meta.cjs');

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
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
  if (value.version !== 1 || value.recoveryId !== recoveryId || value.sourcePath !== sourcePath) return false;
  if (!['primary', 'secondary'].includes(value.paneHint) || typeof value.content !== 'string') return false;
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  if (!/^[a-f0-9]{64}$/i.test(value.baseHash) || !/^[a-f0-9]{64}$/i.test(value.draftHash)) return false;
  if (!value.encoding || typeof value.encoding !== 'object' || Array.isArray(value.encoding)) return false;
  if (Object.keys(value.encoding).length !== 2 || !Object.hasOwn(value.encoding, 'bom') || !Object.hasOwn(value.encoding, 'eol')) return false;
  if (typeof value.encoding.bom !== 'boolean' || !['\n', '\r\n'].includes(value.encoding.eol)) return false;
  return recoveryDraftHash(value.content, value.encoding) === value.draftHash;
}

async function atomicWrite(file, data) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

class FileStore {
  constructor() { this.roots = new Set(); this.files = new Set(); this.lastBackup = new Map(); this.queues = new Map(); this.identities = new Map(); }
  async contentIdentity(file) {
    const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    const before = fingerprint(await fs.stat(file));
    const key = this.queueKey(file), cached = this.identities.get(key);
    if (cached?.fingerprint === before) return cached.id;
    const id = digest(await fs.readFile(file));
    if (fingerprint(await fs.stat(file)) !== before) throw new Error('文件正在被其他程序修改，请稍后重试');
    this.identities.set(key, { fingerprint: before, id });
    return id;
  }
  async grantRoot(dir) { const real = await fs.realpath(dir); this.roots.add(real); return real; }
  async grantFile(file) { const real = await fs.realpath(file); this.files.add(real); return real; }
  async checked(file, { create = false, asset = false } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('需要绝对文件路径');
    let real;
    try { real = await fs.realpath(file); }
    catch (e) {
      if (!create || e.code !== 'ENOENT') throw e;
      real = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
    }
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
      else if (/\.(pdf|epub|md|markdown)$/i.test(entry.name)) entries.push({ path: full, name: entry.name, relative: path.relative(root, full), kind: 'file', type: /\.pdf$/i.test(entry.name) ? 'pdf' : /\.epub$/i.test(entry.name) ? 'epub' : 'md' });
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
    directory = await this.checked(directory);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('当前地址不是文件夹');
    let name = safeEntryName(requestedName);
    if (!/\.(md|markdown)$/i.test(name)) name += '.md';
    const file = path.join(directory, name);
    await this.checked(file, { create: true });
    try { await fs.writeFile(file, typeof content === 'string' ? content : '', { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('同名笔记已经存在'); throw error; }
    const granted = await this.grantFile(file);
    return this.readNote(granted);
  }
  async createFolderAt(directory, requestedName) {
    directory = await this.checked(directory);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('当前地址不是文件夹');
    const folder = path.join(directory, safeEntryName(requestedName));
    await this.checked(folder, { create: true });
    try { await fs.mkdir(folder); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('同名文件或文件夹已经存在'); throw error; }
    return { path: await fs.realpath(folder), name: path.basename(folder), kind: 'folder' };
  }
  async renameEntry(source, requestedName) {
    source = await this.checked(source);
    const stat = await fs.stat(source);
    let name = safeEntryName(requestedName);
    if (stat.isFile()) {
      const oldExtension = path.extname(source);
      const newExtension = path.extname(name);
      if (!newExtension) name += oldExtension;
      else if (newExtension.toLocaleLowerCase() !== oldExtension.toLocaleLowerCase()) throw new Error('重命名时不能更改文件类型');
    } else if (!stat.isDirectory()) throw new Error('只能重命名文件或文件夹');
    const target = path.join(path.dirname(source), name);
    if (target.toLocaleLowerCase() === source.toLocaleLowerCase() && target !== source) {
      const temporary = path.join(path.dirname(source), `.__zuoren_rename_${crypto.randomUUID()}`);
      await fs.rename(source, temporary);
      try { await fs.rename(temporary, target); } catch (error) { await fs.rename(temporary, source).catch(() => {}); throw error; }
    } else {
      try { await fs.access(target); throw new Error('同名文件或文件夹已经存在'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(source, target);
    }
    const remapSet = values => new Set([...values].map(item => inside(source, item) ? path.join(target, path.relative(source, item)) : item));
    this.files = remapSet(this.files);
    this.roots = remapSet(this.roots);
    const real = await fs.realpath(target);
    if (stat.isDirectory()) return { path: real, name: path.basename(real), kind: 'folder' };
    const type = /\.pdf$/i.test(real) ? 'pdf' : /\.epub$/i.test(real) ? 'epub' : 'md';
    return { path: real, name: path.basename(real), relative: real, kind: 'file', type };
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
    if (buffer[0] === 0xff && buffer[1] === 0xfe || buffer[0] === 0xfe && buffer[1] === 0xff) throw new Error('请先将 Markdown 转存为 UTF-8 编码');
    const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('这份文件不是 UTF-8 编码，请先在原编辑器中转换编码'); }
    return { path: file, content, hash: digest(buffer), bom: hasBom, eol: content.includes('\r\n') ? '\r\n' : '\n' };
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
        await atomicWrite(path.join(dir, prefix + Date.now() + '.md'), old);
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
    try { raw = await fs.readFile(location.target, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let recovery;
    try { recovery = JSON.parse(raw); } catch { return { corrupt: true, recoveryId, sourcePath: location.file }; }
    if (!validRecovery(recovery, recoveryId, location.file)) return { corrupt: true, recoveryId, sourcePath: location.file };
    return recovery;
  }
  async checkRecovery(file, recoveryId) {
    file = await this.checked(file);
    return this.serialized(file, async () => {
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
      const recovery = await this.readRecovery(file, recoveryId);
      if (!recovery || recovery.corrupt || recovery.draftHash !== draftHash) return false;
      const { target } = await this.recoveryLocation(file, recoveryId);
      await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return true;
    });
  }
  async pdf(file) {
    file = await this.checked(file);
    if (!/\.pdf$/i.test(file)) throw new Error('请选择 PDF 文件');
    const data = await fs.readFile(file);
    const id = digest(data);
    let meta = { version: 1, id, page: 1, annotations: [] };
    try {
      const dir = path.join(path.dirname(file), '.reader');
      if (inside(path.dirname(file), await fs.realpath(dir))) {
        const p = path.join(dir, `${id}.json`);
        if (!inside(dir, await fs.realpath(p))) throw new Error('标记文件路径异常');
        meta = { ...meta, ...JSON.parse(await fs.readFile(p, 'utf8')) };
      }
    } catch (e) { if (e.code !== 'ENOENT') throw new Error('PDF 标记文件无法读取，已保留原文件：' + e.message); }
    return { data: new Uint8Array(data), meta, path: file };
  }
  async savePdf(file, meta) {
    if (!/^[a-f0-9]{64}$/.test(meta.id) || !Array.isArray(meta.annotations)) throw new Error('无效的标记数据');
    file = await this.checked(file);
    if (!/\.pdf$/i.test(file)) throw new Error('只能为 PDF 保存标记');
    return this.serialized(file, async () => {
      const currentId = await this.contentIdentity(file);
      if (currentId !== meta.id) throw new Error('PDF 内容已变化，请重新打开后再保存标记');
      const dir = await this.auxiliary(file);
      const target = path.join(dir, meta.id + '.json');
      try { if (!inside(dir, await fs.realpath(target))) throw new Error('标记文件指向资料目录以外'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
      await atomicWrite(target, JSON.stringify({ ...meta, version: 1 }, null, 2));
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
        const saved = JSON.parse(await fs.readFile(target, 'utf8'));
        const normalized = normalizeEpubMeta(saved, id);
        meta = normalized.meta;
        warnings = normalized.warnings;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('EPUB 阅读进度无法读取，已保留原文件：' + error.message); }
    return { data: new Uint8Array(data), meta, warnings, path: file };
  }
  async saveEpub(file, meta) {
    const normalized = normalizeEpubMeta(meta, meta?.id, { strict: true }).meta;
    file = await this.checked(file);
    if (!/\.epub$/i.test(file)) throw new Error('只能为 EPUB 保存阅读进度');
    return this.serialized(file, async () => {
      const currentId = await this.contentIdentity(file);
      if (currentId !== normalized.id) throw new Error('EPUB 内容已变化，请重新打开后继续阅读');
      const dir = await this.auxiliary(file);
      const target = path.join(dir, `${normalized.id}.epub.json`);
      try { if (!inside(dir, await fs.realpath(target))) throw new Error('阅读进度文件指向资料目录以外'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (await fs.access(target).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
        const existing = JSON.parse(await fs.readFile(target, 'utf8'));
        if (existing?.version > 2) throw new Error('此 EPUB 标注数据来自较新版本，已禁止覆盖');
      }
      await atomicWrite(target, JSON.stringify(normalized, null, 2));
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
