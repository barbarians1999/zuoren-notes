const { app, BrowserWindow, dialog, ipcMain, protocol, Menu, shell, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileStore, digest, inside } = require('./storage.cjs');
const { recoveryIdPattern, validateSession, sessionFilePaths } = require('./session.cjs');
const { SettingsStore } = require('./settings.cjs');
const { readSettingsFile } = require('./settings-file.cjs');
const { saveNoteAndCleanup } = require('./note-service.cjs');
const { installWindowFocus } = require('./window-focus.cjs');
const { noteImageBytes, openImage } = require('./note-image.cjs');

if (process.env.ZHAOYE_TEST_USER_DATA) app.setPath('userData', process.env.ZHAOYE_TEST_USER_DATA);
else app.setPath('userData', path.join(app.getPath('appData'), '照页'));
app.setName('左人笔记');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

protocol.registerSchemesAsPrivileged([{ scheme: 'reader-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const store = new FileStore();
const jobs = new Map();
let mainWindow;
let withWindowDialog;
let allowClose = false;
let quitRequested = false;
let windowMinimumSyncTimer;
const pendingMacFiles = [];
let launchItems = { files: [] };

function syncWindowMinimumWidth(window) {
  if (!window || window.isDestroyed() || window !== mainWindow) return;
  const display = screen.getDisplayMatching(window.getBounds());
  const width = Math.floor(display.workAreaSize.width / 2);
  const [currentWidth, currentHeight] = window.getMinimumSize();
  if (currentWidth !== width) window.setMinimumSize(width, currentHeight);
}

function scheduleWindowMinimumWidthSync(window) {
  clearTimeout(windowMinimumSyncTimer);
  windowMinimumSyncTimer = setTimeout(() => syncWindowMinimumWidth(window), 140);
}

// Finder sends open-file rather than command-line arguments on macOS.
// Register before ready so a cold launch does not lose the selected file.
app.on('open-file', (event, file) => {
  event.preventDefault();
  if (!mainWindow || mainWindow.isDestroyed()) pendingMacFiles.push(file);
  else void collectLaunchItems([file]).then(deliverLaunchItems).catch(console.error);
});

function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
const emptySettings = () => ({ recentFiles: [], roots: [], session: null });
let settingsWarning = '';
async function readSettings() {
    const { parsed, backup } = await readSettingsFile(settingsFile());
    if (backup) settingsWarning = `设置文件损坏，原件已保留在 ${backup}；已使用空设置启动。`;
    if (!parsed) return emptySettings();
    const window = parsed.window && typeof parsed.window === 'object' ? {
      ...(Number.isFinite(parsed.window.x) ? { x: Math.round(parsed.window.x) } : {}),
      ...(Number.isFinite(parsed.window.y) ? { y: Math.round(parsed.window.y) } : {}),
      ...(Number.isFinite(parsed.window.width) && parsed.window.width >= 960 ? { width: Math.round(parsed.window.width) } : {}),
      ...(Number.isFinite(parsed.window.height) && parsed.window.height >= 640 ? { height: Math.round(parsed.window.height) } : {}),
    } : undefined;
    return { recentFiles: Array.isArray(parsed.recentFiles) ? parsed.recentFiles.filter(item => typeof item === 'string').slice(0, 30) : [], roots: Array.isArray(parsed.roots) ? parsed.roots.filter(item => typeof item === 'string').slice(0, 20) : [], window: window && Object.keys(window).length ? window : undefined, session: validateSession(parsed.session) };
}
async function writeSettings(value) {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  const temporary = `${settingsFile()}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temporary, settingsFile());
    return value;
  } finally {
    // Antivirus/indexer interference can fail the rename.  Do not leave a
    // growing pile of settings snapshots behind in the user-data directory.
    await fs.unlink(temporary).catch(() => {});
  }
}
const settingsStore = new SettingsStore({ read: readSettings, write: writeSettings });
async function rememberFile(file) {
  await settingsStore.update(settings => ({
    ...settings,
    recentFiles: [file, ...settings.recentFiles.filter(item => item !== file)].slice(0, 30),
  }));
}
async function restoreGrants() {
  const settings = await readSettings();
  const roots = [];
  const recentFiles = [];
  const savedRoots = [...new Set([...(settings.roots || []), settings.session?.root].filter(Boolean))];
  for (const root of savedRoots) try { roots.push(await store.grantRoot(root)); } catch { /* moved */ }
  for (const file of settings.recentFiles || []) try { recentFiles.push(await store.grantFile(file)); } catch { /* moved */ }
  // A workspace can retain more tabs than the recent-files list, including
  // notes outside the chosen root. Restore grants for the complete session.
  const sessionFiles = sessionFilePaths(settings.session);
  for (const file of new Set(sessionFiles)) try { await store.grantFile(file); } catch { /* renderer reports unavailable files */ }
  if (roots.length !== (settings.roots || []).length || recentFiles.length !== (settings.recentFiles || []).length) {
    // Keep cleanup inside the same read -> mutate -> write queue as every
    // other settings/session update.  A direct write here could otherwise
    // race with a session save during startup and restore an old snapshot.
    await settingsStore.update(current => ({ ...current, roots, recentFiles }));
  }
  return { ...settings, roots, recentFiles };
}
function entry(file, relative = path.basename(file)) {
  return { path: file, name: path.basename(file), relative, type: /\.pdf$/i.test(file) ? 'pdf' : /\.epub$/i.test(file) ? 'epub' : 'md' };
}
async function collectLaunchItems(argv, workingDirectory = process.cwd()) {
  const items = { files: [] };
  const candidates = argv.filter(value => value && !value.startsWith('-')).map(value => path.isAbsolute(value) ? value : path.resolve(workingDirectory, value)).filter(value => app.isPackaged || path.resolve(value) !== path.resolve(app.getAppPath()));
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        const root = await store.grantRoot(candidate);
        return { root, files: (await store.list(root)).files };
      }
      if (stat.isFile() && /\.(pdf|epub|md|markdown)$/i.test(candidate)) {
        const file = await store.grantFile(candidate);
        items.files.push(entry(file));
      }
    } catch { /* not a launch path */ }
  }
  return items;
}
async function authorizeLaunchArgs() {
  launchItems = await collectLaunchItems([...process.argv.slice(1), ...pendingMacFiles.splice(0)]);
}
function deliverLaunchItems(items) {
  if (!items.root && !items.files.length) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    launchItems = items;
    return;
  }
  const send = () => {
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('open-launch-items', items);
  };
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}
async function chooseWorkspace() {
  const result = await withWindowDialog(() => dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }));
  if (result.canceled || !result.filePaths[0]) return null;
  const root = await store.grantRoot(result.filePaths[0]);
  const listing = await store.list(root);
  await settingsStore.update(settings => ({
    ...settings,
    roots: [root, ...settings.roots.filter(item => item !== root)].slice(0, 20),
  }));
  return { path: root, files: listing.files };
}
async function chooseFiles() {
  const result = await withWindowDialog(() => dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF、EPUB 与 Markdown', extensions: ['pdf', 'epub', 'md', 'markdown'] }],
  }));
  if (result.canceled) return [];
  const files = [];
  for (const selected of result.filePaths) {
    const file = await store.grantFile(selected);
    files.push(entry(file));
    await rememberFile(file);
  }
  return files;
}
async function ensurePdf(file, expectedId) {
  const checked = await store.checked(file, { asset: true });
  if (!/\.pdf$/i.test(checked)) return null;
  return digest(await fs.readFile(checked)) === expectedId ? checked : null;
}
async function ensureEpub(file, expectedId) {
  const checked = await store.checked(file, { asset: true });
  if (!/\.epub$/i.test(checked)) return null;
  return digest(await fs.readFile(checked)) === expectedId ? checked : null;
}
function mimeFor(file) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
function ocrResourcePath() { return path.join(app.getAppPath(), 'dist', 'ocr'); }
function windowState(window) { return { maximized: window.isMaximized(), fullscreen: window.isFullScreen() }; }

function installHandlers() {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('不受信任的页面请求');
    return callback(event, ...args);
  });
  handle('get-launch-items', () => launchItems);
  handle('choose-workspace', chooseWorkspace);
  handle('choose-files', chooseFiles);
  handle('list-workspace', async (_event, root) => store.list(await store.checked(root)));
  handle('list-directory', async (_event, input) => store.listDirectory(input.root, input.directory));
  handle('choose-relocation', async (_event, input) => {
    const result = await withWindowDialog(() => dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] }));
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = await store.grantFile(result.filePaths[0]);
    return ensurePdf(selected, input.pdfId);
  });
  handle('choose-epub-relocation', async (_event, input) => {
    const result = await withWindowDialog(() => dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'EPUB', extensions: ['epub'] }] }));
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = await store.grantFile(result.filePaths[0]);
    return ensureEpub(selected, input.epubId);
  });
  handle('read-note', async (_event, file) => store.readNote(await store.checked(file)));
  handle('save-note', (_event, input) => saveNoteAndCleanup(store, input));
  handle('note-history', async (_event, file) => store.history(await store.checked(file)));
  handle('write-recovery', (_event, input) => store.writeRecovery(input));
  handle('check-recovery', (_event, input) => store.checkRecovery(input.sourcePath, input.recoveryId));
  handle('delete-recovery', (_event, input) => store.deleteRecoveryIfHash(input.sourcePath, input.recoveryId, input.draftHash));
  handle('open-pdf', async (_event, file) => {
    const pdf = await store.pdf(await store.checked(file));
    await rememberFile(pdf.path);
    return pdf;
  });
  handle('save-pdf-meta', async (_event, input) => store.savePdf(await store.checked(input.path), input.meta));
  handle('open-epub', async (_event, file) => {
    const book = await store.epub(await store.checked(file));
    await rememberFile(book.path);
    return book;
  });
  handle('save-epub-meta', async (_event, input) => store.saveEpub(await store.checked(input.path), input.meta));
  handle('search', async (_event, input) => store.search(await store.checked(input.root), input.query));
  handle('get-settings', async () => {
    try { return { ...await readSettings(), warning: settingsWarning || undefined }; }
    catch (error) { return { ...emptySettings(), warning: `无法读取或保留设置文件，设置写入已停止：${error instanceof Error ? error.message : String(error)}` }; }
  });
  handle('get-window-state', event => windowState(BrowserWindow.fromWebContents(event.sender)));
  handle('window-control', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { maximized: false, fullscreen: false };
    if (action === 'minimize') window.minimize();
    else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (action === 'fullscreen') window.setFullScreen(!window.isFullScreen());
    else if (action === 'close') window.close();
    return windowState(window);
  });
  handle('update-settings', async (_event, patch) => {
    return settingsStore.update(current => {
      const updated = { ...current };
      if (patch?.window && typeof patch.window === 'object') updated.window = patch.window;
      if (patch && Object.hasOwn(patch, 'session')) {
        const session = patch.session === null ? null : validateSession(patch.session);
        if (session || patch.session === null) updated.session = session;
      }
      return updated;
    });
  });
  handle('save-session', async (_event, session) => {
    const validated = validateSession(session);
    if (!validated) throw new Error('工作现场数据无效');
    return settingsStore.update(settings => ({ ...settings, session: validated }));
  });
  handle('show-item-in-folder', async (_event, file) => {
    const checked = await store.checked(file);
    shell.showItemInFolder(checked);
    return true;
  });
  handle('create-note-at', async (_event, input) => {
    const loaded = await store.createNoteAt(input.directory, input.name, input.initialContent || '');
    await rememberFile(loaded.path);
    return loaded;
  });
  handle('create-folder-at', (_event, input) => store.createFolderAt(input.directory, input.name));
  handle('rename-entry', async (_event, input) => {
    const renamed = await store.renameEntry(input.path, input.name);
    if (renamed.kind === 'file') await rememberFile(renamed.path);
    return renamed;
  });
  handle('trash-entry', async (_event, file) => {
    const checked = await store.checked(file);
    await shell.trashItem(checked);
    store.forgetEntry(checked);
    return true;
  });
  handle('create-note', async (_event, input = {}) => {
    const result = await withWindowDialog(() => dialog.showSaveDialog(mainWindow, { defaultPath: input.suggestedName || '新笔记.md', filters: [{ name: 'Markdown', extensions: ['md'] }] }));
    if (result.canceled || !result.filePath) return null;
    const file = path.extname(result.filePath) ? result.filePath : `${result.filePath}.md`;
    try { await fs.access(file); throw new Error('目标文件已存在，请换一个文件名'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await store.grantFile(path.dirname(file));
    await fs.writeFile(file, input.initialContent || '', 'utf8');
    const granted = await store.grantFile(file);
    await rememberFile(granted);
    return store.readNote(granted);
  });
  handle('save-as', async (_event, input) => {
    const result = await withWindowDialog(() => dialog.showSaveDialog(mainWindow, { defaultPath: input.suggestedName || '笔记.md', filters: [{ name: 'Markdown', extensions: ['md'] }] }));
    if (result.canceled || !result.filePath) return null;
    const file = path.extname(result.filePath) ? result.filePath : `${result.filePath}.md`;
    try { await fs.access(file); throw new Error('目标文件已存在，请换一个文件名'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await store.grantFile(path.dirname(file));
    await fs.writeFile(file, input.content || '', 'utf8');
    const granted = await store.grantFile(file);
    await rememberFile(granted);
    return store.readNote(granted);
  });
  handle('save-attachment', async (_event, input) => {
    const source = await store.checked(input.sourcePath);
    if (!/\.(pdf|md|markdown)$/i.test(source)) throw new Error('附件必须关联 PDF 或 Markdown');
    if (input.purpose !== undefined && input.purpose !== 'note-image') throw new Error('附件用途无效');
    if (input.purpose === 'note-image' && !/\.(md|markdown)$/i.test(source)) throw new Error('粘贴图片必须关联 Markdown 笔记');
    const image = input.purpose === 'note-image' ? noteImageBytes(input) : null;
    const attach = path.join(path.dirname(source), 'attachments');
    await fs.mkdir(attach, { recursive: true });
    if (image && !inside(path.dirname(source), await fs.realpath(attach))) throw new Error('附件文件夹指向笔记目录以外，已停止写入');
    const extension = image?.extension || String(input.extension || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
    const target = path.join(attach, `${Date.now()}-${crypto.randomUUID()}.${extension}`);
    await fs.writeFile(target, image?.bytes || Buffer.from(input.data), { flag: 'wx' });
    return path.relative(path.dirname(source), target).replace(/\\/g, '/');
  });
  handle('open-image', (_event, file) => openImage(store, shell, file));
  handle('asset-url', async (_event, file) => {
    const checked = await store.checked(file, { asset: true });
    return `reader-asset://local/${encodeURIComponent(checked)}`;
  });
  handle('make-anchor-path', async (_event, input) => {
    const from = await store.checked(input.fromFile);
    const to = await store.checked(input.toFile);
    const relative = path.relative(path.dirname(from), to);
    return path.isAbsolute(relative) ? to : relative.replace(/\\/g, '/');
  });
  handle('resolve-anchor-path', async (_event, input) => {
    const from = await store.checked(input.fromFile);
    const candidate = path.isAbsolute(input.storedPath) ? input.storedPath : path.resolve(path.dirname(from), input.storedPath);
    try {
      if (typeof input.epubId === 'string') return await ensureEpub(candidate, input.epubId);
      return await ensurePdf(candidate, input.pdfId);
    } catch { return null; }
  });
  handle('start-ocr', async (event, input) => {
    const { createWorker } = require('tesseract.js');
    const jobId = crypto.randomUUID();
    const requested = Array.isArray(input.languages) ? input.languages : ['chi_sim', 'eng'];
    const languages = requested.filter(language => ['chi_sim', 'chi_tra', 'eng'].includes(language));
    const job = { canceled: false, worker: null };
    jobs.set(jobId, job);
    event.sender.send('ocr-progress', { jobId, progress: 0, status: '正在准备识别' });
    void (async () => {
      try {
        job.worker = await createWorker(languages.join('+') || 'chi_sim+eng', 1, {
          langPath: ocrResourcePath(), gzip: true,
          logger: information => {
            if (!job.canceled && !event.sender.isDestroyed()) event.sender.send('ocr-progress', { jobId, progress: Number(information.progress || 0), status: information.status || '正在识别' });
          },
        });
        if (job.canceled) return;
        const result = await job.worker.recognize(Buffer.from(input.image));
        if (!job.canceled && !event.sender.isDestroyed()) event.sender.send('ocr-progress', { jobId, progress: 1, status: 'done', text: result.data.text || '' });
      } catch (error) {
        if (!job.canceled && !event.sender.isDestroyed()) event.sender.send('ocr-progress', { jobId, progress: 0, status: 'error', message: error.message || String(error) });
      } finally {
        try { await job.worker?.terminate(); } catch { /* already terminated */ }
        jobs.delete(jobId);
      }
    })();
    return { jobId };
  });
  handle('cancel-ocr', async (_event, jobId) => {
    const job = jobs.get(jobId);
    if (!job) return false;
    job.canceled = true;
    try { await job.worker?.terminate(); } catch { /* already terminated */ }
    jobs.delete(jobId);
    return true;
  });
}

function createWindow(settings = {}) {
  allowClose = false;
  quitRequested = false;
  const initialMinimumWidth = Math.floor(screen.getPrimaryDisplay().workAreaSize.width / 2);
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'app-constructivist.ico' : 'app-constructivist.png'),
    width: settings.window?.width || 1440, height: settings.window?.height || 920,
    show: false,
    minWidth: initialMinimumWidth, minHeight: 640,
    frame: false, thickFrame: true, roundedCorners: true, hasShadow: true,
    title: '左人笔记 · 阅读与思考', backgroundColor: '#f1f3f1',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const window = mainWindow;
  const scheduleWidthSync = () => scheduleWindowMinimumWidthSync(window);
  const syncChangedDisplay = (_event, display) => {
    if (screen.getDisplayMatching(window.getBounds()).id === display.id) scheduleWindowMinimumWidthSync(window);
  };
  window.on('move', scheduleWidthSync);
  window.on('moved', scheduleWidthSync);
  screen.on('display-metrics-changed', syncChangedDisplay);
  screen.on('display-added', scheduleWidthSync);
  screen.on('display-removed', scheduleWidthSync);
  window.once('closed', () => {
    clearTimeout(windowMinimumSyncTimer);
    screen.removeListener('display-metrics-changed', syncChangedDisplay);
    screen.removeListener('display-added', scheduleWidthSync);
    screen.removeListener('display-removed', scheduleWidthSync);
  });
  syncWindowMinimumWidth(window);
  withWindowDialog = installWindowFocus(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Native shortcut also works when focus is inside an EPUB iframe.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat && !input.control && !input.alt && !input.meta) {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:|^mailto:/i.test(url)) void shell.openExternal(url);
  });
  // On Windows the fullscreen event can precede isFullScreen() updating.
  // The event itself confirms the transition; do not publish an old getter.
  const sendWindowState = fullscreen => { if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('window-state', { ...windowState(mainWindow), ...(typeof fullscreen === 'boolean' ? { fullscreen } : {}) }); };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.on('enter-full-screen', () => sendWindowState(true));
  mainWindow.on('leave-full-screen', () => sendWindowState(false));
  // Establish the native window state before loading the renderer, so its
  // initial state query cannot race a later ready-to-show maximization.
  // Saved dimensions remain the normal bounds for the restore button.
  mainWindow.maximize();
  mainWindow.show();
  mainWindow.on('close', event => {
    if (allowClose) return;
    event.preventDefault();
    mainWindow.webContents.send('app-closing');
  });
  const developmentUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) mainWindow.loadURL(developmentUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

ipcMain.on('confirm-close', event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
  allowClose = true;
  mainWindow.close();
  if (quitRequested) app.quit();
});
app.on('before-quit', event => {
  if (process.platform !== 'darwin' || !mainWindow || mainWindow.isDestroyed() || allowClose) return;
  event.preventDefault();
  quitRequested = true;
  mainWindow.close(); // The existing renderer close/save gate owns confirmation.
});
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    void collectLaunchItems(commandLine.slice(1), workingDirectory).then(deliverLaunchItems);
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
      { role: 'appMenu', submenu: [
        { role: 'about' }, { type: 'separator' }, { role: 'services' },
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        // Explicitly route native Quit and Cmd+Q through before-quit's save gate.
        { id: 'quit-application', label: `退出 ${app.getName()}`, accelerator: 'Command+Q', click: () => app.quit() },
      ] }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]) : null);
    const settings = await restoreGrants().catch(() => emptySettings());
    await authorizeLaunchArgs();
    protocol.handle('reader-asset', async request => {
      try {
        const encoded = new URL(request.url).pathname.slice(1);
        const file = await store.checked(decodeURIComponent(encoded), { asset: true });
        return new Response(await fs.readFile(file), { headers: { 'Content-Type': mimeFor(file) } });
      } catch { return new Response('Not found', { status: 404 }); }
    });
    installHandlers();
    createWindow(settings);
    if (pendingMacFiles.length) void collectLaunchItems(pendingMacFiles.splice(0)).then(deliverLaunchItems).catch(console.error);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(settings); });
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
