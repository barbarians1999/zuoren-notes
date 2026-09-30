const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const workRoot = path.join(root, 'work');
const staging = path.join(workRoot, `installer-${Date.now()}`);
const output = process.env.ZHAOYE_INSTALLER_OUTPUT
  ? path.resolve(process.env.ZHAOYE_INSTALLER_OUTPUT)
  : path.resolve(root, '..', '..', 'Documents', 'Codex', '2026-09-05', 'bang-w', 'outputs', '左人笔记-Windows-Setup');

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
    } catch { /* keep searching upward */ }
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
    recursive: true,
    dereference: true,
    filter: source => !path.relative(directory, source).split(path.sep).includes('node_modules'),
  });
  const chain = new Set([...ancestors, identity]);
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    await copyRuntime(dependency, directory, destination, chain);
  }
}

async function runBuilder() {
  const cli = require.resolve('electron-builder/out/cli/cli.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--projectDir', staging, '--win', 'nsis', '--x64'], {
      cwd: root,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`electron-builder exited with code ${code}`)));
  });
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const electron = await packageRoot('electron', root);
  await fs.mkdir(path.join(staging, 'src'), { recursive: true });
  await fs.cp(path.join(root, 'electron'), path.join(staging, 'electron'), { recursive: true });
  await fs.cp(path.join(root, 'dist'), path.join(staging, 'dist'), { recursive: true });
  await fs.copyFile(path.join(root, 'src', 'sessionState.cjs'), path.join(staging, 'src', 'sessionState.cjs'));
  await copyRuntime('tesseract.js', root, staging);
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({
    name: manifest.name,
    productName: manifest.productName,
    version: manifest.version,
    description: manifest.description,
    main: manifest.main,
    dependencies: { 'tesseract.js': manifest.dependencies['tesseract.js'] },
    build: {
      ...manifest.build,
      electronVersion: electron.manifest.version,
      files: [...manifest.build.files, 'node_modules/**/*'],
      directories: { output },
    },
  }, null, 2));
  await runBuilder();
  console.log(`Installer: ${path.join(output, `左人笔记-Setup-${manifest.version}.exe`)}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  const relative = path.relative(workRoot, staging);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    await fs.rm(staging, { recursive: true, force: true });
  }
});
