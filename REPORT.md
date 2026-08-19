# REPORT

Ledgerhand is a computer-use automation system: an LLM works out how to complete a
task in a legacy UI once, that run is compiled into a typed capability artifact, and
the artifact replays deterministically afterwards with no model in the loop.

The target is a stand-in I built rather than a public demo site — a frameset-based
credit-union servicing console with WebForms-style control ids, no test ids, table
layouts, and inputs whose labels sit in a neighbouring `<td>` with no `for`
attribute. Building it was a deliberate choice: I needed a surface where perception
is genuinely hard, and I needed to be able to inject a session timeout, an
unexpected interstitial, a permission denial and an exception page on demand. A
public sandbox gives you neither.

Two capabilities were discovered by a real model run (`openai:gpt-4.1`) and are in
`/capabilities`. Evidence for both, plus fourteen replay scenarios, is in
`/evidence`.

---

## 1. Architecture

Five layers, each with one job. The layering is the design; everything else follows
from it.

```
  cli.ts / catalog.ts          how a human or an agent invokes a capability
  ─────────────────────────────────────────────────────────────────────────
  agent/       replay/         discovery (model in the loop) | replay (no model)
  ─────────────────────────────────────────────────────────────────────────
  artifact/                    the capability: schema, store, overlays, profiles
  ─────────────────────────────────────────────────────────────────────────
  policy/  escalation/         Surface decorators: allowlist, risk, control lease
  ─────────────────────────────────────────────────────────────────────────
  surface/                     perceive and act — the only Playwright-aware layer
```

**The load-bearing decision is the `Surface` seam.** Nothing above `src/surface/`
mentions Playwright, a CSS selector, or a pixel coordinate. Everything above it
speaks in normalised control roles, semantic target strategies, and declarative
conditions. `src/surface/matching.ts` — which answers "find the control this
artifact is describing" — is a pure function over `PerceivedControl[]`, so it is
shared by any driver and unit-tested without a browser.

**Guardrails are decorators, not helper functions.** `PolicyGate` and `LeaseGuard`
both *implement* `Surface` and wrap the real one:

```
PlaywrightWebSurface  ←  PolicyGate  ←  LeaseGuard  ←  (discovery or replay)
```

Discovery and replay each hold a `Surface`, and the only `Surface` either is ever
handed is the decorated one. There is no code path that reaches the browser without
passing the allowlist, the risk ceiling, and the control lease. A `checkPolicy()`
helper that every call site is trusted to remember would have been less code and a
worse guarantee.

**Single process, filesystem storage, in-memory queue.** Capabilities are JSON
files; the intervention queue is in-process. The most valuable property of
capability storage is that a reviewer can read a pull-request diff of one, and git
does that better than a table. The brief explicitly says not to build scaling
infrastructure, and I didn't.

### Trade-offs I'd flag

- **The gate resolves a target to classify its risk, and the driver resolves it
  again to act.** Between those two resolutions the page could in principle change,
  so the control that was classified is not provably the control that was clicked.
  On these stable enterprise UIs that window is not a practical risk, and the
  post-action location check bounds the consequence. Closing it properly means
  threading a resolution handle through `perform`, which would put a
  driver-specific concept into the seam. I chose the clean seam.

- **Every `resolve` re-perceives.** Caching an observation across an action would be
  faster and occasionally wrong, and "occasionally wrong" is the failure mode this
  project exists to eliminate. Replay costs ~11s for an 8-step flow, which is fine
  for the workload.

- **`dom-hint` exists at all.** A recorded CSS path is the least durable thing in
  the artifact and I record it anyway, as the last fallback, because when it fires
  it tells you something (see drift, §3). Overlays drop it for other tenants, where
  it is worse than useless.

---

## 2. Artifact schema

`src/artifact/schema.ts`. The artifact is the contract between three audiences that
never meet: the discovery agent that writes it once, the reviewer at the
institution who must approve it, and the production agent that calls it by name.

