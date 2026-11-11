// Harmless process-boundary fixture. The parent supplies only its new TEMP root.
const fs=require('node:fs/promises');const path=require('node:path');const {connect}=require('../helpers/move-transaction-fixture.cjs');
(async()=>{const f=JSON.parse(await fs.readFile(process.argv[2],'utf8')),mode=process.argv[3],c=await connect(f);
 if(mode==='empty')c.native.move=async()=>{throw Object.assign(Error('fixture before delivery'),{code:'MOVE_UNCERTAIN'});};
 if(mode==='partial')c.native.move=async request=>{await fs.rename(request.Source,request.Target);throw Object.assign(Error('fixture abrupt worker loss'),{code:'MOVE_UNCERTAIN'});};
 if(mode==='refused')c.native.move=async request=>{await fs.writeFile(request.Target,'foreign occupant',{flag:'wx'});throw Error('fixture no-replace refusal');};
 try{await c.moves.move(c.input);}catch{}
 await fs.writeFile(path.join(f.base,'operation-id.txt'),c.input.operationId);process.exit(23);
})().catch(error=>{console.error(error.stack);process.exit(99);});
