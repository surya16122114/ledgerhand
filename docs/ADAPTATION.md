# Adapting Ledgerhand to MERIDIAN CORE

Ledgerhand discovers a UI workflow with an LLM, compiles a typed capability, and replays that capability without a model making browser decisions. Meridian exercises the same engine against an independently hosted, server-rendered servicing console. I adapted the system by adding a product profile, goal presets, recorded capabilities, and a small API/chat/dashboard surface.

## What changed

The surface contract, capability/replay architecture, and control lease survived the adaptation. The implementation inside those boundaries needed changes: adjacent-table labels, link-wrapper filtering, password-fill feedback, and unlabelled status-line perception; product-specific runtime outcomes and committing verbs; and URL canonicalization that removes record-time member IDs. These were real fixes, not a claim that the second application required no code changes.

Discovery remains the source of the recordings. The updated contact capability was recorded by the model against the live target and replayed with different email, phone, and mailing address values. Every returned contact value is checked against the requested input. Last-name search reads the first result's member number, then binds the name extraction to that captured identity. It has no positional fallback for the second read: a missing row fails instead of pairing two different people.

Original artifact versions remain as historical evidence. The callable catalog advertises the newest version for each capability, and invocation loads exactly that advertised version. A new recording can be saved with `--version` without overwriting its predecessor.

## API contract and demo

Run `npm run cli -- serve --headed`, then open `http://127.0.0.1:4190/`. Invoke selects a capability and supplies its typed arguments. Chat uses the same catalog and a bounded capability-call loop; it never receives browser tools. Teach performs real discovery. Runs & evidence shows history, current processing, operator links, step results, recoveries, and sanitized diagnostic files.

`GET /capabilities` returns the callable contracts. `POST /capabilities/:name/invoke` accepts `arguments` plus optional `authorize: {by, reason}`. Success and expected business outcomes return HTTP 200 with distinct envelopes; invalid inputs return 400; an abandoned escalation returns 409; upstream failures return 502. Recovered steps remain successful and keep their recovery details. Destinations are server-owned configuration: an invocation cannot redefine its base URL or loosen a server requirement for unattended approval.

One request at a time is intentional for this single-operator demo. The server enforces it, and the dashboard locks all mutation controls while keeping history and the operator session accessible. A pending run exposes its same live browser through the existing operator console. The human can claim it, act, and return control. The browser is kept alive while waiting; the console is closed with the session.

## Legacy UI and runtime behavior

Native browser form submissions carry the current hidden token from the live page, including review/post forms; the artifact never stores a token. Transfers, share opening and holds reach their review and post screens through recorded UI actions. Product-specific committing verbs are now enforced by the runtime policy gate as well as recorded as metadata. Discovery's denied routes survive compilation and replay, including for older artifacts through the compatibility default.

The product profile distinguishes not-found, insufficient funds, validation and permission outcomes from recoverable maintenance/session conditions and hard application errors. Recovery is bounded. Irreversible retries are conservative because a missing confirmation cannot prove that a post did not happen. Sandbox verification uses per-request injected faults rather than changing the shared global settings.

## Safety, evidence and limits

Credentials resolve from the vault immediately before entry. Inputs and observed field values inform text redaction. Persisted screenshots hide text/form/media content; DOM snapshots retain structure but omit text, attributes, scripts and hidden inputs. Saved history withholds nonpublic input/output values; the current caller receives the structured result in memory. Only new sanitized evidence is served by the dashboard, with restricted paths and inert content types. Original historical evidence is not silently rewritten or exposed as newly sanitized evidence.

Desktop execution, operator authentication, distributed scheduling, and a durable multi-worker queue remain deliberate cuts. The local operator console and HTTP server bind to the workstation. First-result search is a thin contract; a production assistant should offer an explicit result-list/disambiguation flow. Catalog stability is derived from terminal evidence for the exact artifact digest; successful business outcomes count as successful executions. Historical runs without a recorded digest are excluded. The README separates the executable verification suites and remaining live checks.


## Transaction-boundary hardening

Final transfer, open-share and hold requests are checked against the validated invocation: member identity, each transaction field, and a single nonempty token. Numeric amounts allow equivalent decimal formatting. A mismatch aborts the request before network dispatch and returns TRANSACTION_MISMATCH without logging the payload. This validates submitted transaction data, not every visual label on the review screen; token freshness remains the target server's responsibility.

The engine remembers runtime-classified irreversible dispatches, even if old artifact metadata understates risk. It refuses automatic retry, dismiss or reauthentication recovery after a possibly committed write and requests human reconciliation. This is not an exactly-once guarantee across separate invocations, process crashes, or an operator explicitly choosing to repeat an operation.

Historical controlled transaction tests counted server posts, but those separate test pages have since been removed. Their saved results are historical evidence, not current test coverage. The live review-boundary script aborts final posts locally and verifies payload compatibility, not transaction completion.

### Manual control trust boundary

While the control lease belongs to the human operator, the browser request guard bypasses both the automation URL allowlist and outgoing transaction checks. The operator is trusted to make the manual decision; target-side permissions still apply. Automation is paused, and manual actions remain recorded. Returning control restores the automation guards. This local demo is not an access-control boundary against a malicious operator; production deployment needs authenticated operators and an explicit manual-access policy.

Meridian runtime rules now deny automation access to `/settings` and `/admin`, classify the observed contact-validation banners as business outcomes, and validate the contact-update payload before its first POST. These rules also protect existing recordings without re-recording them.


### Verification boundary

Eight current hosted capabilities cover sign-on, member inquiry, record/balances, transfer, share opening, contact update and hold. List-shares is the additional balance-table capability. The saved verification batches include success, business outcomes and injected faults; these are past executions against mutable sandbox data.

A later dashboard contact-update run (`replay-20260908T001550-d711dd`) demonstrated claim, manual interaction, authorization and resumption on the same browser session. Its save then lacked the expected confirmation, and the engine requested reconciliation instead of retrying. That run does not establish successful write completion; investigating the missing confirmation remains next work. All current hosted artifacts are drafts, so they are callable in attended mode but not yet approved for unattended use.

With more time I would resolve that confirmation failure, rehearse the final clean clone, add result disambiguation, and introduce authenticated operators and durable jobs. I used AI assistance during implementation; the architecture and limitations described here are the choices I am presenting.
