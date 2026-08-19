# Ledgerhand

Give an AI agent hands inside legacy software that has no API.

An LLM works out how to complete a task in a real UI once. That run is compiled into
a **typed, versioned capability artifact**. The artifact then replays
deterministically — no model in the decision loop — returning typed outputs,
distinguishing legitimate business outcomes from failures, recovering from runtime
conditions, and escalating to a human who can take over the same live session and
hand it back.

Design decisions and trade-offs are in **[REPORT.md](REPORT.md)**. Evidence from real
runs is in **[evidence/](evidence/)**.

---

## The target application

There is no public sandbox that exercises the interesting problems, so this repo
ships its own stand-in: **CorePoint Servicing**, a fictional credit-union member
servicing console, deliberately built the way these applications actually are.

- A real `<frameset>` — nav frame plus body frame, so nothing is single-document
- Table-based layout, `<font>` tags, no semantic classes
- WebForms control ids (`name="ctl00$MainContent$txtMemberId"`)
- **No** `data-testid`, no `aria-*`, and no `<label for>` — every field's label sits
  in a neighbouring `<td>`, so the browser computes an **empty accessible name** for
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
artifact or a log — see [REPORT.md §6](REPORT.md#6-safety).

Everything else works with no keys and no live services:

```bash
npm test          # 156 unit tests, no browser, no network
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
their savings balance — then the run is compiled into
`capabilities/member.read-savings-balance@1.0.0.json`, linted, and saved as a
`draft`. Runs headed by default so you can watch. Takes about a minute and costs
cents.

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

# a different member — proves the capability is really parameterised
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
button `Find`, and forces an acceptable-use gate Meridian does not have. A 20-line
overlay handles the renames; the compliance gate is absorbed by the product profile.

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

# authorised -> completes the write
npm run replay -- member.open-sub-account --unattended --authorize "batch LH-4471" \
  --input memberId=12345 --input description="Holiday Club" --input initialDeposit=250
```

### 6. The agent-facing catalog

```bash
npm run cli -- catalog
npm run cli -- catalog --json    # tool definitions with JSON Schema args
```

Saved artifacts are projected into callable tool definitions with typed args, typed
returns, **the declared business outcomes an agent must handle**, the lifecycle state,
and a stability signal.

---

## Running without live services

| what | how |
|---|---|
| unit tests | `npm test` — no browser, no network, no key |
| replay | needs the target app; **never** needs a model key |
| discovery loop, no key | drive the real loop from a recorded transcript — see [evidence/README.md](evidence/README.md#driving-the-loop-with-no-api-key). Restart the target app first: refs are positional. |
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
```

Useful flags: `--headed`/`--headless`, `--times N` (stability signal),
`--unattended`, `--authorize "<reason>"`, `--tenant`, `--base-url`,
`--no-operator`, `--json`.

---

## Layout

```
src/
  surface/          the seam: perceive + act, surface-agnostic
    types.ts          roles, target strategies, conditions, actions, Surface
    matching.ts       target resolution — pure, shared by every driver
    web/perceive.ts   in-page perception, incl. accessible-name synthesis
    web/playwright-surface.ts   the only Playwright-aware file
    desktop/README.md what a UIAutomation/AX driver would implement
  artifact/         the capability
    schema.ts         zod schema + referential integrity
    store.ts          load/save, canonical digest, lint (verifies redaction)
    overlay.ts        per-tenant specialisation, deterministic
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
evidence/           real discovery runs + 13 replay scenarios
```

---

## Notes

- Nothing here touches a real financial system, and it isn't meant to. All data is
  synthetic and the target application is part of this repo.
- The `.env` file is gitignored. `.env.example` documents what is needed.
- Discovery is non-deterministic by nature; the committed artifacts came from
  specific runs whose transcripts are in `evidence/discovery/`. A fresh discovery may
  produce a slightly different step list, which is why replay — not discovery — is
  the path with the correctness guarantees.