```jsonc
{
  "schemaVersion": "1.0.0",
  "id": "member.read-savings-balance", "version": "1.0.0",
  "summary": "...",                       // what an agent sees in the catalog
  "target": {
    "productId": "corepoint-servicing",   // the reuse key — NOT the tenant
    "recordedTenantId": "meridian-cu",
    "surfaceKind": "legacy-web",
    "entryUrl": "{{baseUrl}}/login.aspx"
  },
  "inputs":   [ { "name": "memberId", "type": "string", "sensitivity": "pii",
                  "pattern": "^\\d{1,10}$" } ],
  "outputs":  [ { "name": "savingsBalance", "type": "money", "sensitivity": "pii" } ],
  "outcomes": [ { "code": "MEMBER_NOT_FOUND", "retryable": true, ... } ],
  "steps":    [ { "id": "07-click-search", "intent": "Run the member search",
                  "action": { "kind": "click", "target": { ... } },
                  "risk": "safe", "partOfAuth": false,
                  "checkpoint": { ... }, "handlers": [ ... ] } ],
  "success":  { "checkpoint": { "kind": "textPresent", "pattern": "SHARE / DEPOSIT ACCOUNTS ..." } },
  "interrupts": [ ... ],                  // conditions that can occur at ANY step
  "policy":   { "allowedUrlPatterns": [...], "maxRisk": "reversible", ... },
  "lifecycle": { "state": "draft", "stability": { ... } },
  "provenance": { "model": "openai:gpt-4.1", "transcriptDigest": "sha256:...", ... },
  "overlays": [ { "tenantId": "riverstone-fcu", "labelAliases": {...} } ]
}
```

Six decisions, each with a cost:

**1. Targets are semantic intents, ordered by durability.** A step says "the textbox
labelled Member ID", never `#ctl00_MainContent_txtMemberId`. Each target carries an
ordered strategy list:

| strategy | what it means | portable to |
|---|---|---|
| `role-name` | role + accessible name | web, legacy web, desktop |
| `labelled-field` | field whose *visible* label is X, however that label is wired | web, legacy web, desktop |
| `table-cell` | the `Current Balance` column of the row keyed `12345-00` | anything with a table |
| `section-ordinal` | the nth control of a role under a named heading | anything with a tree |
| `dom-hint` | a CSS path | web only |
| `anchor-offset` | offset from a named visual anchor | screenshot / OS drivers |

`labelled-field` matters most on these apps and is the reason I didn't just use
Playwright's `ariaSnapshot()`. A legacy form puts its label in a sibling `<td>` with
no `for=`, so the browser correctly computes an **empty** accessible name and a
role+name matcher has nothing to match. `src/surface/web/perceive.ts` recovers the
name a human would use from the adjacent cell and records that it was *synthesised*,
so downstream code knows to keep a fallback ready. It also deliberately matches
authored labels, so a tenant that upgrades to a build with proper `<label for>`
keeps working.

**2. The model does not author locators.** During discovery the model points at a
`ref` from the observation it was just shown; the *system* looks that ref up in its
own perception and writes the strategy list. The artifact's robustness is therefore
a property of a deterministic, tested perception layer rather than of a language
model's taste in CSS on the day it ran. This is the single decision I'd defend
hardest.

**3. Everything is data, never code.** Steps, conditions and handlers are
declarative. No embedded expressions, nothing eval'd. This costs expressiveness —
there are flows this schema cannot describe — and buys reviewability, portability to
a non-browser surface, and the absence of an arbitrary-code-execution path in
software that runs inside a bank.

**4. Business outcomes are part of the type.** `outcomes` declares the vocabulary of
legitimate non-success results, so a caller can switch on `code` exhaustively. A
replay that ends in a state matching none of them is a hard failure *by definition*:
an undeclared outcome is a gap in the capability, not something to paper over at
runtime.

**5. `interrupts` are capability-level, not per-step.** A session timeout is not a
property of step 7. Allowing only per-step handlers forces the recorder to copy
cross-cutting conditions onto every step, where they will be copied inconsistently.

**6. Provenance without the transcript.** The artifact stores a SHA-256 of the
discovery transcript, not the transcript. Model reasoning about a live banking
screen quotes member data; it belongs in access-controlled evidence storage, not in
a file that gets copied between environments.

### Validated on load, and linted separately

`parseCapability` runs on every load, not just on save, and checks referential
integrity: a step referencing an undeclared input, a capture into an undeclared
output, an action absent from `allowedActions`, a step whose risk exceeds the
capability's ceiling, a required output no step produces, an overlay patching a
step that doesn't exist. These are the mistakes a generated artifact actually
makes, and catching them at load time beats discovering them at step 7 against a
live banking screen.

`lintCapability` is advisory and separate. That split cost me a bug worth
mentioning: I first encoded "approved despite human-intervened discovery" as a
schema error, which made such an artifact unparseable — so it could never be
approved at all, whatever a reviewer decided. Structural validity belongs in
validation; review judgement belongs in lint.

The linter also **verifies** redaction rather than trusting
`provenance.redactionApplied`: it scans the serialised artifact for
credential- and PII-shaped literals *including the live values from the vault*, and
refuses to save on a hit.

