/**
 * Drives the operator console's HTTP API the way the console's own buttons do.
 *
 * Used to capture evidence of the human-in-the-loop path without a person sitting
 * at the browser. This is not a mock of the escalation mechanism: the broker, the
 * control lease, the intervention record and the console server are all the real
 * ones, and these are the exact two requests the "Claim & take control" and
 * "Authorize & resume" buttons issue. What is stood in for is the human's judgment,
 * which is stated plainly in evidence/README.md rather than implied.
 *
 *   npx tsx scripts/operator-autoresolve.ts <decision> [note]
 */

// This file has no imports, which under ESM means TypeScript does not treat it as a
// module -- and top-level `await` is only legal in a module. It runs correctly under
// tsx either way, which is exactly why the error went unnoticed: `scripts/` was missing
// from tsconfig's `include`, so nothing ever typechecked it.
export {};

const [decision = 'authorize-and-resume', note = 'reviewed at the console; opening a sub-account is expected for this task'] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.OPERATOR_PORT ?? 4180}`;
const operator = 'auto-operator (scripted; see evidence/README.md)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 0; attempt < 240; attempt++) {
  let state: { lease: string; interventions: { id: string; status: string; headline: string; reason: string }[] };
  try {
    state = (await fetch(`${base}/api/state`).then((r) => r.json())) as typeof state;
  } catch {
    await sleep(500);
    continue;
  }
  const pending = state.interventions.find((i) => i.status === 'pending');
  if (!pending) {
    await sleep(500);
    continue;
  }
  console.log(`[operator] intervention ${pending.id}: ${pending.headline}`);
  console.log(`[operator] reason=${pending.reason} lease=${state.lease}`);

  const claimed = await fetch(`${base}/api/interventions/${pending.id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operator }),
  }).then((r) => r.json());
  console.log(`[operator] claimed -> lease is now with the operator (status ${claimed.intervention?.status})`);

  await sleep(600); // a human would look at the screen here

  const resolved = await fetch(`${base}/api/interventions/${pending.id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, by: operator, note }),
  }).then((r) => r.json());
  console.log(`[operator] resolved as '${decision}' -> control returned to automation`);
  console.log(`[operator] lease transitions: ${JSON.stringify(resolved.intervention?.leaseTransitions?.map((t: { from: string; to: string }) => `${t.from}->${t.to}`))}`);
  process.exit(0);
}
console.log('[operator] no intervention appeared');
