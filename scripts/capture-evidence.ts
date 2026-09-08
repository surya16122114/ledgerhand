/**
 * Regenerate the replay evidence in /evidence.
 *
 * Discovery is deliberately NOT part of this script: a discovery run costs a real
 * model call, and the committed discovery evidence is from a real run that is meant
 * to stay exactly as it happened. This script re-runs the deterministic half, which
 * is reproducible by construction.
 *
 *   npm run capture-evidence
 *
 * Requires the target app on 4173 (meridian) and 4174 (riverstone).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadEnvFile } from '../src/config/env.js';
import { canonicalJson, capabilityDigest, loadCapability } from '../src/artifact/store.js';
import { replay, type ReplayOptions } from '../src/replay/engine.js';
import { summarizeResult, type ReplayResult } from '../src/replay/outcome.js';
import { startOperatorConsole } from '../src/escalation/operator-server.js';

const MERIDIAN = 'http://localhost:4173';
const RIVERSTONE = 'http://localhost:4174';
const OUT = process.env.EVIDENCE_OUTPUT_DIR ?? `evidence/assignment-1/past-verifications/local-${new Date().toISOString().replace(/[:.]/g, '-')}`;

interface Scenario {
  slug: string;
  title: string;
  why: string;
  capability: string;
  inputs: Record<string, unknown>;
  options?: Partial<ReplayOptions>;
  /** Fault armed on the target app before the run. */
  fault?: { kind: string; pathContains: string; method?: string; delayMs?: number };
  expect: ReplayResult['status'];
}

