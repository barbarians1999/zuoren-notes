require('./typescript-loader.cjs');
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {MutationBarrier,sameOrDescendantPath}=require('../src/fileOperations.cjs');
const {filePathKey}=require('../src/pathIdentity.cjs');
let code,policy;
before(async()=>{
 const {transformWithOxc}=await import(pathToFileURL(require.resolve('vite')).href);
 code=(await transformWithOxc(fs.readFileSync(path.join(__dirname,'../src/workspace/fileMoveUi.tsx'),'utf8'),'fileMoveUi.tsx',{jsx:{runtime:'classic'}})).code
  .replace(/^import[^;]+;\n/gm,'').replace(/^export function /gm,'function ')+ '\nmodule.exports={useFileMoveUi};';
 policy=await import('../src/workspace/fileMove.ts');
});
const source={path:'/root-A/a.md',name:'a.md',relative:'a.md',type:'md',kind:'file',moveVersion:'listed'};
const target='/root-A/child/a.md';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function tree(node,rows=[]){if(Array.isArray(node))node.forEach(x=>tree(x,rows));else if(node&&typeof node==='object'){rows.push(node);tree(node.props?.children,rows);}return rows;}
function text(node){if(Array.isArray(node))return node.map(text).join('');return node&&typeof node==='object'?text(node.props?.children):String(node??'');}
function harness(overrides={}){
 let slots=[],at=0,effects=[],dirty=false,dead=false,lateUpdates=0,view;
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
 const hooks={useRef(value){const i=at++;return(slots[i]||={value:{current:value}}).value;},useState(value){const i=at++;if(!slots[i])slots[i]={value:typeof value==='function'?value():value};return[slots[i].value,next=>{if(dead){lateUpdates++;return;}const value=typeof next==='function'?next(slots[i].value):next;if(!Object.is(value,slots[i].value)){slots[i].value=value;dirty=true;}}];},useId(){return'ui-test-'+at++;},useEffect(effect,deps){const i=at++,old=slots[i];if(!old||!same(old.deps,deps))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:effect()};});}};
 const barrier=new MutationBarrier(),messages=[],calls=[],module={exports:{}};
 const api={pendingFileMove:async()=>null,fileMoveCapability:async()=>({supported:true}),finalizeFileMove:async()=>true,
  moveFile:async input=>{calls.push(input);return{ok:true,operationId:input.operationId,oldPath:source.path,entry:{...source,path:target},undoToken:'undo',recovered:true};},fileMoveStatus:async()=>({status:'unknown'}),...overrides};
 let options={root:'/root-A',directory:null,workspace:{committing:false,documents:new Map(),beginCommit:()=>()=>{},saveAll:async()=>true},readers:{flush:async()=>true,currentPdf:()=>null,currentEpub:()=>null},barrier,blocked:false,remap(){},persistSession:async()=>true,reload:async()=>{},message:value=>messages.push(value)};
 class El{constructor(){this.isConnected=true;}contains(node){return node===this;}focus(){}}
 const origin=new El(),window={setTimeout:()=>1,clearTimeout(){},addEventListener(){},removeEventListener(){}};
 vm.runInNewContext(code,{...hooks,module,reader:()=>api,...policy,parentPath:policy.fileMoveParent,sameOrDescendantPath,filePathKey,crypto:globalThis.crypto,window,document:{activeElement:origin,querySelector:()=>origin},HTMLElement:El,DialogFrame:'DialogFrame',ArrowLeft:'ArrowLeft',Folder:'Folder',FolderOpen:'FolderOpen',MoveRight:'MoveRight',Undo2:'Undo2',React:{Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}})}});
 function render(next={}){options={...options,...next};let round=0;do{assert.ok(round++<20);at=0;effects=[];dirty=false;view=module.exports.useFileMoveUi(options);effects.forEach(fn=>fn());}while(dirty);return view;}
 render();return{api,barrier,messages,calls,render,get view(){return view;},get lateUpdates(){return lateUpdates;},async settle(){for(let i=0;i<8;i++){await Promise.resolve();render();}return view;},unmount(){dead=true;slots.forEach(slot=>slot?.cleanup?.());}};
}
test('mount waits for pending lookup and root switches cannot discard a restored operation or its two pins',async()=>{
 const pending=deferred(),h=harness({pendingFileMove:()=>pending.promise});assert.equal(h.view.entryProps(source).draggable,false);await h.view.open(source,'/root-A/child');assert.equal(tree(h.view.dialogs).some(n=>n.props?.source),false);
 h.render({root:'/root-B'});pending.resolve({operationId:'restart',oldPath:source.path,targetPath:target,message:'durable pending'});await h.settle();const recovery=tree(h.view.dialogs).find(n=>n.props?.issue);assert.equal(recovery.props.issue.operationId,'restart');assert.equal(h.barrier.has(source.path,Date.now()+3600_000),true);assert.equal(h.barrier.has(target,Date.now()+3600_000),true);assert.equal(h.view.entryProps({...source,path:'/root-B/b.md'}).draggable,false);
 h.render({root:'/root-C'});assert.equal(tree(h.view.dialogs).find(n=>n.props?.issue).props.issue.operationId,'restart');h.unmount();
});
test('dropping an internal file on a valid folder moves once without opening a second folder picker',async()=>{
 const h=harness();await h.settle();const values=new Map();
 const dataTransfer={types:[],clearData(){values.clear();this.types=[];},setData(k,v){values.set(k,v);this.types.push(k);},getData:k=>values.get(k)||''};
 const event={dataTransfer,preventDefault(){},stopPropagation(){}};
 h.view.entryProps(source).onDragStart(event);h.render();h.view.targetProps('/root-A/child').onDrop(event);
 await h.settle();await h.settle();
 assert.equal(h.calls.length,1,'drop reaches the existing save/move/finalize coordinator');assert.equal(h.calls[0].directory,'/root-A/child');
 assert.equal(tree(h.view.dialogs).some(n=>n.props?.source),false,'the explicit drop target does not require another folder selection');h.unmount();
});
test('a forged drag token cannot dispatch a direct move',async()=>{
 const h=harness();await h.settle();const dataTransfer={types:[],clearData(){this.types=[];},setData(k){this.types.push(k);},getData:()=> 'forged'};
 const event={dataTransfer,preventDefault(){},stopPropagation(){}};h.view.entryProps(source).onDragStart(event);h.render();h.view.targetProps('/root-A/child').onDrop(event);
 await h.settle();assert.equal(h.calls.length,0);h.unmount();
});
test('failed startup lookup stays visible and blocks moves across root changes until explicit retry succeeds',async()=>{
 const h=harness({pendingFileMove:async()=>{throw Error('journal read unavailable');}});await h.settle();assert.match(text(h.view.panel),/journal read unavailable/);assert.equal(h.view.entryProps(source).draggable,false);h.render({root:'/root-B'});assert.match(text(h.view.panel),/暂停新的文件移动/);
 h.api.pendingFileMove=async()=>null;const retry=tree(h.view.panel).find(n=>n.type==='button'&&text(n).includes('重试核对'));assert.ok(retry);retry.props.onClick();await h.settle();assert.equal(h.view.entryProps({...source,path:'/root-B/b.md'}).draggable,true);assert.doesNotMatch(text(h.view.panel),/journal read unavailable/);h.unmount();
});
test('a durable finished recheck clears the recovery dialog only after finalize succeeds and uses honest recovered wording',async()=>{
 const issue={operationId:'restart',oldPath:source.path,targetPath:target,message:'await finalize'},result={ok:true,operationId:'restart',oldPath:source.path,entry:{...source,path:target},undoToken:'',recovered:true};let finalized=false;
 const h=harness({pendingFileMove:async()=>issue,fileMoveStatus:async()=>({status:'finished',result}),finalizeFileMove:async()=>finalized});await h.settle();let recovery=tree(h.view.dialogs).find(n=>n.props?.issue);await recovery.props.onCheck(false);await h.settle();assert.ok(tree(h.view.dialogs).find(n=>n.props?.issue));assert.equal(h.barrier.pins.size,2);
 finalized=true;recovery=tree(h.view.dialogs).find(n=>n.props?.issue);await recovery.props.onCheck(false);await h.settle();assert.equal(tree(h.view.dialogs).some(n=>n.props?.issue),false);assert.equal(h.barrier.pins.size,0);assert.match(h.messages.at(-1),/上次未能打开的标签可从目标目录重新打开，恢复引用仍保留/);assert.doesNotMatch(h.messages.at(-1),/原标签已全恢复/);h.unmount();
});
test('a verified pre-commit failure clears the old recovery dialog as well as coordinator pins',async()=>{
 const h=harness({pendingFileMove:async()=>({operationId:'restart',oldPath:source.path,targetPath:target,message:'pending'}),fileMoveStatus:async()=>({status:'failed',error:'verified no commit'})});await h.settle();await tree(h.view.dialogs).find(n=>n.props?.issue).props.onCheck(false);await h.settle();assert.equal(tree(h.view.dialogs).some(n=>n.props?.issue),false);assert.equal(h.barrier.pins.size,0);assert.equal(h.view.entryProps(source).draggable,true);h.unmount();
});
test('UI passes the fresh session callback to the real coordinator before submission',async()=>{
 const h=harness();let persisted=0;h.render({persistSession:async()=>{persisted++;return false;}});await h.settle();await h.view.open(source,'/root-A/child');h.render();const proposal=tree(h.view.dialogs).find(n=>n.props?.source);assert.ok(proposal);assert.equal(await proposal.props.onConfirm('/root-A/child'),false);await h.settle();assert.equal(persisted,1);assert.equal(h.calls.length,0);assert.match(h.messages.at(-1),/当前工作现场尚未持久保存/);h.unmount();
});
test('an unmounted pending lookup cannot update hook state but still restores safety pins',async()=>{
 const pending=deferred(),h=harness({pendingFileMove:()=>pending.promise});h.unmount();pending.resolve({operationId:'late',oldPath:source.path,targetPath:target,message:'late durable issue'});for(let i=0;i<8;i++)await Promise.resolve();assert.equal(h.lateUpdates,0);assert.equal(h.barrier.has(source.path),true);assert.equal(h.barrier.has(target),true);
});

test('a restored pending operation from another root cannot install an undo receipt in the current root',async()=>{
 const issue={operationId:'root-A-restart',oldPath:source.path,targetPath:target,message:'root A pending'},result={ok:true,operationId:issue.operationId,oldPath:source.path,entry:{...source,path:target},undoToken:'A-only-undo',recovered:true};
 const h=harness({pendingFileMove:async()=>issue,fileMoveStatus:async()=>({status:'finished',result})});await h.settle();let reloads=0;h.render({root:'/root-B',reload:async()=>{reloads++;}});await tree(h.view.dialogs).find(n=>n.props?.issue).props.onCheck(false);await h.settle();assert.equal(tree(h.view.dialogs).some(n=>n.props?.issue),false);assert.doesNotMatch(text(h.view.panel),/撤销移动|已移动/);assert.equal(reloads,0);assert.ok(h.messages.at(-1).includes(source.path));assert.ok(h.messages.at(-1).includes(target));assert.match(h.messages.at(-1),/此处不提供撤销/);assert.doesNotMatch(h.messages.at(-1),/可撤销/);assert.equal(h.barrier.pins.size,0);h.unmount();
});
