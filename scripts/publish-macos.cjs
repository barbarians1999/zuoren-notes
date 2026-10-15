const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { releaseForTag, checkPublication } = require('./release-support.cjs');
const repository=process.env.GITHUB_REPOSITORY;
const tag=process.env.RELEASE_TAG;
const token=process.env.GH_TOKEN;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function api(endpoint,method='GET',body) {
  const response=await fetch(`https://api.github.com/repos/${repository}/${endpoint}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
  if(!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0,500)}`);
  return response.json();
}
async function walk(directory) {
  const items=await fs.readdir(directory,{withFileTypes:true});
  return (await Promise.all(items.map(item=>item.isDirectory()?walk(path.join(directory,item.name)):path.join(directory,item.name)))).flat();
}
async function main() {
  const version=require('../package.json').version;
  if(!repository || !token || tag!==`v${version}` || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Missing publication context or mismatched tag');
  const directory=path.resolve(process.argv[2]);
  const files=await walk(directory);
  const downloads=[];
  for(const arch of ['arm64','x64']) {
    const name=`ZuorenNotes-${version}-macOS-${arch}.dmg`;
    const reports=files.filter(file=>path.basename(file)===`ZuorenNotes-${version}-macOS-${arch}-VALIDATION.json`);
    const packages=files.filter(file=>path.basename(file)===name);
    if(reports.length!==1 || packages.length!==1) throw new Error('Missing/duplicate verified assets for '+arch);
    const report=JSON.parse(await fs.readFile(reports[0],'utf8'));
    const digest=sha256(await fs.readFile(packages[0]));
    if(report.version!==version || report.platform!=='darwin' || report.architecture!==arch || report.sourceCommit!==process.env.GITHUB_SHA || report.nativePackageSmoke!=='passed' || report.dmg.name!==name || report.dmg.sha256!==digest) throw new Error('Mac validation does not match '+name);
    downloads.push({file:packages[0],name,sha256:digest},{file:reports[0],name:path.basename(reports[0]),sha256:sha256(await fs.readFile(reports[0]))});
  }
  const checksumName=`macOS-SHA256SUMS-${version}.txt`;
  const checksumFile=path.join(directory,checksumName);
  const checksumText=downloads.filter(item=>item.name.endsWith('.dmg')).map(item=>`${item.sha256}  ${item.name}`).join('\n')+'\n';
  await fs.writeFile(checksumFile,checksumText);
  downloads.push({file:checksumFile,name:checksumName,sha256:sha256(Buffer.from(checksumText))});
  const release=await releaseForTag(api,tag);
  if (!release) throw new Error('Create the Windows release draft first');
  const windows=release.assets.filter(asset=>!asset.name.includes('macOS')).map(asset=>({id:asset.id,name:asset.name,size:asset.size,digest:asset.digest}));
  for(const item of downloads) {
    const existing=release.assets.find(asset=>asset.name===item.name);
    if(existing) {
      if(existing.digest===`sha256:${item.sha256}`) {console.log('Already uploaded and identical: '+item.name);continue;}
      throw new Error('Existing release asset differs; refusing to overwrite '+item.name);
    }
    execFileSync('gh',['release','upload',tag,item.file,'--repo',repository],{stdio:'inherit'});
  }
  const start='<!-- macos-downloads -->',end='<!-- /macos-downloads -->';
  const note=`${start}\n\n## macOS 测试版\n\n- Apple 芯片（M1 及更新）：\`ZuorenNotes-${version}-macOS-arm64.dmg\`\n- Intel Mac：\`ZuorenNotes-${version}-macOS-x64.dmg\`\n- 两个包均在对应架构的 macOS 环境构建，并通过单元测试、实际包内 Markdown 保存/撤销、PDF/EPUB 读取、文件打开和重启恢复检查。\n- 仅做 ad-hoc 完整性签名，**未提供 Apple Developer ID 签名或公证**；首次打开可能被系统拦截。只从可信来源下载，在“系统设置 → 隐私与安全性”中核对后允许打开。\n- 字体仍依赖本机安装；汉仪书仿 55W 不随包提供。\n- 本次补充 Mac 平台，不替换 Windows 安装包。构建源码：\`${process.env.GITHUB_SHA}\`。\n- Mac 校验值见 \`${checksumName}\`，定向验证范围见对应 \`VALIDATION.json\`；不声称已完成完整 Mac 发布回归。\n\n${end}`;
  const original=release.body||'';
  const begin=original.indexOf(start),finish=original.indexOf(end);
  const body=begin>=0&&finish>=begin ? original.slice(0,begin)+note+original.slice(finish+end.length) : original+'\n\n'+note;
  await api(`releases/${release.id}`,'PATCH',{body});
  const final=await api(`releases/${release.id}`);
  for(const previous of windows) {
    const asset=final.assets.find(item=>item.id===previous.id);
    if(!asset || asset.name!==previous.name || asset.size!==previous.size || asset.digest!==previous.digest) throw new Error('Windows asset changed unexpectedly');
  }
  for(const item of downloads) if(final.assets.find(asset=>asset.name===item.name)?.digest!==`sha256:${item.sha256}`) throw new Error('Uploaded asset digest mismatch: '+item.name);
  await checkPublication(api, { releaseId: release.id, tag, sourceCommit: process.env.GITHUB_SHA,
    publicRelease: !final.draft,
    assets: [...windows, ...await Promise.all(downloads.map(async item => ({ name: item.name, size: (await fs.stat(item.file)).size, digest: `sha256:${item.sha256}` })))] });
  console.log('Published verified Mac packages: '+final.html_url);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