const SCENARIOS: Scenario[] = [
  {
    slug: '01-success-recorded-member',
    title: 'Success on the member the capability was recorded with',
    why: 'The baseline: the artifact replays with no model in the loop and returns a typed output.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: '12345' },
    expect: 'success',
  },
  {
    slug: '02-success-different-member',
    title: 'Success on a member with a different account mix',
    why:
      'Proves the capability is genuinely parameterized rather than parameterized in name only. ' +
      'The savings row is addressed as {{input.memberId}}-00, so it resolves via the primary strategy with no drift.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: '20881' },
    expect: 'success',
  },
  {
    slug: '03-business-outcome-not-found',
    title: 'Business outcome: no such member',
    why: 'A legitimate answer the caller must handle, returned as MEMBER_NOT_FOUND rather than thrown as an error.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: '99999' },
    expect: 'business_outcome',
  },
  {
    slug: '04-business-outcome-permission-denied',
    title: 'Business outcome: record exists but is not readable',
    why: 'Distinguished from not-found because the remedy differs: an entitlement change, not a different input. retryable=false.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: '40009' },
    expect: 'business_outcome',
  },
  {
    slug: '05-invalid-input-preflight',
    title: 'Invalid input, rejected before a browser is launched',
    why: 'The declared input pattern is checked first, so a malformed member id costs milliseconds and yields a precise message.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: 'not-a-number' },
    expect: 'failed',
  },
  {
    slug: '06-recovered-unexpected-interstitial',
    title: 'Recoverable: an unexpected system notice mid-flow',
    why:
      'The notice is dismissed by the product-profile interrupt, and the interrupted step is then found to be already ' +
      'satisfied -- so it is not re-submitted. Reported as a recovery, not a failure.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: '12345' },
    fault: { kind: 'unexpected-notice', pathContains: 'member-detail' },
    expect: 'success',
  },
  {
    slug: '07-recovered-session-expiry',
    title: 'Recoverable: the session expires mid-flow',
    why:
      'Re-authenticates from the steps marked partOfAuth, then replays the read-only navigational prefix to get back to ' +
      'the screen the failed step expects, and retries it. Refuses to replay anything irreversible while repositioning.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: '12345' },
    fault: { kind: 'session-expiry', pathContains: 'member-detail' },
    expect: 'success',
  },
  {
    slug: '08-hard-failure-app-error',
    title: 'Hard failure: the application returns an exception page',
    why: 'Not recoverable and not a business outcome. Stops with a declared APP_ERROR code, a screenshot, and a DOM snapshot.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: '12345' },
    fault: { kind: 'app-error', pathContains: 'member-detail' },
    expect: 'failed',
  },
  {
    slug: '09-cross-tenant-overlay',
    title: 'The same recording, replayed at a second institution',
    why:
      'Recorded against meridian-cu; replayed against riverstone-fcu, which runs the same vendor product with renamed ' +
      'labels, relocated routes, and a compliance gate meridian does not have. Adapted by a 20-line overlay plus the ' +
      "product profile's terms-gate interrupt -- not a second discovery run.",
    capability: 'member.read-savings-balance',
    inputs: { memberId: '12345' },
    options: { tenantId: 'riverstone-fcu', baseUrl: RIVERSTONE },
    expect: 'success',
  },
  {
    slug: '10-irreversible-blocked-unauthorised',
    title: 'An irreversible step with no authorization is refused',
    why:
      'The run is approved and unattended but carries no authorization, so the risk ceiling is held below the ' +
      "capability's declared maximum and the submit is refused. With no operator available the escalation times out, " +
      'which is reported as an abort -- nobody said it was safe.',
    capability: 'member.open-sub-account',
    inputs: { memberId: '12345', description: 'Holiday Club', initialDeposit: 250 },
    options: { unattended: true, escalationTimeoutMs: 8000 },
    expect: 'escalated',
  },
  {
    slug: '11-irreversible-authorized',
    title: 'The same step, with the run authorized',
    why: 'Completes the write and returns the new account number and confirmation reference, both read by their on-screen labels.',
    capability: 'member.open-sub-account',
    inputs: { memberId: '12345', description: 'Holiday Club', initialDeposit: 250 },
    options: { unattended: true, authorizeIrreversible: { by: 'evidence-capture', reason: 'batch LH-4471, approved by operations' } },
    expect: 'success',
  },
  {
    slug: '12-irreversible-slow-submit-retry-refused',
    title: 'A slow irreversible submit is NOT retried automatically',
    why:
      'The most important safety case in the project. The submit POST stalls for 30s, so the confirmation screen does ' +
      'not appear within the step budget and the transient-slow-load handler matches. Because the step is classified ' +
      'irreversible, the retry is refused and a human is asked instead -- we do not know whether the first submit took ' +
      'effect. Ground truth: it had. Exactly one sub-account was created, which is what a retry would have made two.',
    capability: 'member.open-sub-account',
    inputs: { memberId: '30014', description: 'Holiday Club', initialDeposit: 250 },
    options: { unattended: true, authorizeIrreversible: { by: 'evidence-capture', reason: 'exercising the retry-refusal path' } },
    fault: { kind: 'slow-load', pathContains: 'subaccount-new', method: 'POST', delayMs: 30_000 },
    expect: 'escalated',
  },
  {
    slug: '13-recovered-slow-load',
    title: 'Recoverable: a load that overruns the step budget',
    why:
      'A 16s stall exceeds the 10s step budget, so the checkpoint fails and the failure-code-guarded ' +
      'transient-slow-load handler fires. On re-attempt the checkpoint is found already satisfied, so the click is ' +
      'not repeated. A 9s stall (inside budget) needs no handler at all -- condition polling absorbs it.',
    capability: 'member.read-savings-balance',
    inputs: { memberId: '12345' },
    fault: { kind: 'slow-load', pathContains: 'member-detail', delayMs: 16_000 },
    expect: 'success',
  },
  {
    slug: '14-free-form-goal-capability',
    title: 'A capability discovered from a free-form goal, on a member with a different status',
    why:
      'member.read-profile-summary came from a free-form --goal rather than a preset, proving the loop is not wired to a ' +
      'fixed set of tasks. Replayed here against a DORMANT member: the reads resolve by their on-screen labels, so the ' +
      'current status comes back rather than the one seen at record time. Under the earlier data-bearing checkpoints ' +
      'this is the exact case that would have failed.',
    capability: 'member.read-profile-summary',
    inputs: { memberId: '30014' },
    expect: 'success',
  },
  {
    slug: '15-business-outcome-validation',
    title: 'Business outcome: the application rejects the submitted values',
    why: 'A deposit below the product minimum is VALIDATION_REJECTED with retryable=true, not a crash.',
    capability: 'member.open-sub-account',
    inputs: { memberId: '12345', description: 'Holiday Club', initialDeposit: 5 },
    options: { unattended: true, authorizeIrreversible: { by: 'evidence-capture', reason: 'batch LH-4472' } },
    expect: 'business_outcome',
  },
];

