import { it, expect } from 'vitest';
import { checkTransaction } from '../../src/policy/transaction.js';
import { profileFor } from '../../src/artifact/product-profiles.js';
import { readFileSync } from 'node:fs';
const product=JSON.parse(readFileSync('capabilities/assignment-2/member.transfer-funds@1.0.0.json','utf8')).target.productId;
const rules=profileFor(product).transactionRules!;
const inputs={memberId:'103001',fromShare:'103001-A',toShare:'103001-B',amount:1,memo:'',shareType:'MMKT',initialDeposit:25,shareId:'103001-A',reason:'LEGAL',notes:''};
const cases=[['transfer',{from:inputs.fromShare,to:inputs.toShare,amount:'1.00',memo:''}],['open-share',{type:'MMKT',deposit:'25.00'}],['hold',{share:inputs.shareId,reason:'LEGAL',notes:''}]] as const;
for(const [kind,fields] of cases){
 const url=`https://example.test/members/103001/${kind}/post`;
 const body=new URLSearchParams({...fields,_token:'live-token'}).toString();
 it(`${kind}: accepts exactly matching transaction data`,()=>expect(checkTransaction(rules,url,'POST',body,inputs)).toBeUndefined());
 for(const field of Object.keys(fields))it(`${kind}: rejects changed ${field}`,()=>{
  const changed=new URLSearchParams(body);changed.set(field,'unexpected');
  expect(checkTransaction(rules,url,'POST',changed.toString(),inputs)).toContain(field);
 });
 it(`${kind}: refuses missing tokens, duplicate fields, and wrong member`,()=>{
  const missing=new URLSearchParams(body);missing.delete('_token');expect(checkTransaction(rules,url,'POST',missing.toString(),inputs)).toContain('token');
  expect(checkTransaction(rules,url,'POST',body+'&_token=second',inputs)).toContain('token');
  expect(checkTransaction(rules,url.replace('103001','103002'),'POST',body,inputs)).toContain('member');
  const duplicated=new URLSearchParams(body);const name=Object.keys(fields)[0]!;duplicated.append(name,duplicated.get(name)!);
  expect(checkTransaction(rules,url,'POST',duplicated.toString(),inputs)).toContain('ambiguous');
 });
}

it('does not round distinct large amounts into the same transaction',()=>{
 const body=new URLSearchParams({_token:'live',from:inputs.fromShare,to:inputs.toShare,amount:'9007199254740993',memo:''}).toString();
 expect(checkTransaction(rules,'https://example.test/members/103001/transfer/post','POST',body,{...inputs,amount:9007199254740992})).toContain('amount');
});

it('guards direct contact writes while allowing the form GET',()=>{
 const url='https://example.test/members/103001/update';
 const values={memberId:'103001',email:'demo@example.test',phone:'4155550100',address:'Demo Street'};
 const body=new URLSearchParams({_token:'live',email:values.email,phone:values.phone,address:values.address});
 expect(checkTransaction(rules,url,'GET',null,values)).toBeUndefined();
 expect(checkTransaction(rules,url,'POST',body.toString(),values)).toBeUndefined();
 for(const field of ['email','phone','address']){const changed=new URLSearchParams(body);changed.set(field,'wrong');expect(checkTransaction(rules,url,'POST',changed.toString(),values)).toContain(field);}
});
