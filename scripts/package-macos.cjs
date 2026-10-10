const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const architecture = process.argv[2] || process.arch;
const output = path.join(root, 'releases', 'macos', architecture);

async function packageRoot(name, from) {
  const localRequire = createRequire(path.join(from, 'package.json'));
  let entry;
  try { entry = localRequire.resolve(`${name}/package.json`); } catch { entry = localRequire.resolve(name); }
  let directory = path.dirname(await fs.realpath(entry));
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return { directory, manifest };
    } catch { /* Continue to the owning package. */ }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot find runtime package ${name}`);
}

async function copyRuntime(name, from, destination, ancestors = new Set()) {
  const { directory, manifest } = await packageRoot(name, from);
  const identity = `${name}@${manifest.version}`;
  if (ancestors.has(identity)) return;
  const target = path.join(destination, 'node_modules', name);
  await fs.cp(directory, target, {recursive:true,dereference:true,filter:source=>!path.relative(directory,source).split(path.sep).includes('node_modules')});
  const chain = new Set([...ancestors, identity]);
  for (const dependency of Object.keys(manifest.dependencies || {})) await copyRuntime(dependency, directory, target, chain);
}

async function createIcon(staging) {
  const iconset = path.join(staging, 'app.iconset');
  await fs.mkdir(iconset);
  const source = path.join(root, 'electron/assets/app-constructivist.png');
  for (const size of [16,32,128,256,512]) for (const scale of [1,2]) {
    execFileSync('sips', ['-z',String(size*scale),String(size*scale),source,'--out',path.join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`)],{stdio:'ignore'});
  }
  const icon = path.join(staging, 'electron/assets/app-constructivist.icns');
  execFileSync('iconutil',['-c','icns',iconset,'-o',icon]);
  return icon;
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Build macOS packages on the native GitHub macOS runner, not on the Windows workstation.');
  if (!['arm64','x64'].includes(architecture) || architecture !== process.arch) throw new Error('Use a native runner matching the requested architecture.');
  const manifest = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const electron = await packageRoot('electron', root);
  await fs.mkdir(path.join(root,'work'),{recursive:true});
  const staging = await fs.mkdtemp(path.join(root,'work','macos-'));
  for (const directory of ['electron','dist']) await fs.cp(path.join(root,directory),path.join(staging,directory),{recursive:true});
  await fs.mkdir(path.join(staging,'src'));
  for (const file of ['sessionState.cjs','pathIdentity.cjs']) await fs.copyFile(path.join(root,'src',file),path.join(staging,'src',file));
  await copyRuntime('tesseract.js',root,staging);
  await fs.writeFile(path.join(staging,'package.json'),JSON.stringify({name:manifest.name,productName:manifest.productName,version:manifest.version,description:manifest.description,main:manifest.main,dependencies:{'tesseract.js':manifest.dependencies['tesseract.js']}},null,2));
  const icon = await createIcon(staging);
  const { build, Platform, Arch } = require('electron-builder');
  await build({projectDir:staging,targets:Platform.MAC.createTarget(['dmg'],architecture==='arm64'?Arch.arm64:Arch.x64),config:{
    appId:manifest.build.appId,productName:manifest.productName,asar:true,npmRebuild:false,electronVersion:electron.manifest.version,
    files:[...manifest.build.files,'node_modules/**/*'],directories:{output},fileAssociations:manifest.build.fileAssociations,
    mac:{icon,category:'public.app-category.productivity',identity:null,hardenedRuntime:false,gatekeeperAssess:false,artifactName:'ZuorenNotes-${version}-macOS-${arch}.${ext}'},
    dmg:{sign:false},
    afterPack:async context=>{
      const app=path.join(context.appOutDir,`${manifest.productName}.app`);
      // Ad-hoc signing satisfies Apple Silicon executable integrity, but is
      // not Developer ID signing or notarization and must not be presented as such.
      execFileSync('codesign',['--force','--deep','--sign','-',app],{stdio:'inherit'});
      execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
    },
  }});
  console.log(`MACOS_PACKAGE_OUTPUT=${output}`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