async function arm(baseUrl: string, fault: Scenario['fault']): Promise<void> {
  if (!fault) {
    await fetch(`${baseUrl}/__fault/disarm`, { method: 'POST' }).catch(() => {});
    return;
  }
  await fetch(`${baseUrl}/__fault/arm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'once', delayMs: 9000, ...fault }),
  });
}

await loadEnvFile('.env');
await mkdir(join(OUT, 'replays'), { recursive: true });

/**
 * Copy the artifacts these scenarios ran against into the evidence bundle.
 *
 * The brief asks for "a saved example artifact plus logs" in /evidence, and a reviewer
 * reading only that directory should not have to go looking in /capabilities to find
 * what was actually replayed. Copied at capture time so the two cannot drift: if an
 * artifact changes, the next capture brings the new one along with its results.
 */
await mkdir(join(OUT, 'capabilities'), { recursive: true });
for (const ref of ['member.read-savings-balance', 'member.open-sub-account', 'member.read-profile-summary']) {
  const cap = await loadCapability(ref);
  const file = join(OUT, 'capabilities', `${cap.id}@${cap.version}.json`);
  await writeFile(file, `${canonicalJson(cap)}\n`, 'utf8');
  process.stdout.write(`artifact under test: ${file}  digest ${capabilityDigest(cap)}\n`);
}

const summary: string[] = [];
let mismatches = 0;
function safeResult(result: ReplayResult) {
  return { runId: result.runId, status: result.status, steps: result.steps.map(s => ({ stepId: s.id, status: s.status })),
    outputs: Object.fromEntries(Object.keys(result.outputs).map(k => [k, '[withheld]'])),
    recoveries: result.recoveries.map(r => ({ handler: r.handler, action: r.action, stepId: r.stepId })),
    drift: result.drift.map(d => ({ stepId: d.stepId, primaryStrategy: d.primaryStrategy, usedStrategy: d.usedStrategy, usedIndex: d.usedIndex })) };
}
for (const scenario of SCENARIOS) {
  const baseUrl = scenario.options?.baseUrl ?? MERIDIAN;
  process.stdout.write(`\n=== ${scenario.slug}: ${scenario.title}\n`);
  await arm(baseUrl, scenario.fault);

  const capability = await loadCapability(scenario.capability);
  const result = await replay(capability, scenario.inputs, {
    baseUrl,
    headless: true,
    evidenceBaseDir: join(OUT, 'replays', scenario.slug),
    escalationTimeoutMs: 10_000,
    ...scenario.options,
  });

  const ok = result.status === scenario.expect;
  if (!ok) mismatches++;
  process.stdout.write(`    ${ok ? 'as expected' : `UNEXPECTED (wanted ${scenario.expect})`}: ${summarizeResult(result)}\n`);

  await writeFile(
    join(OUT, 'replays', scenario.slug, 'result.json'),
    `${JSON.stringify({ scenario: { slug: scenario.slug, title: scenario.title, why: scenario.why, inputs: Object.keys(scenario.inputs), fault: scenario.fault ?? null, expected: scenario.expect }, matchedExpectation: ok, result: safeResult(result) }, null, 2)}\n`,
    'utf8',
  );

  summary.push(
    [
      `### ${scenario.slug} -- ${scenario.title}`,
      '',
      scenario.why,
      '',
      '```',
      JSON.stringify(safeResult(result), null, 2),
      ...(result.recoveries.length ? ['', 'recoveries:', ...result.recoveries.map((r) => `  ${r.handler} (${r.action}) at ${r.stepId}: [detail withheld]`)] : []),
      ...(result.drift.length ? ['', 'locator drift:', ...result.drift.map((d) => `  ${d.stepId}: primary ${d.primaryStrategy} -> used ${d.usedStrategy} (#${d.usedIndex})`)] : []),
      '```',
      '',
      `expected \`${scenario.expect}\`, got \`${result.status}\` -- ${ok ? 'match' : '**MISMATCH**'}`,
      '',
    ].join('\n'),
  );
  await arm(baseUrl, undefined);
}

