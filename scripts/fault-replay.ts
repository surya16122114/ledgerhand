/**
 * Arm a runtime fault, then replay -- so the recovery paths are exercised
 * deterministically rather than waited for.
 *
 * The fault is armed on the target app's side channel, not via a query string on
 * the app's own URLs, so the capability being replayed is byte-identical to the
 * happy-path run. Only the application's behaviour differs. See
 * target-app/faults.ts.
 *
 *   npx tsx scripts/fault-replay.ts <fault-kind> <pathContains> [memberId] [delayMs] [method] [capability]
 */

import { loadEnvFile } from '../src/config/env.js';
import { loadCapability } from '../src/artifact/store.js';
import { replay } from '../src/replay/engine.js';
import { summarizeResult } from '../src/replay/outcome.js';

const [kind = 'unexpected-notice', pathContains = 'member-detail', memberId = '12345', delayMs = '9000', method = '', capabilityRef = 'member.read-savings-balance'] = process.argv.slice(2);
await loadEnvFile('.env');

const base = process.env.TARGET_APP_BASE_URL ?? 'http://localhost:4173';
const armed = await fetch(`${base}/__fault/arm`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind, mode: 'once', pathContains, method, delayMs: Number(delayMs) }),
}).then((r) => r.json());
console.log(`armed fault: ${JSON.stringify(armed.armed)}\n`);

const capability = await loadCapability(capabilityRef);
const inputs: Record<string, unknown> =
  capabilityRef === 'member.open-sub-account'
    ? { memberId, description: 'Holiday Club', initialDeposit: 250 }
    : { memberId };
const result = await replay(capability, inputs, {
  baseUrl: base,
  headless: true,
  escalationTimeoutMs: 12_000,
  ...(capabilityRef === 'member.open-sub-account'
    ? { unattended: true, authorizeIrreversible: { by: 'fault-replay', reason: 'exercising the retry-refusal path' } }
    : {}),
});

console.log(summarizeResult(result));
console.log('\nsteps');
for (const s of result.steps) {
  console.log(`  ${s.status.padEnd(21)} ${String(s.index + 1).padStart(2)}. ${s.id.padEnd(30)} attempts=${s.attempts}`);
  if (s.error) console.log(`${' '.repeat(26)}${s.error.code}: ${s.error.message}`);
}
if (result.recoveries.length) {
  console.log('\nrecoveries');
  for (const r of result.recoveries) console.log(`  ${r.handler} (${r.action}) at ${r.stepId}: ${r.detail}`);
}
if (result.status === 'failed' || result.status === 'escalated') {
  console.log(`\nfailure: ${result.failure.code} at ${result.failure.stepId ?? '-'}`);
  if (result.failure.expected) console.log(`  expected: ${result.failure.expected}`);
  if (result.failure.observed) console.log(`  observed: ${result.failure.observed}`);
  if (result.failure.evidence?.screenshot) console.log(`  screenshot: ${result.failure.evidence.screenshot}`);
}
if (result.status === 'business_outcome') console.log(`\noutcome: ${result.outcome.code} (retryable=${result.outcome.retryable})`);
if (result.status === 'success') console.log(`\noutputs: ${JSON.stringify(result.outputs)}`);
console.log(`\nevidence: ${result.evidenceDir}`);
await fetch(`${base}/__fault/disarm`, { method: 'POST' });
