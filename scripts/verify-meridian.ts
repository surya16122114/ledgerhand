/** Explicit sandbox verification. Never changes global fault-injection settings. */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { loadEnvFile } from '../src/config/env.js';
import { loadCapability } from '../src/artifact/store.js';
import { replay, type ReplayOptions } from '../src/replay/engine.js';
import { SecretVault } from '../src/policy/vault.js';
import type { ReplayResult } from '../src/replay/outcome.js';

await loadEnvFile('.env');
const baseUrl = 'https://web-sample.interface-hiring.com';
const evidenceBaseDir = 'evidence/runs';
const vault = SecretVault.fromEnvironment();
const rows: { scenario: string; runId: string; status: string; code?: string; recoveries: string[]; passed: boolean }[] = [];
const memberId = '103001';
const only = process.argv.includes('--validation-only') ? 'injected validation' : undefined;
async function run(scenario: string, id: string, args: Record<string, unknown>, options: Partial<ReplayOptions> = {}, expected = 'success'): Promise<ReplayResult> {
  if (only && scenario !== only) return { status: 'failed' } as ReplayResult;
  const cap = await loadCapability(id);
  const result = await replay(cap, args, { baseUrl, vault, headless: true, evidenceBaseDir, escalationTimeoutMs: 1500, ...options });
  const code = result.status === 'business_outcome' ? result.outcome.code : (result.status === 'failed' || result.status === 'escalated') ? result.failure.declaredCode ?? result.failure.code : undefined;
  const passed = expected === result.status || expected === code;
  rows.push({ scenario, runId: result.runId, status: result.status, code, recoveries: result.recoveries.map((r) => r.action), passed });
  console.log(`${scenario}: ${result.status}${code ? ' / ' + code : ''} ${passed ? 'PASS' : 'FAIL'} (${result.runId})`);
  await mkdir('evidence/assignment-2/past-verifications', { recursive: true });
  const previous = await readFile('evidence/assignment-2/past-verifications/meridian-matrix.json', 'utf8').then((s) => JSON.parse(s).rows as typeof rows).catch(() => []);
  const merged = [...previous.filter((p) => !rows.some((r) => r.scenario === p.scenario)), ...rows];
  await writeFile('evidence/assignment-2/past-verifications/meridian-matrix.json', JSON.stringify({ checkedAt: new Date().toISOString(), rows: merged }, null, 2) + '\n');
  return result;
}
function inject(kind: string): Partial<ReplayOptions> {
  return { onSurfaceReady: async ({ surface }) => {
    let injected = false;
    await surface.livePage().route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      if (!injected && req.isNavigationRequest() && req.method() === 'GET' && /^\/members\/\d+$/.test(url.pathname)) {
        injected = true; url.searchParams.set('inject', kind); await route.fallback({ url: url.href });
      } else await route.fallback();
    });
  } };
}
const reads = { memberId, shareId: `${memberId}-S0001` };
if (!process.argv.includes('--hold-only')) {
await run('sign-on branch', 'session.sign-on', { branch: 'WEST-014' });
await run('read balance and status', 'member.read-record', reads);
await run('multi-match search', 'member.find-by-name', { lastName: 'a' });
await run('member not found', 'member.find-by-name', { lastName: 'Zzyzx' }, {}, 'MEMBER_NOT_FOUND');
for (const [kind, expected] of [['validation','VALIDATION_REJECTED'], ['notfound','MEMBER_NOT_FOUND'], ['permission','PERMISSION_DENIED'], ['server','APP_ERROR'], ['maintenance','success'], ['timeout','success']] as const) {
  await run(`injected ${kind}`, 'member.read-record', reads, inject(kind), expected);
}
}
if (process.argv.includes('--hold-only')) {
  const auth = { authorizeIrreversible: { by: 'verification', reason: 'User-approved synthetic sandbox hold verification on existing test share' } };
  const teller = SecretVault.forTesting(Object.fromEntries(vault.names().map(name => [name, name === 'meridianSupervisorUser' ? vault.get('meridianOperatorUser') : name === 'meridianSupervisorPass' ? vault.get('meridianOperatorPass') : vault.get(name)])));
  const hold = { memberId, shareId: '103001-MMKT-13', reason: 'LEGAL', notes: '' };
  await run('teller hold refused', 'member.place-hold', hold, { ...auth, vault: teller }, 'PERMISSION_DENIED');
  const held = await run('supervisor hold posted', 'member.place-hold', hold, auth);
  if (held.status === 'success') await run('held source refused', 'member.transfer-funds', {memberId, fromShare:hold.shareId, toShare:'103001-MMKT-14', amount:1, memo:''}, auth, 'SOURCE_SHARE_RESTRICTED');
}
if (process.argv.includes('--writes')) {
const auth = { authorizeIrreversible: { by: 'verification', reason: 'Verify recorded capabilities on hosted synthetic sandbox' } };
await run('contact three-field readback', 'member.update-contact', { memberId, email: 'verified.member@example.net', phone: '415-555-0196', address: '130 Demo Street, San Francisco, CA 94104' }, auth);
const first = await run('open share A', 'member.open-share', { memberId, shareType: 'MMKT', initialDeposit: 25 }, auth);
const second = await run('open share B', 'member.open-share', { memberId, shareType: 'MMKT', initialDeposit: 25 }, auth);
if (first.status === 'success' && second.status === 'success') {
  const fromShare = String(first.outputs.newShareId), toShare = String(second.outputs.newShareId);
  const args = { memberId, fromShare, toShare, amount: 1, memo: '' };
  await run('transfer posted with empty memo', 'member.transfer-funds', args, auth);
  await run('insufficient funds', 'member.transfer-funds', { ...args, amount: 1000000 }, auth, 'INSUFFICIENT_FUNDS');
  await run('same-share validation', 'member.transfer-funds', { ...args, toShare: fromShare }, auth, 'VALIDATION_REJECTED');
  const teller = SecretVault.forTesting(Object.fromEntries(vault.names().map((name) => [name, name === 'meridianSupervisorUser' ? vault.get('meridianOperatorUser') : name === 'meridianSupervisorPass' ? vault.get('meridianOperatorPass') : vault.get(name)])));
  const hold = { memberId, shareId: fromShare, reason: 'LEGAL', notes: '' };
  await run('teller hold refused', 'member.place-hold', hold, { ...auth, vault: teller }, 'PERMISSION_DENIED');
  const held = await run('supervisor hold posted', 'member.place-hold', hold, auth);
  if (held.status === 'success') await run('held source refused', 'member.transfer-funds', args, auth, 'SOURCE_SHARE_RESTRICTED');
}
}
process.exitCode = rows.every((r) => r.passed) ? 0 : 1;
