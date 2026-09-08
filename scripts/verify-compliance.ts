import { mkdir, writeFile } from 'node:fs/promises';
import { loadEnvFile } from '../src/config/env.js';
import { loadCapability } from '../src/artifact/store.js';
import { replay } from '../src/replay/engine.js';
import { SecretVault } from '../src/policy/vault.js';
import { createChatBackend } from '../src/api/chat.js';
import { startApi } from '../src/api/server.js';
import { OpenAiProvider } from '../src/agent/llm/openai.js';
await loadEnvFile('.env');
const vault = SecretVault.fromEnvironment();
const rows: any[] = [];
const only = process.argv[2];
async function check(name: string, id: string, inputs: Record<string,unknown>, expected: string, useVault=vault) {
 if (only && only !== name) return;
 const result = await replay(await loadCapability(id), inputs, {vault:useVault,headless:true,baseUrl:'https://web-sample.interface-hiring.com',escalationTimeoutMs:1500,authorizeIrreversible:{by:'verification',reason:'User-approved synthetic contact validation tests'}});
 const code = result.status === 'business_outcome' ? result.outcome.code : result.status === 'success' ? 'success' : result.failure.declaredCode ?? result.failure.code;
 const passed = code === expected;
 rows.push({name,runId:result.runId,status:result.status,code,passed}); console.log(name,code,passed?'PASS':'FAIL');
}
await check('complete shares','member.list-shares',{memberId:'103001'},'success');
await check('invalid email','member.update-contact',{memberId:'103001',email:'invalid',phone:'4155550196',address:'130 Demo Street'},'INVALID_INPUT');
await check('invalid phone','member.update-contact',{memberId:'103001',email:'verified.member@example.net',phone:'abc',address:'130 Demo Street'},'INVALID_INPUT');
const badVault=SecretVault.forTesting(Object.fromEntries(vault.names().map(n=>[n,n==='meridianOperatorPass'?'deliberately-wrong-password':vault.get(n)])));
await check('bad login','session.sign-on',{branch:'WEST-014'},'AUTHENTICATION_FAILED',badVault);
if (!only || only === 'chat') {
 const api=await startApi({port:0,vault,chat:createChatBackend({provider:new OpenAiProvider(),invoke:{vault,headless:true,escalationTimeoutMs:1500}})});
 try {
  for (const [name,message,expected] of [['chat success','Use member_list_shares to read all shares for member 103001.','success'],['chat notfound','Search members by last name Zzyzx.','MEMBER_NOT_FOUND']]) {
   const response=await fetch(api.url+'/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message})});
   const body=await response.json();
   const invocations=body.invocations ?? (body.invoked?[body.invoked]:[]);
   const passed=invocations.some((i:any)=>expected==='success'?i.envelope.ok:i.envelope.outcome?.code===expected);
   rows.push({name,passed,invocations:invocations.map((i:any)=>({name:i.name,runId:i.envelope.runId,ok:i.envelope.ok,code:i.envelope.outcome?.code??i.envelope.error?.code}))});
   console.log(name,passed?'PASS':'FAIL');
  }
 } finally {await api.close();}
}
await mkdir('evidence/assignment-2/past-verifications',{recursive:true});
await writeFile(`evidence/assignment-2/past-verifications/compliance${only?'-'+only.replaceAll(' ','-'):''}.json`,JSON.stringify({checkedAt:new Date().toISOString(),rows},null,2));
process.exitCode=rows.every(r=>r.passed)?0:1;
