const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { releaseDirectory } = require('./release-paths.cjs');

const root = path.resolve(__dirname, '..');
const staging = path.join(root, 'work', `package-${Date.now()}`);
const output = releaseDirectory(root, process.env.ZHAOYE_PACKAGE_OUTPUT);

async function packageRoot(name, from) {
  const localRequire = createRequire(path.join(from, 'package.json'));
  let entry;
  try { entry = localRequire.resolve(`${name}/package.json`); }
  catch { entry = localRequire.resolve(name); }
  let directory = path.dirname(await fs.realpath(entry));
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return { directory, manifest };
    } catch { /* search up from the resolved entry */ }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate installed package ${name}`);
}

async function copyRuntime(name, from, destination, ancestors = new Set()) {
  const { directory, manifest } = await packageRoot(name, from);
  const identity = `${name}@${manifest.version}`;
  if (ancestors.has(identity)) return;
  const target = path.join(destination, 'node_modules', name);
  await fs.cp(directory, target, {
    recursive: true, dereference: true,
    filter: source => !path.relative(directory, source).split(path.sep).includes('node_modules'),
  });
  const chain = new Set([...ancestors, identity]);
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    await copyRuntime(dependency, directory, target, chain);
  }
}

async function findZip(directory, name) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) { const found = await findZip(file, name); if (found) return found; }
    else if (item.name === name) return file;
  }
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const electron = await packageRoot('electron', root);
  const zip = await findZip(path.join(root, '.electron-cache'), `electron-v${electron.manifest.version}-win32-x64.zip`);
  if (!zip) throw new Error('The cached Windows Electron archive is missing.');
  await fs.mkdir(staging, { recursive: true });
  await fs.cp(path.join(root, 'electron'), path.join(staging, 'electron'), { recursive: true });
  await fs.cp(path.join(root, 'dist'), path.join(staging, 'dist'), { recursive: true });
  await fs.mkdir(path.join(staging, 'src'), { recursive: true });
  await fs.copyFile(path.join(root, 'src', 'sessionState.cjs'), path.join(staging, 'src', 'sessionState.cjs'));
  await fs.copyFile(path.join(root, 'src', 'pathIdentity.cjs'), path.join(staging, 'src', 'pathIdentity.cjs'));
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({
    name: manifest.name, productName: manifest.productName, version: manifest.version,
    description: manifest.description, main: manifest.main,
    dependencies: { 'tesseract.js': manifest.dependencies['tesseract.js'] },
  }, null, 2));
  // The renderer is bundled by Vite. Only the OCR worker needs Node packages.
  await copyRuntime('tesseract.js', root, staging);
  const { packager } = await import('@electron/packager');
  const result = await packager({
    icon: path.resolve(root, manifest.build.win.icon),
    dir: staging, name: 'ZuorenNotes', platform: 'win32', arch: 'x64',
    electronVersion: electron.manifest.version, electronZipDir: path.dirname(zip),
    out: output, overwrite: true, prune: false,
  });
  const keptLocales = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
  let removedLocaleBytes = 0;
  let removedLocaleCount = 0;
  for (const packagedDirectory of result) {
    const localesDirectory = path.join(packagedDirectory, 'locales');
    for (const entry of await fs.readdir(localesDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || keptLocales.has(entry.name)) continue;
      const localePath = path.join(localesDirectory, entry.name);
      removedLocaleBytes += (await fs.stat(localePath)).size;
      await fs.rm(localePath);
      removedLocaleCount += 1;
    }
  }
  console.log(`Locales: kept ${[...keptLocales].join(', ')}, removed ${removedLocaleCount} unused files (${(removedLocaleBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Packaged: ${result.join(', ')}`);
  const relative = path.relative(path.join(root, 'work'), staging);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(staging, { recursive: true, force: true });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
