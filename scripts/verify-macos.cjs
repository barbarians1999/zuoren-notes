const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { passed } = require('./release-support.cjs');
const root = path.resolve(__dirname,'..');
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function main() {
  const arch = process.argv[2];
  if(process.platform!=='darwin' || arch!==process.arch || !['arm64','x64'].includes(arch)) throw new Error('Verification requires the native matching Mac');
  const version=require('../package.json').version;
  const output=path.join(root,'releases/macos',arch);
  const app=path.join(output,arch==='arm64'?'mac-arm64':'mac','左人笔记.app');
  const name=`ZuorenNotes-${version}-macOS-${arch}.dmg`;
  const dmg=path.join(output,name);
  const info=path.join(app,'Contents/Info.plist');
  const plist=key=>execFileSync('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,info],{encoding:'utf8'}).trim();
  if(plist('CFBundleShortVersionString')!==version) throw new Error('Packaged app version mismatch');
  const executable=path.join(app,'Contents/MacOS',plist('CFBundleExecutable'));
  const binary=execFileSync('file',[executable],{encoding:'utf8'});
  if(!binary.includes(arch==='arm64'?'arm64':'x86_64')) throw new Error('Packaged CPU architecture mismatch');
  execFileSync('codesign',['--verify','--deep','--strict',app]);
  execFileSync('hdiutil',['verify',dmg],{stdio:'inherit'});
  const unit=await fs.readFile(path.join(root,'macos-unit.log'),'utf8');
  const smoke=await fs.readFile(path.join(root,'macos-smoke.log'),'utf8');
  const nativeUnitTests = passed(unit);
  if (passed(smoke) !== 2) throw new Error('Native tests did not finish with verified success');
  const report={version,architecture:arch,platform:'darwin',sourceCommit:process.env.GITHUB_SHA,nativeUnitTests,nativePackageSmoke:'passed',dmg:{name,bytes:(await fs.stat(dmg)).size,sha256:await hash(dmg)},appAsarSha256:await hash(path.join(app,'Contents/Resources/app.asar')),iconSourceSha256:await hash(path.join(root,'electron/assets/app-constructivist.png')),signing:'ad-hoc only; not Developer ID signed or notarized',workflowRun:process.env.GITHUB_RUN_ID,binary:binary.trim()};
  await fs.writeFile(path.join(output,`ZuorenNotes-${version}-macOS-${arch}-VALIDATION.json`),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
