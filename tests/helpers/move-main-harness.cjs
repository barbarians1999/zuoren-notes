// Executes main.cjs with a fake Electron API; never loads or launches Electron.
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {createRequire}=require('node:module');
function mainHarness(base,{singleInstance=false}={}){
 const root=path.resolve(__dirname,'../..'),filename=path.join(root,'electron/main.cjs'),localRequire=createRequire(filename),handlers=new Map(),events=[],calls=[];
 const paths={appData:base,userData:path.join(base,'profile')},appEvents=new Map();let ready;
 const app={setPath:(name,value)=>paths[name]=value,getPath:name=>paths[name],setName(){},getName:()=> 'fixture',getVersion:()=> '0.4.0',getAppPath:()=>root,isPackaged:false,disableHardwareAcceleration(){},commandLine:{appendSwitch(){}},on:(name,callback)=>appEvents.set(name,callback),requestSingleInstanceLock:()=>singleInstance,quit(){},whenReady:()=>({then:callback=>{ready=callback;}})};
 const frame={},contents={mainFrame:frame},window={webContents:contents};
 const electron={app,BrowserWindow:{getAllWindows:()=>[]},dialog:{},ipcMain:{on(){},handle:(name,fn)=>handlers.set(name,fn)},protocol:{registerSchemesAsPrivileged(){},handle(){}},Menu:{setApplicationMenu(){},buildFromTemplate:()=>[]},shell:{showItemInFolder:file=>calls.push(['show',file]),trashItem:async file=>calls.push(['trash',file])},screen:{}};
 const module={exports:{}};const context=vm.createContext({require:name=>name==='electron'?electron:localRequire(name),module,exports:module.exports,__dirname:path.dirname(filename),__filename:filename,process:{env:{ZHAOYE_TEST_USER_DATA:paths.userData},platform:process.platform,argv:[process.execPath],cwd:()=>root},console,setTimeout,clearTimeout,Buffer,URL,Response,queueMicrotask});
 vm.runInContext(fs.readFileSync(filename,'utf8')+'\nmodule.exports={store,fileMoves,settingsStore,installHandlers,restoreGrants,setTestDialog(callback){withWindowDialog=callback;},setTestWindow(value){mainWindow=value;},setCreateWindow(callback){createWindow=callback;}};',context,{filename});
 const result=module.exports;result.setTestWindow(window);result.installHandlers();
 return {...result,handlers,calls,events,paths,async call(name,...args){return handlers.get(name)({sender:contents,senderFrame:frame},...args);},async start(){result.setCreateWindow(settings=>events.push({kind:'window',settings}));await ready();}};
}
module.exports={mainHarness};
