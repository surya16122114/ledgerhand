# MERIDIAN CORE — evidence

Runs against the live host at `web-sample.interface-hiring.com`, an application this
system had never seen before. Everything here is a real run: a real model driving a
real browser, or a real deterministic replay against real records. Three of these
posted irreversible transactions and did.

The layout is one directory per scenario, each holding the run's
event log (`run.jsonl`), a roll-up (`summary.json`), and — for discovery — the model
transcript (`transcript.json`) that proves the run happened rather than being
described. `screenshots/` and `snapshots/` are populated only when a run fails or
escalates, which is when a richer signal is worth the bytes.

## Discovery — one per capability

Each of these produced the artifact of the same name in `/capabilities`, and each
capability's `provenance.discoveryRunId` points back at the run id here.

| | capability | notes |
|---|---|---|
| `01` | `session.sign-on` | selects a non-default branch, so the input is actually exercised |
| `02` | `member.find-by-name` | search by last name |
| `03` | `member.read-record` | row addressed by share id, never by position |
| `04` | `member.transfer-funds` | posted a real $1 transfer |
| `05` | `member.open-share` | created share `103001-MMKT-10` at $25.00 |
| `06` | `member.place-hold` | signs on as the supervisor: the teller profile is refused |
| `07` | `member.update-contact` | saves on first POST, no review step |

## Replay — deterministic, no model

| | what it shows |
|---|---|
| `08` | a capability replaying against the member it was recorded with |
| `09` | the same recording against a different member and a different row position |
| `10` | `MEMBER_NOT_FOUND` — a legitimate answer, returned as an outcome rather than thrown |
| `11` | `SOURCE_SHARE_RESTRICTED` — a transfer out of a frozen share. Fourteen steps ran correctly and the credit union declined; no money moved |
| `12` | the same transfer *before* the fix, reported as `TARGET_NOT_FOUND`. Kept deliberately: the business-outcome handlers were attached by a button-label word list that did not include "Continue", so a legitimate refusal surfaced as a hard failure. `11` is the same scenario afterwards |

`12` is the one worth reading next to `11`. The difference between them is the
difference between a system that says "the bank said no, and here is why" and one
that says "something broke".