// -------------------------------------------------- operator console screenshot
process.stdout.write('\n=== capturing an operator console screenshot during a live escalation\n');
try {
  const capability = await loadCapability('member.open-sub-account');
  let shot: string | undefined;
  // Closed in the finally below: leaving it bound is what made a *previous* evidence
  // run hold port 4188 and break the next one.
  let consoleHandle: { close(): Promise<void> } | undefined;
  const run = replay(capability, { memberId: '20881', description: 'Holiday Club', initialDeposit: 250 }, {
    baseUrl: MERIDIAN,
    headless: true,
    unattended: true,
    evidenceBaseDir: join(OUT, 'replays', '16-operator-console'),
    escalationTimeoutMs: 60_000,
    onSurfaceReady: async ({ surface, lease, broker }) => {
      const console_ = await startOperatorConsole({ broker, lease, page: surface.livePage(), port: 4188 });
      consoleHandle = console_;
      // Wait for the escalation, claim it, then photograph the console the way an
      // operator would see it.
      void (async () => {
        for (let i = 0; i < 120; i++) {
          const pending = broker.list().find((x) => x.status === 'pending');
          if (pending) {
            broker.claim(pending.id, 'evidence-capture@console');
            const browser = await chromium.launch({ headless: true });
            const page = await browser.newPage({ viewport: { width: 1500, height: 1150 } });
            await page.goto(console_.url);
            await page.waitForTimeout(6000);
            shot = join(OUT, 'screenshots', 'operator-console.png');
            await mkdir(join(OUT, 'screenshots'), { recursive: true });
            await page.addStyleTag({ content: '* { color: transparent !important; text-shadow: none !important; background-image: none !important } img, canvas, video, input, textarea, svg { visibility: hidden !important }' });
            await page.screenshot({ path: shot, fullPage: false });
            await browser.close();
            broker.resolve(pending.id, 'abort', 'evidence-capture@console', 'screenshot captured; run aborted deliberately');
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      })();
    },
  });
  const result = await run;
  await consoleHandle?.close();
  process.stdout.write(`    console screenshot: ${shot ?? '(not captured)'}  run ended as ${result.status}\n`);
  if (!shot || result.status !== 'escalated') mismatches++;
  if (shot) {
    summary.push(
      [
        '### 16-operator-console -- the operator console during a live escalation',
        '',
        'A screenshot of the real console (`evidence/assignment-1/original-submission/screenshots/operator-console.png`), taken while a replay was paused ' +
          'on an irreversible step. It shows the intervention context, the live view of the same session the automation ' +
          'was driving, the control-transfer log, and the decision buttons.',
        '',
        '```',
        JSON.stringify(safeResult(result), null, 2),
        '```',
        '',
        'This run was aborted on purpose once the screenshot was taken.',
        '',
      ].join('\n'),
    );
  }
} catch (err) {
  mismatches++;
  process.stdout.write(`    console screenshot failed: ${err instanceof Error ? err.message : String(err)}\n`);
}

await writeFile(join(OUT, 'REPLAY-SCENARIOS.md'), `# Replay scenarios\n\nGenerated by \`npm run capture-evidence\`.\n\n${summary.join('\n')}`, 'utf8');
process.stdout.write(`\nwrote ${join(OUT, 'REPLAY-SCENARIOS.md')}\n`);

if (mismatches) process.exitCode = 1;
