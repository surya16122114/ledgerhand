# Evidence

Everything here came from real runs against the target application in
`/target-app`. Nothing is hand-written.

```
capabilities/              the exact artifacts these scenarios ran against
discovery/                 two genuine LLM-driven discovery runs
replays/                   14 replay scenarios, one directory each
screenshots/               the operator console during a live escalation
REPLAY-SCENARIOS.md        generated summary of every replay scenario
```

`capabilities/` is a copy of `/capabilities`, written by the capture script at the same
time as the results, so the artifact and the runs that exercised it cannot drift apart.
The digest of each is printed during capture.

Each run directory contains:

| file | what it is |
|---|---|
| `run.jsonl` | the structured event stream, every line redacted |
| `summary.json` | event counts and the run's outcome |
| `transcript.json` | *(discovery only)* the model's turns and tool calls |
| `screenshots/` | captured on failure and on escalation, password fields masked |
| `snapshots/` | per-frame DOM dumps, captured on failure |
| `result.json` | *(replays)* the full `ReplayResult` plus what the scenario was testing |

## Discovery

Two capabilities, both discovered by `openai:gpt-4.1` driving the live application.

| run | capability | turns | note |
|---|---|---|---|
| `discovery-*-1af4af` | `member.read-savings-balance` | 9 | read-only |
| `discovery-*-9b5fda` | `member.open-sub-account` | 13 | contains an irreversible write; **escalated to a human for authorisation** |

Two things in these logs are worth opening:

**The model's success claim was rejected and corrected.** Search `run.jsonl` for
`discovery.finishRejected`. The model first offered
`MEMBER PROFILE Member ID: 12345 Name: Ashgrove, Dolores` as proof the goal was
reached. That is record-time data — it would only ever hold for that one member, and
it would put member data in the artifact — so it was refused with an explanation, and
the model corrected to `MEMBER PROFILE`. The next line is
`discovery.finishClaimed` with the accepted phrase.

**The irreversible step stopped the run.** In the `open-sub-account` log, search
`escalation.raised`. The policy gate classified `Submit Request` as irreversible and
refused it; the intervention was raised, the control lease was ceded to the operator,
a human authorised it, and the run resumed. `interventions.json` in that directory
has the full record including the lease transitions.

## Replays

See `REPLAY-SCENARIOS.md` for the generated summary. The set covers each branch of
the result contract deliberately:

- **success** on the recorded member, and on two members with different account mixes
- **business outcomes** — `MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_REJECTED`
- **recoverable** — an unexpected interstitial, and a session expiry mid-flow
- **hard failure** — an application exception page, with screenshot and DOM snapshot
- **a slow irreversible submit that is deliberately NOT retried** (`12-*`) — the most
  important one. Ground truth: the stalled POST *had* landed, and exactly one
  sub-account exists where an automatic retry would have created two.
- **pre-flight rejection** — a malformed member id, refused before a browser launches
- **policy** — an irreversible step refused without authorisation, then completed with it
- **cross-tenant** — the Meridian recording replayed against Riverstone

Faults are armed on the target app's side channel (`POST /__fault/arm`), never via
query strings on the app's own URLs. That matters: the capability under test is
byte-identical to the happy-path run, and only the application's behaviour differs.

Regenerate all of it (discovery excluded, since it costs a real model call and the
committed runs are meant to stay as they happened):

```bash
npm run target-app        # in one terminal
npm run capture-evidence  # in another
```

## What was scripted rather than performed by hand

`evidence/screenshots/operator-console.png` and the replay in
`replays/13-operator-console/` were produced by `scripts/capture-evidence.ts`, which
claims the intervention and then aborts it once the screenshot is taken.

Being precise about what that stands in for: the console server, the intervention
broker, the control lease, the CDP screencast and the intervention record are all
the real ones, and the two HTTP calls the script makes are exactly the two the
console's own "Claim & take control" and "Abort run" buttons issue. What is
substituted is the **human's judgement**, not the mechanism.

The handoff was also exercised by hand through the browser, which is how the
remote-input path was verified end to end: an operator clicked into the live view,
typed into the Description field, and authorised the submit — after which the
application stored `HOLIDAY CLUBVACATION CLUB`, the operator's text, proving the
keystrokes reached the same live session the automation had been driving. That is
described in `REPORT.md §5`; the run itself is not committed here because it was
driven interactively.

## Why the transcripts are committed at all

`REPORT.md §2` argues that a discovery transcript should *not* travel with an
artifact — the artifact carries only `provenance.transcriptDigest`, because a
transcript is the one thing guaranteed to contain whatever the model read off the
screen. Committing transcripts here is a deliberate exception, not a contradiction:
every member in this repo is invented and the application that produced them is in
the repo, so there is nothing to protect. They are included because they are the
best proof that the discovery runs were real, and because they make the loop
runnable with no API key.

You can see the limitation the digest design exists for. The rejected success phrase
in `member.read-savings-balance`'s transcript contains a member *name* the model read
off the profile screen. Declared inputs are parameterised out and identifier shapes
are scrubbed, but a name is neither — no regex fixes that, which is exactly why a
real deployment keeps the transcript in access-controlled storage and ships only the
digest.

## Driving the loop with no API key

Tool calls in a transcript are stored **parameterised**, not redacted:

```json
{ "name": "fill_field", "args": { "ref": "bodyFrame|13:0", "value": "{{input.memberId}}" } }
```

That distinction is load-bearing. A redacted transcript is unreplayable — replaying it
types the literal string `[pii:memberId]` into the search field and every later turn
diverges. With the placeholder, the same recording drives the real loop:

```bash
npm run target-app     # restart it first: refs are positional, so the app must be
                       # in the same state it was at record time

npx tsx src/cli.ts discover read-balance   --provider transcript   --transcript evidence/discovery/<run>/transcript.json   --no-save --headless --no-operator
```

This exercises the loop end to end — tool-call validation, ref-to-target conversion,
stall detection, recording, and artifact compilation — with no model and no network.
What it does *not* do is tolerate a changed application: refs are per-observation and
positional, so a member with extra accounts shifts them. It is a regression harness
for this loop, not a general replay mechanism.

## Redaction

Every line of every log passes through the redactor. You can see it working:

- `Signed on: [secret]` — the service account credential, in perception output
- `Member [pii:memberId]` — a declared-sensitive input value
- `mid=[pii:memberId]` — the same value inside a URL, including in the *human's*
  recorded actions

Screenshots mask password fields before capture, not after.
