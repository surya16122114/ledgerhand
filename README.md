# Ledgerhand

I built Ledgerhand to record reusable UI workflows and replay them without a model choosing each action.

An LLM works out how to complete a task in a real UI once. That run is compiled into
a **typed, versioned capability artifact**. The artifact then replays
deterministically — no model in the decision loop — returning typed outputs,
distinguishing legitimate business outcomes from failures, recovering from runtime
conditions, and escalating to a human who can take over the same live session and
hand it back.

Design decisions and trade-offs are in **[REPORT.md](REPORT.md)**. Evidence from real
runs is in **[evidence/](evidence)**.

---

## Local setup and replay

```bash
npm ci
npx playwright install chromium
# Only create .env if it does not already exist:
test -f .env || cp .env.example .env
npm test                 # unit/API tests: no browser, no network, no key
npm run target-app       # leave running; serves two tenants on 4173 and 4174
```

Then in a second terminal:

```bash
npm run demo:replay
```

```
SUCCESS  member.read-savings-balance@1.0.0  outputs={"savingsBalance":8241.77}  11313ms
```

That is a capability an LLM discovered once, replaying with **no model in the loop**.
Additional examples cover a missing member, session recovery and a second tenant:

```bash
# "no such member" is a business outcome the caller handles, not a crash
npm run cli -- replay member.read-savings-balance --input memberId=99999

# the session dies mid-run: re-authenticates, returns to the right screen, finishes
npx tsx scripts/fault-replay.ts session-expiry member-detail

# the same recording at a second institution — different routes, labels and a
# compliance gate — via an overlay of four label and four route aliases
npm run cli -- replay member.read-savings-balance --tenant riverstone-fcu \
  --base-url http://localhost:4174 --input memberId=12345
```