---

## 3. Determinism & error handling

### How replay is deterministic

**Conditions, not sleeps.** Every transition is gated on a declared `Condition`,
polled against fresh perception until its budget expires. There is no `sleep(n)` in
the step loop. The only two timers in the action path are inside
`PlaywrightWebSurface.settle()` and neither is load-bearing: correctness comes from
the conditions, `settle` only reduces how many polls they need.

This is also how **transient slowness** is handled, and the answer is more boring than
a retry policy: a 9-second stall on a step with a 10-second budget is absorbed by
polling with `attempts=1` and no handler involved at all. Only a load that *overruns*
the budget needs the failure-code-guarded retry described below, and even then the
re-attempt first re-checks the checkpoint — so a load that has since landed is
recognised as already satisfied and the click is not repeated
(`evidence/replays/13-recovered-slow-load`).

That distinction came out of a real bug. Clicking a submit button does not navigate
synchronously — the click returns and the navigation starts a beat later, so
`waitForLoadState` resolves instantly against the document still on screen and
perception reads the *old* page. The fix was to ask the browser rather than a timer:
a `framenavigated` listener increments a sequence number, so "did my click start a
navigation?" has a real answer, and `settle` then waits for the whole frame tree —
including the redirect chain and a frameset's children — to go quiet.

**Ambiguity fails.** A target matching two controls stops the run rather than
picking one. Narrowing is limited to three rules I'd defend in a post-incident
review: honour the recorded frame, prefer an exact name match over a loose one,
prefer an enabled control over a disabled one. "Pick the first" is not on the list —
that is how automation clicks the wrong Submit on a screen with two forms. Nor does
resolution fall through to a *weaker* strategy after an ambiguous match: a vaguer
description cannot resolve an ambiguity a more precise one could not.

**Checkpoints after every state change**, and a step is never re-attempted when its
effect is already visible. That second property is a safety rule, not an
optimisation: a step can be retried after a recovery fired or after a human did the
work by hand, and blindly re-running it would submit the same request twice. For a
read that is wasteful; for "Open Sub-Account" it opens two accounts.

**Checkpoints assert structure, not data.** This was the hardest thing to get right
and it went through three iterations. The naive "pick the longest new line on screen"
synthesised `BR-014 NORTHGATE Member Since:` — the branch of the member used during
recording. Filtering anything containing digits then produced `ACTIVE Tax ID:`, which
reads like a heading and is in fact one member's account *status*, so the capability
would have failed outright for a dormant member. The fix was to stop guessing from
strings: the perception layer already identifies headings by *styling* (these apps
have no `<h1>`, they have a bold grey table cell), so checkpoints are synthesised
from a heading that appeared, and only fall back to text heuristics when nothing
structural changed. The committed artifacts checkpoint on `OPERATOR SIGN ON`,
`DAILY OPERATIONS SUMMARY`, `MEMBER SERVICING – INQUIRY`, `SHARE / DEPOSIT ACCOUNTS`
— every one member-independent.

The same guard applies to the model's claimed success phrase, and the committed run
shows it firing. The model first offered

```
MEMBER PROFILE Member ID: {{input.memberId}} Name: Ashgrove, Dolores Status: ACTIVE
```

which was rejected as record-time data — it names one member and would only ever hold
for that member. (The member id reads as a placeholder because tool calls are
parameterised on the way into the committed transcript; at runtime the model wrote the
concrete id, which is what the guard matched on.) It corrected to

```
SHARE / DEPOSIT ACCOUNTS Account Description Current Balance Available Opened
```

which is the section heading plus the accounts table's column headers: longer than I
would have written by hand, but entirely screen chrome, and in one respect better than
a bare heading — it asserts that the accounts table actually rendered with its header
row, not merely that the profile page loaded. Both turns are in
`evidence/discovery/*/run.jsonl` as `discovery.finishRejected` and
`discovery.finishClaimed`.

**Parameterisation reaches into targets, not just values.** A capability whose fill
values are parameterised but whose `table-cell` row key still reads `12345-00` is
parameterised in name only. Its failure mode is the nasty one: for a different
member the primary strategy misses, a weaker one resolves, and it returns a
*neighbouring account's* balance — real, plausible, and wrong. So the recorder
rewrites parameter values inside targets to `{{input.memberId}}-00`, and the engine
materialises them before anything runs. Relatedly, `section-ordinal` is deliberately
**not** offered for data cells: "the 6th cell in SHARE / DEPOSIT ACCOUNTS" is
meaningless once a member has a different number of accounts, and a read that cannot
be addressed by row and column should fail rather than guess.

