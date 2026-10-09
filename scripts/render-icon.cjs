// Run with Electron. Generates PNG and a multi-resolution Windows ICO from
// the editable vector master; no network, signing, or installed-app changes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const output = path.join(__dirname, '..', 'electron', 'assets');
  // Optional sibling candidate names keep the shipping icon untouched.
  const source = path.basename(process.argv[2] || 'notebook-pencil.svg');
  const stem = path.basename(process.argv[3] || 'app');
  const svg = await fs.readFile(path.join(output, source), 'utf8');
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{width:100%;height:100%;display:block}</style>' + svg));
  // Wait for the offscreen compositor, not just the HTML load event.
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(output, stem + '.png'), image.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  sizes.forEach((size, index) => {
    const start = 6 + index * 16;
    directory[start] = directory[start + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, start + 4); directory.writeUInt16LE(32, start + 6);
    directory.writeUInt32LE(frames[index].length, start + 8); directory.writeUInt32LE(offset, start + 12);
    offset += frames[index].length;
  });
  await fs.writeFile(path.join(output, stem + '.ico'), Buffer.concat([directory, ...frames]));
  await fs.writeFile(path.join(output, stem + '-32.png'), frames[sizes.indexOf(32)]);
  window.destroy(); console.log(`ICON_OK: ${stem}.png + ${stem}.ico (16/24/32/48/64/128/256)`); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
