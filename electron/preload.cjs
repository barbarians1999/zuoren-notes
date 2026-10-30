const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, value) => ipcRenderer.invoke(channel, value);
const pendingLaunchItems = [];
const launchListeners = new Set();
ipcRenderer.on('open-launch-items', (_event, items) => {
  if (launchListeners.size) launchListeners.forEach(listener => listener(items));
  else pendingLaunchItems.push(items);
});
const api = {
  getLaunchItems: () => invoke('get-launch-items'),
  listWorkspace: root => invoke('list-workspace', root),
  listDirectory: input => invoke('list-directory', input),
  chooseWorkspace: () => invoke('choose-workspace'),
  chooseFiles: () => invoke('choose-files'),
  chooseRelocation: input => invoke('choose-relocation', input),
  chooseEpubRelocation: input => invoke('choose-epub-relocation', input),
  showItemInFolder: file => invoke('show-item-in-folder', file),
  createNoteAt: input => invoke('create-note-at', input),
  createFolderAt: input => invoke('create-folder-at', input),
  renameEntry: input => invoke('rename-entry', input),
  trashEntry: file => invoke('trash-entry', file),
  createNote: input => invoke('create-note', input),
  saveAs: input => invoke('save-as', input),
  readNote: file => invoke('read-note', file),
  saveNote: input => invoke('save-note', input),
  noteHistory: file => invoke('note-history', file),
  writeRecovery: input => invoke('write-recovery', input),
  checkRecovery: input => invoke('check-recovery', input),
  deleteRecovery: input => invoke('delete-recovery', input),
  openPdf: file => invoke('open-pdf', file),
  savePdfMeta: input => invoke('save-pdf-meta', input),
  openEpub: file => invoke('open-epub', file),
  saveEpubMeta: input => invoke('save-epub-meta', input),
  saveAttachment: input => invoke('save-attachment', input),
  openImage: file => invoke('open-image', file),
  openMarkdownLink: input => invoke('open-markdown-link', input),
  search: input => invoke('search', input),
  getSettings: () => invoke('get-settings'),
  getWindowState: () => invoke('get-window-state'),
  windowControl: action => invoke('window-control', action),
  updateSettings: input => invoke('update-settings', input),
  saveSession: session => invoke('save-session', session),
  assetUrl: file => invoke('asset-url', file),
  makeAnchorPath: input => invoke('make-anchor-path', input),
  resolveAnchorPath: input => invoke('resolve-anchor-path', input),
  startOcr: input => invoke('start-ocr', input),
  cancelOcr: jobId => invoke('cancel-ocr', jobId),
  onOcrProgress: listener => {
    const wrapped = (_event, progress) => listener(progress);
    ipcRenderer.on('ocr-progress', wrapped);
    return () => ipcRenderer.removeListener('ocr-progress', wrapped);
  },
  onAppClosing: listener => {
    const wrapped = () => listener();
    ipcRenderer.on('app-closing', wrapped);
    return () => ipcRenderer.removeListener('app-closing', wrapped);
  },
  onOpenLaunchItems: listener => {
    launchListeners.add(listener);
    while (pendingLaunchItems.length) listener(pendingLaunchItems.shift());
    return () => launchListeners.delete(listener);
  },
  onWindowState: listener => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on('window-state', wrapped);
    return () => ipcRenderer.removeListener('window-state', wrapped);
  },
  confirmClose: () => ipcRenderer.send('confirm-close'),
};
contextBridge.exposeInMainWorld('reader', api);