### The error taxonomy

`ReplayResult` is a discriminated union on `status`:

| status | meaning | caller should |
|---|---|---|
| `success` | goal reached | use `outputs` |
| `business_outcome` | the app gave a legitimate non-success answer | handle the declared `code` |
| `failed` | automation, app or environment is wrong | surface to a human; don't retry blindly |
| `escalated` | a human was brought in and chose to stop | read `intervention` |

Recoverable conditions have **no status of their own**. By the time a result exists
they are already handled, and they appear in `recoveries[]` as things that happened
rather than things the caller must react to. Giving them a status would push retry
logic back onto every caller, which is what this layer exists to absorb.

Handlers are evaluated in a fixed precedence, because several conditions can be true
at once (a session-expiry page is *also* "the checkpoint did not hold"):

```
step handlers  →  capability interrupts  →  offer to a human  →  hard failure
```

Handler actions map one-to-one onto the taxonomy: `outcome` (business),
`dismiss` / `retryStep` / `reauthenticate` (recoverable), `escalate` (ask), `fail`
(hard). Four details earned their place:

- **A handler can match on the failure code, not only on page state.** This was a
  genuine hole in the model. Every handler originally matched a `Condition` over the
  screen, and the most ordinary runtime condition of all — a page slower than the
  step's budget — has no appearance on screen: while it loads, the browser is still
  showing the *previous* page, which looks perfectly healthy. My attempt to express it
  as state was a handler matching `^\s*$` against the visible text, which can never be
  true once a nav frame has rendered. It never fired once. I only caught it because the
  fault that should have exercised it was *also* broken — the harness consumed the
  armed fault before reading its delay, so `slow-load` slept zero milliseconds and had
  never actually stalled anything. Handlers now carry an optional
  `whenFailureCode`, and such a handler is only ever considered after a failure, never
  during the pre-step interrupt sweep.

- **`retryStep` refuses to re-attempt an irreversible step.** A retry is free for a
  read and a double-submit for a write. The checkpoint pre-check catches the benign
  case, but if the checkpoint genuinely does not hold we do not know whether the first
  attempt landed, and guessing is not acceptable. `evidence/replays/12-*` is this:
  a 30-second stall on the submit POST, the retry refused, a human asked. Ground truth
  — the POST *had* completed server-side, and exactly **one** sub-account exists where
  a retry would have made two.

- **`notDuringAuth`.** "The app is showing the sign-on screen" is the definition of
  being stuck at step six and the definition of working correctly at step one.
  Without this flag the `unexpected-signon-screen` interrupt fires on step one of
  every single run, and a handler that always fires gets deleted rather than fixed.

- **`reauthenticate` repositions.** Signing back in restores the *session*, not the
  *screen*: you land on the console home page while the failed step expects to be
  four screens in. Without repositioning, every session-timeout recovery "succeeded"
  and then failed with `TARGET_NOT_FOUND` on the next attempt. So it replays the
  auth block and then the read-only navigational prefix — and **refuses to replay
  anything irreversible** while doing so. Replaying a read-only path to get back
  where you were is fine; replaying a submit would open a second account, and no
  recovery is worth that.

### Where the runtime conditions come from

A successful discovery run never sees a session timeout, a permission denial or an
exception page — if it had, the run would not have succeeded. So a system that
derives its whole error taxonomy from the recording ships capabilities that only
work on the day they were recorded.

Those conditions are properties of the **vendor product**, not of a capability.
`src/artifact/product-profiles.ts` declares them once for CorePoint Servicing —
written by an engineer who has read how the product behaves — and every capability
recorded against that product inherits them. The division of labour:

| authored by | contributes |
|---|---|
| the discovery run | steps, targets, outputs, success condition |
| the product profile | runtime conditions, business outcome vocabulary |
| the tenant overlay | label and route differences at one institution |

Each is written by whoever actually knows the answer, and none has to guess at the
others. The twentieth capability against CorePoint costs one discovery run and
inherits a taxonomy hardened by twenty capabilities' worth of production
experience.

### Drift

Replay reports which strategy resolved each target and how far down the fallback
list it was. On a stable UI `drift` is empty; entries mean the app changed before
anything has actually broken, which is the only cheap moment to fix it.

Two quieter signals sit alongside it, both cases of "resolved, but only just":

