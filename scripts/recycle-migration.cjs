// Narrow native recycle helper. Only a hash-verified target in the migration
// receipt is accepted; Electron shell.trashItem never substitutes a hard delete.
const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'work', 'migration-shell-data'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const [receipt, source] = process.argv.slice(2);
  if (!receipt || !source) throw Error('Missing explicit migration receipt/target');
  const audit = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const target = audit.Targets.find(item => item.Source === source);
  const relative = path.relative(audit.OldRoot, source);
  if (path.resolve(audit.NewRoot).toLowerCase() !== root.toLowerCase() || !relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !target || target.Status !== 'copied-and-hash-verified' || !fs.existsSync(target.Destination)) throw Error('Unverified migration target');
  await shell.trashItem(source);
}).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => app.quit());
