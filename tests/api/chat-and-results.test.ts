import { it, expect, vi } from 'vitest';
import { createChatBackend } from '../../src/api/chat.js';
import { toEnvelope } from '../../src/api/invoke.js';
import type { ReplayResult } from '../../src/replay/outcome.js';

it('reports recovered steps as successful and keeps recovery details', () => {
  const result = toEnvelope('test', { status: 'success', runId: 'test', evidenceDir: '/tmp', outputs: {}, durationMs: 1,
    steps: [{ id: 'step', action: 'click', status: 'recovered', durationMs: 1 }], recoveries: [{ handler: 'maintenance' }],
  } as unknown as ReplayResult);
  expect(result.steps?.[0]).toMatchObject({ ok: true, status: 'recovered' });
  expect(result.recoveries).toHaveLength(1);
});

it('executes multiple chat calls and does not execute an identical repeated operation twice', async () => {
  const invoke = vi.fn(async (name: string) => ({ ok: true as const, tool: name, runId: 'fake', evidence: '/tmp', outputs: { done: true } }));
  let turn = 0;
  const chat = createChatBackend({ invokeFunction: invoke, provider: { id: 'fake', async complete() {
    turn++;
    return { model: 'fake', toolCalls: turn < 3 ? [
      { id: `a${turn}`, name: 'session_sign_on', args: { branch: 'MAIN-001' } },
      { id: `b${turn}`, name: 'member_read_record', args: { memberId: '100234', shareId: '100234-S0001' } },
    ] : [], text: turn === 3 ? 'Both done' : undefined };
  } } });
  const result = await chat.reply('Perform both requests', []);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(result.invocations).toHaveLength(2);
  expect(result.message).toBe('Both done');
});

it('server-owned chat invocation defaults replace an omitted vault and evidence directory',async()=>{
 const {buildApi}=await import('../../src/api/server.js');
 const {SecretVault}=await import('../../src/policy/vault.js');
 const vault=SecretVault.forTesting({});let turn=0;let received:any;
 const chat=createChatBackend({provider:{id:'wiring-test',complete:async()=>({model:'test',toolCalls:turn++===0?[{id:'one',name:'member_read_record',args:{memberId:'103001',shareId:'103001-S0001'}}]:[],text:'done'})},invokeFunction:async(_name,_args,opts)=>{received=opts;return {ok:false,tool:'member_read_record',error:{code:'MISSING_CREDENTIAL',message:'test'}};}});
 buildApi({vault,chat,invokeDefaults:{evidenceBaseDir:'/tmp/custom-evidence',unattended:true}});
 await chat.reply('read',[]);expect(received.vault).toBe(vault);expect(received.evidenceBaseDir).toBe('/tmp/custom-evidence');expect(received.unattended).toBe(true);
});
