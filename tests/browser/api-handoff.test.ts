import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi } from '../../src/api/server.js';
import { SecretVault } from '../../src/policy/vault.js';

it('exposes a pending API authorization through the live console, resumes, and persists history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lh-handoff-'));
  const vault = SecretVault.forTesting({ coreOperatorUser: 'svc_agent', coreOperatorPassword: 'demo-password-not-real' });
  const api = await startApi({ port: 0, vault, invokeDefaults: { baseUrl: 'http://localhost:4173', headless: true, evidenceBaseDir: dir, escalationTimeoutMs: 10000 } });
  let pending: Promise<Response> | undefined;
  let operatorUrl: string | undefined;
  let interventionId: string | undefined;
  try {
    pending = fetch(`${api.url}/capabilities/member_open_sub_account/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arguments: { memberId: '12345', description: 'Handoff regression', initialDeposit: 25 } }) });
    let run: any;
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${api.url}/runs/active`)).json();
      run = state.runs.find((r: any) => r.status === 'escalated');
      if (run) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(run?.operatorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    operatorUrl = run.operatorUrl;
    const state = await (await fetch(`${operatorUrl}api/state`)).json();
    interventionId = state.interventions[0].id;
    expect(state.lease).toBe('operator');
    const blocked = await fetch(`${api.url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'overlap' }) });
    expect(blocked.status).toBe(409);
    const post = (action: string, body: object) => fetch(`${operatorUrl}api/interventions/${interventionId}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('claim', { operator: 'test-operator' })).ok).toBe(true);
    expect((await post('resolve', { decision: 'authorize-and-resume', by: 'test-operator', note: 'Authorize one local synthetic account' })).ok).toBe(true);
    const response = await pending;
    const result = await response.json();
    expect(result.ok).toBe(true);
    const history = await (await fetch(`${api.url}/runs`)).json();
    expect(history.runs.find((r: any) => r.runId === result.runId)).toMatchObject({ status: 'success', inputs: { memberId: '[withheld]' } });
    const evidence = await (await fetch(`${api.url}/runs/${result.runId}/evidence`)).json();
    expect(evidence.files.some((f: any) => f.name === 'summary.json')).toBe(true);
  } finally {
    if (operatorUrl && interventionId) await fetch(`${operatorUrl}api/interventions/${interventionId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'abort', by: 'test-cleanup' }) }).catch(() => {});
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
