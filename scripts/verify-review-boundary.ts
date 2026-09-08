/** Reach live review screens, inspect the outgoing payload, and abort every final post locally. */
import { mkdir, writeFile } from 'node:fs/promises';
import { loadEnvFile } from '../src/config/env.js';
import { loadCapability } from '../src/artifact/store.js';
import { profileFor } from '../src/artifact/product-profiles.js';
import { checkTransaction } from '../src/policy/transaction.js';
import { SecretVault } from '../src/policy/vault.js';
import { replay } from '../src/replay/engine.js';
await loadEnvFile('.env');
const rows=[];
const cases: [string,Record<string,unknown>][]=[
 ['member.open-share',{memberId:'103001',shareType:'MMKT',initialDeposit:25}],
 ['member.place-hold',{memberId:'103001',shareId:'103001-MMKT-13',reason:'LEGAL',notes:''}],
 ['member.transfer-funds',{memberId:'103001',fromShare:'103001-MMKT-14',toShare:'103001-MMKT-13',amount:1,memo:''}],
];
for(const [id,inputs] of cases){
 const cap=await loadCapability(id);let checked=false;let violation:string|undefined;
 const result=await replay(cap,inputs,{baseUrl:'https://web-sample.interface-hiring.com',vault:SecretVault.fromEnvironment(),headless:true,escalationTimeoutMs:100,
 authorizeIrreversible:{by:'review-boundary-check',reason:'Final requests intercepted and aborted locally; no remote posting'},
 onSurfaceReady:async({surface})=>{await surface.livePage().route('**/*',async route=>{
  const req=route.request();
  if(new URL(req.url()).pathname.endsWith('/post')){
   checked=true;violation=checkTransaction(profileFor(cap.target.productId).transactionRules??[],req.url(),req.method(),req.postData(),inputs);
   await route.abort('blockedbyclient');
  }else await route.fallback();
 });}
 });
 const passed=checked && !violation;
 rows.push({capability:id,version:cap.version,runId:result.runId,postIntercepted:checked,violation,passed});
 console.log(id,passed?'PASS: matching final payload intercepted; not posted':'FAIL: '+(violation??'review was not reached'));
}
await mkdir('evidence/assignment-2/past-verifications',{recursive:true});
await writeFile('evidence/assignment-2/past-verifications/review-boundary.json',JSON.stringify({checkedAt:new Date().toISOString(),remotePosts:0,rows},null,2)+'\n');
process.exitCode=rows.every(r=>r.passed)?0:1;