The full walkthrough, including a real discovery run and the human-in-the-loop handoff,
is under [Demo path](#demo-path) below.

---

## The target application

For Assignment 1, I built a local stand-in: **CorePoint Servicing**, a fictional credit-union member
servicing console, deliberately built the way these applications actually are.

- A real `<frameset>` — nav frame plus body frame, so nothing is single-document
- Table-based layout, `<font>` tags, no semantic classes
- WebForms control ids (`name="ctl00$MainContent$txtMemberId"`)
- **No** `data-testid`, no `aria-*`, and no `<label for>` — every field's label sits
  in a neighboring `<td>`, so the browser computes an **empty accessible name** for
  every text input
- Injectable runtime faults: session expiry, an unexpected interstitial, a slow load,
  an exception page
- **Two tenants** on two ports, configured as two institutions running the same
  vendor product with different labels, routes and compliance gates

That last property is what makes the cross-tenant reuse story testable rather than
hypothetical. All data is synthetic; member names are invented and "tax IDs" are
obviously fake.

---

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Discovery needs a model API key; **replay does not**. Put one in `.env`:

```
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1
```

The operator credentials in `.env.example` are the stand-in app's own fake
credentials. They are loaded into a secret vault at runtime and never written to an
artifact or a log — see [Safety](REPORT.md#safety).

Local tests need no model key or hosted service. Live chat and discovery need a model key:

```bash
npm test          # unit/API tests; no model key
npm run typecheck
```

---

## Demo path

Start the target application and leave it running:

```bash
npm run target-app
```

That serves two tenants:

| tenant | product build | url |
|---|---|---|
| Meridian Credit Union | `corepoint-servicing@4.2.118` | http://localhost:4173/login.aspx |
| Riverstone Federal CU | `corepoint-servicing@4.1.94` | http://localhost:4174/signon.aspx |

### 1. Discover a capability with a real LLM run

```bash
npm run demo:discover
```

The agent signs on, navigates to Member Servicing, searches for a member, and reads
their savings balance — then the run is compiled into a capability artifact, linted, and
saved as a `draft`. Runs headed by default so you can watch. Model latency and cost depend on the run.

The committed artifacts are what `/evidence` was produced against, so a rediscovery will
**not** overwrite one: it saves the run's evidence, then stops and tells you to bump the
version or pass `--force`. Discovery is non-deterministic, so a second run of the same
goal will not produce a byte-identical artifact.

Inspect what was recorded:

```bash
npm run cli -- show member.read-savings-balance
```

### 2. Replay it deterministically

```bash
npm run demo:replay
```

```
SUCCESS  member.read-savings-balance@1.0.0  outputs={"savingsBalance":8241.77}  11313ms

steps
  ok    1. 01-open-entry                  navigate 992ms
  ok    2. 02-fill-user-id                fill via labelled-field 1009ms
  ok    3. 03-fill-password               fill via labelled-field 989ms
  ok    4. 04-click-sign-on               click via role-name 1361ms
  ok    5. 05-click-member-servicing      click via role-name 1739ms
  ok    6. 06-fill-member-id              fill via labelled-field 1354ms
  ok    7. 07-click-search                click via role-name 1705ms
  ok    8. 08-read-savings-balance        readText via table-cell 1418ms
```

Note `via labelled-field` on the fills: those inputs have **no accessible name at
all** in the markup. Perception recovered their labels from the adjacent table cell.

### 3. See the error taxonomy

```bash
# a legitimate business outcome, not an error
npm run replay -- member.read-savings-balance --input memberId=99999

# a different member — proves the capability is really parameterized
npm run replay -- member.read-savings-balance --input memberId=20881

# rejected before a browser is even launched
npm run replay -- member.read-savings-balance --input memberId=abc
```

Arm a runtime fault, then replay the *unmodified* capability against it:

```bash
npx tsx scripts/fault-replay.ts session-expiry     member-detail   # recovers: re-auth + reposition
npx tsx scripts/fault-replay.ts unexpected-notice  member-detail   # recovers: dismiss, step already satisfied
npx tsx scripts/fault-replay.ts app-error          member-detail   # hard failure, with evidence
```

### 4. Replay the same recording at a second institution

```bash
npm run cli -- overlay member.read-savings-balance overlays/corepoint-servicing.riverstone-fcu.json

npm run replay -- member.read-savings-balance \
  --tenant riverstone-fcu --base-url http://localhost:4174 --input memberId=12345
```

Riverstone has different routes, calls the key field `Account Holder #`, calls the
button `Find`, and forces an acceptable-use gate Meridian does not have. An overlay of
four label aliases and four route aliases handles the renames; the compliance gate is
absorbed by the product profile.

### 5. Human-in-the-loop on an irreversible action

```bash
npm run cli -- discover open-subaccount
```

This flow ends in a **Submit Request** that opens a real sub-account. The policy gate
classifies it irreversible and stops. Open the console URL it prints
(http://127.0.0.1:4180), and you will see the intervention, a **live view of the same
session** the automation was driving, and the decision buttons. Claim it, and clicks
and keystrokes go to the real session and are recorded. Choose **Authorize & resume**
and the run finishes.

The same path exists on replay:

```bash
npm run cli -- approve member.open-sub-account --by "Your Name <you@example.test>"

# approved, unattended, but unauthorised -> refuses the irreversible step
npm run replay -- member.open-sub-account --unattended \
  --input memberId=12345 --input description="Holiday Club" --input initialDeposit=250

# authorized -> completes the write
npm run replay -- member.open-sub-account --unattended --authorize "batch LH-4471" \
  --input memberId=12345 --input description="Holiday Club" --input initialDeposit=250
```

### 6. Discover and invoke a capability the way an agent would

```bash
npm run cli -- catalog                # human view
npm run cli -- catalog --json         # tool definitions with JSON Schema args

npm run cli -- invoke member_read_savings_balance --args '{"memberId":"12345"}'
```

```json
{ "ok": true, "tool": "member_read_savings_balance",
  "runId": "replay-...", "outputs": { "savingsBalance": 8241.77 } }
```

A declared business outcome comes back as data an agent can branch on, not an exception:

```bash
npm run cli -- invoke member_read_savings_balance --args '{"memberId":"99999"}'
# { "ok": false, "outcome": { "code": "MEMBER_NOT_FOUND", "retryable": true, ... } }
```

and a wrong argument name is a typed error before any browser starts:

```bash
npm run cli -- invoke member_read_savings_balance --args '{"memberID":"12345"}'
# { "ok": false, "error": { "code": "INVALID_ARGUMENTS", ... "expected": <the JSON Schema> } }
```

### 7. A goal of your own

Nothing is wired to the presets — they are shortcuts. `member.read-profile-summary`
was discovered from a free-form goal:

```bash
npm run cli -- discover \
  --goal "Sign on, look up member 12345, and read that member's account status and branch." \
  --capability-id member.read-profile-summary \
  --param 'memberId=12345:string:pii:^\d{1,10}$' \
  --expect accountStatus --expect homeBranch
```

It returns `ACTIVE / BR-014 NORTHGATE` for member 12345 and `DORMANT / BR-014 NORTHGATE`
for member 30014 — the reads resolve by their on-screen labels, not by the values that
happened to be there at record time. Try it without the model:

```bash
npm run cli -- invoke member_read_profile_summary --args '{"memberId":"30014"}'
```

(To discover another version, use a new `--version` or `--capability-id`; replay and invoke do not re-discover.)

---

### 8. Assignment 2: hosted MERIDIAN CORE

Everything above runs against a target in this repo. The same system was then
pointed at a hosted servicing console it did not know existed —
`web-sample.interface-hiring.com` — and recorded eight capabilities covering the seven required function groups,
including real posted transactions.

Adapting it required one product profile, seven goal presets, and fixes in perception, recording, replay, and runtime policy. The architecture carried over; the second application exposed assumptions that required code changes.

```bash
# read-only, safe to run repeatedly
npm run cli -- replay member.read-record \
  --input memberId=103001 --input shareId=103001-S0001

# the same recording against a different member and a different row position
npm run cli -- replay member.read-record \
  --input memberId=101555 --input shareId=101555-CERT

# a legitimate business outcome, not a crash
npm run cli -- replay member.find-by-name --input lastName=Zzyzx
```

The changes, trade-offs and remaining verification limits are in [the adaptation write-up](docs/ADAPTATION.md).

### 9. API, chatbot and dashboard

```bash
npm run cli -- serve            # http://127.0.0.1:4190
```

One command starts the HTTP API, a chatbot over it, and an operator dashboard on the
same origin. The API and chatbot derive their typed contracts from the same catalog. Chat filters out irreversible capabilities unless explicitly enabled.

```bash
curl -s localhost:4190/capabilities | jq '.capabilities[].name'

curl -s -X POST localhost:4190/capabilities/member_read_record/invoke \
  -H 'content-type: application/json' \
  -d '{"arguments":{"memberId":"103001","shareId":"103001-S0001"}}'
```

A business outcome is **HTTP 200** with an `outcome` body, not a 404 — the result
contract enforced at the transport layer:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  localhost:4190/capabilities/member_find_by_name/invoke \
  -H 'content-type: application/json' -d '{"arguments":{"lastName":"Zzyzx"}}'
# 200
```

The chatbot picks a capability and its arguments; it never drives the browser and
cannot author a step. Capabilities that change records are withheld from it entirely
unless an authorization reason was supplied, so:

> **"transfer $5 from 103001-MMKT-5 to 103001-MMKT-7"**
> → *"I currently do not have a direct transfer capability."* — nothing invoked.


## Running without live services

| what | how |
|---|---|
| unit tests | `npm test` — no browser, no network, no key |
| browser regression tests | `npm run test:browser` — needs Chromium and the target app; covers the label/value and data-grid cases browser-free tests cannot reach |
| replay | needs the target app; **never** needs a model key |
| discovery loop, no key | use `discover <preset> --provider transcript --transcript <transcript.json>`. This replays model responses against a browser, not a new model discovery; positional references depend on matching page state. |
| regenerate replay evidence | `npm run capture-evidence` |

---

## Commands

```
ledgerhand discover <preset|--goal "...">   run the LLM loop and record a capability
ledgerhand replay   <capability>            replay deterministically
ledgerhand catalog  [--json]                list capabilities as callable tools
ledgerhand show     <capability>            human-readable steps, targets, handlers
ledgerhand lint     <capability>            structural + safety findings
ledgerhand approve  <capability> --by "..." draft -> approved
ledgerhand overlay  <capability> <file>     attach a tenant overlay
ledgerhand invoke   <tool-name> --args '{}'  call a capability the way an agent would
```

Useful flags: `--headed`/`--headless`, `--times N` (stability signal),
`--unattended`, `--authorize "<reason>"`, `--tenant`, `--base-url`,
`--no-operator`, `--json`.

---

## Where each requirement lives

Assignment 1 Section 3, mapped to implementation and saved evidence. Numbered scenarios refer to the local replay batches under `evidence/assignment-1/`; these are historical executions, not a fresh certification. Assignment 2 function coverage and limits are documented in [ADAPTATION.md](docs/ADAPTATION.md).

| requirement | implementation | evidence |
|---|---|---|
| **3.1** goal-driven observe/decide/act loop against a live UI | `src/agent/loop.ts`, perception in `src/surface/web/perceive.ts` | `evidence/assignment-1/original-submission/discovery/*` — two real `gpt-4.1` runs |
| **3.2** typed, versioned, reviewable capability artifact | `src/artifact/schema.ts`, `store.ts` | `evidence/assignment-1/original-submission/capabilities/*.json` |
| **3.3** deterministic replay, stable targeting, checkpoints | `src/replay/engine.ts`, `src/surface/matching.ts` | scenarios `01`, `02`, `13` |
| **3.3** business outcome vs recoverable vs hard failure | `src/replay/outcome.ts`, handlers in `src/artifact/product-profiles.ts` | `03`, `04`, `06`, `07`, `08`, `13`, `14` |
| **3.4** allowlist, risky-action handling, redaction | `src/policy/{gate,allowlist,risk,redact,vault}.ts` | `10`, `11`, `12`; `tests/policy/gate.test.ts` |
| **3.5** structured log + richer signal on failure | `src/evidence/logger.ts` | `run.jsonl`; screenshots/snapshots on failures and escalations, not every successful run |
| **3.6** detect stuck, route with context, transfer control, resume | `src/escalation/*`, `operator-console.html` | `evidence/assignment-1/original-submission/screenshots/operator-console.png`, `12`; generated scenario `16-operator-console` |
| **3.7** heterogeneity and multi-tenant reuse | `src/surface/types.ts` seam, `src/surface/desktop/README.md`, `src/artifact/overlay.ts` | scenario `09` — one recording, two institutions |

I focused on two stretch goals: the callable catalog and cross-tenant reuse. Manual approval and `--times N` stability statistics support those workflows.

---

## Layout

```
src/
  surface/          the seam: perceive + act, surface-agnostic
    types.ts          roles, target strategies, conditions, actions, Surface
    matching.ts       target resolution — pure, shared by every driver
    web/perceive.ts   in-page perception, incl. accessible-name synthesis
    web/playwright-surface.ts   the browser driver
    desktop/README.md what a UIAutomation/AX driver would implement
  artifact/         the capability
    schema.ts         zod schema + referential integrity
    store.ts          load/save, canonical digest, lint (verifies redaction)
    overlay.ts        per-tenant specialization, deterministic
    product-profiles.ts  runtime conditions a happy-path run cannot observe
    catalog.ts        projection into agent-callable tool definitions
  agent/            discovery (model in the loop)
    loop.ts           observe -> decide -> act, stall detection, recording
    tools.ts          the model's tool surface — no tool accepts a selector
    recorder.ts       compiles a run into an artifact
  replay/           production execution path — no LLM in scope
    engine.ts         step loop, handler precedence, recovery
    outcome.ts        the result contract
  policy/           vault, redaction, risk classification, allowlist, gate
  escalation/       control lease, intervention broker, operator console
target-app/         the legacy stand-in, two tenants, injectable faults
capabilities/       saved artifacts
overlays/           tenant overlays
evidence/           real discovery runs + recorded replay scenarios
```

---

## Notes

- Nothing here touches a real financial system, and it isn't meant to. All data is
  synthetic. Assignment 1 runs locally; Assignment 2 depends on the hosted sandbox.
- The `.env` file is gitignored. `.env.example` documents what is needed.
- Discovery is non-deterministic by nature; the committed artifacts came from
  specific runs whose transcripts are in `evidence/assignment-1/original-submission/discovery/`. A fresh discovery may
  produce a slightly different step list, which is why replay — not discovery — is
  the path with saved actions and explicit checks. Determinism does not guarantee the target will always be available or unchanged.


### Record a fresh Meridian capability

With the model key and Meridian credentials configured in `.env`, run:

```bash
npm run cli -- discover meridian-record --product meridian-core --base-url https://web-sample.interface-hiring.com --capability-id demo.member-record-live-01 --version 1.0.0 --headed
```

This performs live discovery using the read-only member-record preset. Choose a new ID for each rehearsal; do not overwrite the submitted recording. Replay and dashboard instructions above use the existing saved capabilities and need no new discovery.


### Dashboard demonstration

Start `npm run cli -- serve --headed` and open http://127.0.0.1:4190/.
The API and dashboard work without a model key; Chat and Teach require one.

1. Select **Assignment 2**, then **Read record**. Enter `memberId` = `103001` and `shareId` = `103001-S0001`, and run the task. Check the returned balance and run activity.
2. Select **Find by name**, enter `lastName` = `Zzyzx`, and run it. Expect a `MEMBER_NOT_FOUND` business outcome.
3. In Chat, ask: “List the shares for member 103001.” Check the named capability and returned result. Model wording can vary.
4. For a handoff demonstration, select **Update contact**, enter `memberId` = `103001`, `email` = `verified.member@example.net`, `phone` = `415-555-0196`, and `address` = `130 Demo Street, San Francisco, CA 94104`. Keep operator approval selected. This is a synthetic write. At the pause, open the operator link, claim control, inspect the same page, and choose **Authorize & resume** or **Abort**. If confirmation is missing, reconcile the member record before repeating the write; see the known limitation below.

Select **Assignment 1** for the three local capabilities; keep `npm run target-app` running. For **Read savings balance**, use member `20881`. Assignment selection filters the saved capabilities; it does not turn a local recording into a hosted recording. Teach uses the product configured when starting the server (`--product corepoint-servicing` for local discovery; default `meridian-core`).

### Verification and known limits

- `npm test`: unit and API regression checks.
- `npm run test:browser`: Chromium regression checks, including same-session handoff and dashboard controls; not the hosted end-to-end suite.
- `npm run capture-evidence`: sixteen local scenarios, saved to a new dated directory.
- `npm run verify:meridian`: hosted read-only verification. `npm run verify:meridian -- --writes` additionally changes synthetic contact details, opens shares, transfers funds and places a hold.
- `node --import tsx scripts/verify-review-boundary.ts`: reaches hosted review forms and aborts final posts locally; its historical share IDs may need replacement after sandbox changes.
- `npm run record:demo`: creates a backup dashboard recording. The existing [video](evidence/demo/demo.webm) covers a subset, not every requirement.

The hosted contact-update handoff demonstrated claim, manual interaction and return of the same session. The subsequent save lacked its expected confirmation and escalated again. I do not count that run as a confirmed successful write. Historical successful write runs do not resolve that later failure. Current Meridian artifacts are drafts, so unattended invocation requires explicit artifact review and approval.

The [evidence index](evidence/README.md) separates historical executions from current runtime output. A clean-clone rehearsal of the final submitted commit remains necessary; see [new-machine setup](docs/NEW-MACHINE.md). I used AI-assisted development and retained the design decisions, tests and limitations here for review.