- **Ambiguity narrowed.** When a strategy matched several controls and a tie-break rule
  picked one, that is logged (`drift.ambiguityNarrowed`). Nothing is wrong yet, which is
  exactly the point: the artifact's description of that control is no longer unique on
  screen, and the next change may push it from *narrowed* to *ambiguous*, which fails.
- **Perception truncated.** There is a 400-control cap per frame, and hitting it used to
  drop controls silently — so a target that resolved yesterday would report
  `TARGET_NOT_FOUND` today with nothing to explain why. Truncation is now attached to
  the resolution failure itself, which is both the only moment it matters and the only
  moment it is free (the observation already exists). Faults are
armed on a side channel (`POST /__fault/arm`) rather than via query strings on the
app's own URLs, so the capability under test is byte-identical to the happy-path
run and only the application's behaviour differs.

---

## 4. Heterogeneity & multi-tenant

### Extending to other surfaces

The seam is `Surface`: `observe`, `resolve`, `perform`, `evaluate`. A driver owes
two things — a list of `PerceivedControl` and the ability to act on one. Everything
else is already surface-independent: matching, condition evaluation, the artifact,
the replay engine, policy, the lease.

`src/surface/desktop/README.md` sets out what a Windows/macOS driver implements.
The short version: the accessibility APIs (UIAutomation, AX) return the same
information perception already normalises — role, name, value, bounding box, parent
chain — so `role-name`, `labelled-field`, `section-ordinal` and `anchor-offset` all
carry over unchanged. `table-cell` maps onto `UIA_GridPattern`. Only `dom-hint` is
web-only, which is exactly why it is fenced into its own strategy kind instead of
being smuggled into the others as "a selector".

For a **legacy web** app the same web driver already works: framesets, table
layouts, WebForms ids and unlabelled inputs are what the committed target app *is*.
Frames are first-class in `ContainerPath` rather than an afterthought, because
"which document am I in" is the most common reason naive automation silently fails —
the nav frame and the body frame routinely hold controls with the same name.

For a **screenshot-only** surface (canvas apps, some Win32 dialogs) the schema
already carries `anchor-offset`, so adding a coordinate-based driver does not
require a schema migration. The matcher reports it as unsupported on tree-based
surfaces rather than silently failing.

### Reuse across tenants

The reuse key is `target.productId`, not the tenant. An overlay is a small,
reviewable diff against the base capability, and `applyOverlay` is a pure function
producing an *effective capability that is itself a valid capability* — which is why
the replay engine has no idea overlays exist and adding tenant 300 cannot introduce
a new code path.

An overlay carries `labelAliases`, `routeAliases`, `extraInterrupts` and
`stepPatches`. The first two do nearly all the work, because across tenants running
the same vendor build what differs is overwhelmingly wording and routing rather than
flow structure.

This is demonstrated, not asserted. `overlays/corepoint-servicing.riverstone-fcu.json`
is 20 lines — four labels, four routes. With it, the capability recorded against
Meridian replays successfully against Riverstone, which has different routes
(`/signon.aspx`, `/servicing/find-member.aspx`), a differently named key field
(`Account Holder #`), a differently named button (`Find`), and a mandatory
acceptable-use gate Meridian does not have. Every locator resolved via its
**primary** strategy — zero drift — and the compliance gate was absorbed by the
product profile's `terms-acknowledgement-gate` interrupt rather than by the overlay,
which is the division of labour working as intended. See
`evidence/replays/09-cross-tenant-overlay/`.

Two deliberate refusals:

- **Row keys are not aliased.** A row key is data (an account number); a column
  header is a label. Aliasing both would corrupt the locator.
- **`effectiveCapability` refuses to run against a tenant with no overlay** unless
  you pass `--allow-unadapted`. Running an un-adapted flow at an institution is a
  decision someone makes, not a default. And a tenant that needs more than aliases
  plus a couple of `stepPatches` is a signal worth hearing: the builds have
  genuinely diverged and re-recording is the honest answer.

### Detecting per-tenant drift

Three signals, cheapest first: `drift[]` in every replay result (a fallback fired);
fallback hits accumulated across runs; and `target.productVersion` versus the build
string the app renders in its own footer — the target app prints
`CorePoint Servicing 4.2.118` in every page footer precisely so this check is
possible.

Only the first is built. The second needs the stability sidecar described in §7, and
the third needs something to run replays on a schedule. Both are named as next steps
rather than claimed.

---

## 5. Escalation & handoff

### Detecting stuck

Four distinct triggers, deliberately not collapsed into one:

