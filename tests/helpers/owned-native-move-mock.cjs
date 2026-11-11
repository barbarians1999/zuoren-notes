// Contract mock for Node orchestration tests only. It operates solely in the
// caller's newly created fixture. This does NOT emulate/prove Windows atomicity.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const id = stat => [stat.dev,stat.ino].join(':');
const within = (root,file) => { const relative=path.relative(root,file);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative); };
function ownedNativeMoveMock(base, requests=[]) {
  let work;
  const native={active:false,capability:async()=>({supported:true}),readReceipt:async input=>{
    assert.ok(within(base,input.ReceiptPath)); const receipt=JSON.parse(await fs.readFile(input.ReceiptPath,'utf8'));
    assert.equal(receipt.schema,2);assert.equal(receipt.operationId,input.OperationId);assert.equal(receipt.nonce,input.ReceiptNonce);assert.equal(receipt.binding,input.RequestBinding);return receipt.result;
  }};
  work=async request=>{
    requests.push(request);assert.ok(within(base,request.Source)&&within(base,request.Target));
    await assert.rejects(fs.lstat(request.Target),{code:'ENOENT'});
    // The fixture has no concurrent writers. Native no-replace is tested separately.
    await fs.rename(request.Source,request.Target);
    for(const record of request.Records){const target=path.join(path.dirname(request.Target),'.reader',...record.Relative.split(/[\\/]/));await fs.mkdir(path.dirname(target),{recursive:true});
      const bytes=Buffer.from(record.NextBase64,'base64');try{await fs.writeFile(target,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;assert.deepEqual(await fs.readFile(target),bytes);}}
    return {status:'moved',identity:request.ExpectedIdentity,hash:request.ExpectedHash};
  };
  Object.defineProperty(native,'move',{get:()=>{const perform=work;return async request=>{
    assert.ok(within(base,request.ReceiptPath));const before=await fs.stat(request.ReceiptPath,{bigint:true});assert.equal(id(before),request.ReceiptIdentity);assert.equal(before.size,0n);
    let result;
    try { result=await perform(request); }
    catch(error){if(error.code==='MOVE_UNCERTAIN')throw error;
      const target=await fs.stat(request.Target,{bigint:true}).catch(()=>null);result={status:target&&id(target)===request.ExpectedIdentity?'uncertain':'failed',error:'mock-native-refusal'};}
    await fs.writeFile(request.ReceiptPath,JSON.stringify({schema:2,operationId:request.OperationId,nonce:request.ReceiptNonce,binding:request.RequestBinding,result}));
    if(result.status!=='moved')throw Object.assign(Error(result.error),{code:result.status==='uncertain'?'MOVE_UNCERTAIN':'MOCK_DECLINED'});
    return result;
  };},set:value=>{work=value;}});
  return native;
}
module.exports={ownedNativeMoveMock};