| trigger | detected by |
|---|---|
| discovery can't find a way forward | the model calls `request_human_help` |
| discovery is looping | stall detector: same action fingerprint against an unchanged screen, 3× |
| an irreversible step needs a decision | `PolicyGate` returns `POLICY_AUTHORIZATION_REQUIRED` / risk-ceiling denial |
| replay hit a condition nothing declared | no step handler and no interrupt matched |

The stall detector matters more than it looks. Without it a model that cannot find a
control keeps clicking a plausible substitute, and every one of those clicks becomes
a step in the recording.

### Taking control of the live session

I did not mock this. The brief allows mocking the operator UI, but the interesting
part of the requirement is not the UI — it is the claim that a human can drive *the
same live session* the automation was using and then give it back. A mock cannot
demonstrate that.

`src/escalation/operator-server.ts` serves a console at `127.0.0.1:4180`. Control
transfers like this:

- The session is one long-lived Playwright context. There is no second session and
  no re-login, so cookies, the app's server-side session, the current screen and
  the half-filled form are exactly as the automation left them.
- Pixels go out over CDP `Page.startScreencast`.
- Input comes back over CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`, aimed
  at the same page.
- A `ControlLease` decides who may act. `LeaseGuard` blocks automation's mutating
  actions while the operator holds it; the server refuses to forward input while
  automation holds it. One owner, enforced on both sides, re-checked on every input
  event — an operator who has returned control cannot keep clicking.
- Reads are still permitted during a handoff, deliberately: the console and evidence
  capture need to observe, and observation does not compete for the pointer.
- Everything the human does is captured by an injected capture-phase recorder and
  attached to the intervention record, described in the same vocabulary perception
  uses (`change → Description = ...`, with the frame path). Password fields are
  recorded as events with **no value at all**, so there is nothing to leak even if
  redaction were misconfigured downstream.

The lease is ceded at **raise** time, not at claim time. Between "I am stuck" and "a
human picked this up" the automation must already be incapable of acting, or a retry
loop upstream keeps clicking while the request sits in a queue.

`evidence/screenshots/operator-console.png` shows this working. Ground truth for the
handoff: an operator typed into the Description field through the console, the run
resumed and completed, and the application stored `HOLIDAY CLUBVACATION CLUB` — the
human's text, entered remotely into the automation's own session.

### Handing control back

The operator resolves with one of four decisions, and each means something different
to the engine:

- `resume` — "I fixed the state, carry on"
- `authorize-and-resume` — grants a one-shot authorisation for the irreversible step
- `skip-step` — "not needed here"
- `abort` — stop; reported as `status: 'escalated'`, never as success

On `resume`, the engine checks whether the step's checkpoint **already holds** before
re-attempting it, and marks it `satisfied-externally` if so. Without that, a human
who completed the step by hand would have it done twice.

An escalation with no operator times out, and a timeout is reported as an abort —
the conservative reading, because nobody said it was safe to continue.

### What I cut

Authentication on the console (bound to localhost), multi-operator routing, and a
durable queue. Those are deployment concerns that do not change the control-transfer
model. The queue is in-memory with a JSON mirror in the run's evidence directory.

---

## 6. Safety

**One chokepoint.** `PolicyGate` is a `Surface` decorator, so there is no path to the
browser that skips it. It enforces, in order: the action kind is allowed; a
navigation's destination is allowed; the action's risk is within ceiling; and — after
the action — **every document in the frame tree** is still allowed. A violation on
that last check **latches the session shut**, because at that point we no longer know
what state the app is in, and only a human review clears it. Deny patterns beat allow
patterns; an empty allowlist throws rather than permitting everything.

The words "every document" are doing real work there, and I only got them right by
attacking my own guardrail. The check originally compared a single URL — the page's —
and on a frameset the top document loads once and never navigates again. So the check
saw `console.aspx` forever. I pointed the agent at the **Administration** link, a route
on the *deny* list, and it went straight there: the body frame landed on `/admin.aspx`,
the gate allowed the click, and nothing tripped. The seam now reports
`frameUrls` alongside `url` and the gate checks all of them
(`tests/gate.test.ts` pins it). It is the same root cause as the checkpoint bug in §3 —
on a frameset, the thing you naturally reach for never changes — which is why that
pattern is worth naming rather than just fixing twice.

**Risk is classified by the system, never by the model.** `src/policy/risk.ts` reads
the resolved control's accessible name for state-changing verbs — the same signal a
human operator uses — with an explicit benign list checked first (`Search`,
`Cancel`, `Continue`, `I Acknowledge`, `Sign On`). It is biased toward
over-classifying: over-classifying costs an escalation, under-classifying costs an
unauthorised write. `Enter` is treated as irreversible because in a focused form it
is a submit in disguise. A discovery agent that could label its own actions "safe"
would make the whole guardrail decorative.

**Irreversible actions need a decision from a person.** Discovery escalates them.
Replay holds the effective risk ceiling *below* the capability's declared maximum
unless the caller passes an authorisation, and the grant is one-shot and consumed on
use. This is where I made — and caught — the most serious bug in the project: I
originally set the ceiling to `capability.policy.maxRisk`, which for a write
capability *is* `irreversible`, so the check passed on every run and the approval
requirement was decorative. The ceiling has to come from what *this invocation* was
permitted to do, not from what the capability is capable of.

**Lifecycle gate.** Capabilities are born `draft` and unattended replay of a draft is
refused. A capability that can move money should not become unattended-runnable
because a model said it worked once.

**Credentials are used without ever being held.** An artifact says
`{ from: 'secret', name: 'coreOperatorPassword' }`; the vault resolves it at the
moment the keystroke is sent. The value never enters the artifact, the log, the
evidence bundle, or the model's context. The model's tool surface offers
`fill_field(ref, secretName)` with no way to read a credential, and a literal into a
password field is refused structurally.

**Redaction at two boundaries, in two layers.** The structured logger and the
artifact writer, rather than scattered through the code. Layer one is exact values
(vault secrets, plus every input the caller declared `pii`); layer two is shape
patterns (SSN, PAN, long digit runs, JWTs, bearer tokens). The second layer matters
more here, because the automation *reads* far more regulated data than it is given.
Screenshots mask password fields before capture, not after. Tokens keep the field
name (`[pii:memberId]`) so logs stay debuggable without being identifiable.

Redaction is also where I found a bug I'd have missed by inspection: sequential
`String.replace` calls let a later rule match inside a token an earlier rule just
emitted, so a secret whose value was `secret` turned `[secret]` into `[[secret]]`.
It is now a single pass over the original string with non-overlapping,
longest-match-wins splicing — longest-wins because if a short sensitive input sits
inside a card number, redacting the card number whole leaks nothing while redacting
the short match first would leave twelve digits exposed.

**Outputs are the one place regulated data legitimately leaves the system**, and that
is worth saying out loud rather than leaving implicit. A capability whose job is to
read a balance must return the balance; redacting it would make the capability
useless. So `ReplayResult.outputs` is deliberately *not* redacted, while the same
values are withheld from the structured log when their declared sensitivity is `pii`.
The consequence a deployment has to own: `--json` prints outputs to stdout, so a CI
job that captures that output is storing member data. The boundary is the caller's,
and the schema tells them exactly which fields it applies to.

**The operator console rejects unexpected websocket origins.** Binding to localhost
stops remote attackers, not local pages: without an origin check, any page the operator
had open in another tab could connect to the live channel and — whenever the lease
happened to sit with the operator — drive a signed-on banking session. Proportionate
rather than complete, and §7 says what would close it.

### Limits of the model, stated plainly

- **Verb-based risk classification is a heuristic.** A button labelled `OK` that
  posts a transfer is classified `reversible`. The mitigations are that irreversible
  is the *conservative* default for anything unclassifiable, and that a reviewer sees
  every step's risk before approving. A real deployment would maintain a per-product
  override list next to the product profile — the seam exists.
- **The allowlist is route-level, not entitlement-level.** It cannot express "may
  read member records but not accounts flagged restricted". That belongs in the
  application's own entitlements, which is why `PERMISSION_DENIED` is a first-class
  business outcome rather than something the guardrail tries to prevent.
- **The human is not policed.** An authorised employee operating their own
  institution's application is subject to the app's entitlements, not the agent's
  allowlist. What we owe in exchange is a record of what they did, which the
  human-action recorder provides.
- **Redaction shape patterns will both over- and under-match.** A nine-digit product
  code becomes `[pii:account-number]`; a novel identifier format would pass. The
  exact-value layer is the reliable one; shapes are defence in depth.

- **A model transcript can quote anything on the screen, and no shape rule catches a
  name.** In `evidence/discovery/*/transcript.json` the model's rejected success
  phrase contains a member name it read off the profile screen. Parameterisation
  removes declared inputs and the shape rules remove identifier-shaped values, but
  "Ashgrove, Dolores" is neither. This is not a gap I can close with a better regex,
  and it is the whole reason the artifact stores only
  `provenance.transcriptDigest`: the transcript is the one artefact that must be
  assumed to contain member data, so it belongs in access-controlled storage while
  the digest — which proves *which* transcript produced a capability — is what travels
  between environments. The transcripts are committed here only because every member
  in this repo is invented and the application generating them is in the repo too.
- **The console's origin check is not authentication.** `Origin` is set by browsers and
  simply omitted by a non-browser client, so it stops a drive-by page and not a
  determined local process. A per-session bearer token minted with the intervention
  would close it; on a shared host that would be required, not optional.

- **`bypassCSP` is enabled** on the browser context. Perception injects a local
  function, never remote code, but a restrictive policy can block the injection
  channel itself. Worth an explicit decision in a real deployment.

---

## 7. Cuts

**Deliberately not built:**

- **Desktop and screenshot drivers.** Designed to the seam and documented in
  `src/surface/desktop/README.md`, not implemented. Building a UIAutomation driver
  would have demonstrated the seam holds; I judged that reasoning about the seam,
  plus a legacy-web surface that genuinely stresses it, was the better use of the
  time.
- **Console authentication, multi-operator routing, a durable queue.** Deployment
  concerns that don't change the control-transfer model.
- **A second LLM provider.** `LlmProvider` is one method; a second adapter is the
  least interesting code in the project. `TranscriptProvider` replays a recorded run
  so the loop is testable with no key and no network — that seemed more useful than
  a second vendor mapping.
- **Scaling infrastructure.** Queues, workers, multi-tenant plumbing. The brief says
  not to, and the abstractions don't preclude it.
- **A "capability needs re-recording" workflow.** Drift is detected and reported;
  acting on it is manual.

**Mocked, at a stated seam:** the human's *judgement* in the committed evidence.
`scripts/operator-autoresolve.ts` issues exactly the two HTTP requests the console's
own buttons issue; the broker, lease, intervention record and console server are all
real. The console screenshot and the ground-truth handoff described in §5 were done
by hand through the UI.

**With more time, in order:**

1. **A canary replay per tenant, scheduled.** All three drift signals exist; nothing
   runs them on a timer. This is the highest-value next thing by a distance —
   record-once/replay-many only stays safe if something notices when the recording
   stops matching, and a nightly read-only capability per tenant would catch a
   vendor upgrade before a caller does.
2. **Confidence-gated promotion.** `lifecycle.stability` is declared on the schema
   and `--times N` reports a per-invocation flakiness signal, but **nothing persists
   those counters yet** and promotion `draft → approved` is a human command. I left
   the write-back out on purpose rather than by omission: mutating an approved
   artifact on every replay changes its content digest, which is the one property
   that makes "has this approved capability changed?" answerable. Persisting the
   counters belongs in a sidecar next to the artifact, with `lifecycle.stability`
   holding only the snapshot a reviewer saw at approval time. That is the shape I
   would build, and auto-demotion on consecutive failures is the first thing worth
   hanging off it.
3. **Bounded LLM recovery for a single step.** On a `TARGET_NOT_FOUND` the engine
   could offer one step to a model, policy-checked, never open-ended, recorded as
   evidence and requiring approval before it amends the artifact. I left it out
   because an unbounded version is worse than escalating, and the bounded version
   needs the confidence machinery above to be trustworthy.
4. **A real operator console.** Queue filtering, session recording playback, and
   the ability to promote a recorded human intervention into a new step on the
   artifact — which is the natural payoff of recording those actions in the first
   place.
5. **Closing the resolve-then-act window** in `PolicyGate` by threading a resolution
   handle through `perform`, if the concurrency risk ever proved real.

**Added after a self-review pass**, because a reviewer should know what a second look
found: the frameset egress hole (§6), a handler that could never fire together with the
broken fault that hid it (§3), declared-but-unenforced handler attempt limits, three
pieces of schema surface that nothing read (`terminal`, `captureInto`, and a screenshot
flag on `observe`), silent perception truncation, six copies of `escapeRegExp`, a
missing websocket origin check, and two operators being able to claim the same live
session. There is now a CI workflow running typecheck, the unit suite, the build, and
`lint` over every committed artifact — chosen so CI never depends on a model key or a
browser.

**What I'd change if I started again:** I would build the checkpoint-synthesis
problem before the discovery loop. Three of the four hardest bugs in this project
(data-bearing checkpoints, un-parameterised row keys, frameset URL assertions) are
the same bug wearing different clothes — record-time data leaking into something
that looks like structure — and I found them one at a time by replaying against a
second member and a second tenant. A "replay this against different inputs and a
different tenant immediately" harness, written first, would have surfaced all three
in one go.
