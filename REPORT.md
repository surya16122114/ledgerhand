# Ledgerhand — design report

## Architecture

I designed Ledgerhand to learn a workflow through real UI interaction, saves it as a capability, and executes it again without a model choosing browser actions. Discovery, recording, replay, policy, evidence and handoff are separate modules in one TypeScript process. Playwright is the implemented browser driver. The local CorePoint fixture and independently hosted MERIDIAN CORE exercise the same engine.

A `Surface` interface separates observations and actions from recorded workflows. Discovery and replay use `LeaseGuard(PolicyGate(surface))`: automation must hold control and satisfy policy before acting. The browser also checks outgoing request destinations before dispatch. Human operation uses the same page and browser context through a separate operator transport.

The HTTP API, chatbot and dashboard call the same invocation function. Chat chooses named capabilities with typed arguments; it receives no browser tools. The service permits one mutation request at a time. Invocation is synchronous, including while waiting for an operator; intervention and history endpoints remain available. A reverse proxy would need suitable timeouts. Production deployment would use a durable job queue and asynchronous completion. Filesystem storage and an in-memory intervention queue keep this local demo inspectable; active sessions do not survive a process crash.

## Artifact schema

A capability is validated, versioned JSON: product and tenant identity, typed inputs and outputs, ordered actions, semantic targets, checkpoints, business outcomes, recovery handlers, policy and provenance. It is separate from the model transcript. Credentials are vault references. Input values become placeholders, and captured outputs can bind later reads to the same record identity. A full table can be returned as typed text, retaining all rows without a fixed share count.

Targets have ordered strategies such as role/name, adjacent label, row key/column header and a last-resort DOM hint. The model selects perceived references; the system constructs the target descriptors. Primary strategies avoid generated IDs and row positions. Artifacts are linted before saving, and new versions preserve earlier recordings. Approval is manual; unattended invocation rejects drafts. Catalog stability is calculated from terminal run summaries matching the exact artifact digest, not by modifying recordings after each run.

## Determinism & error handling

Replay loads the artifact, validates arguments, resolves current controls, performs saved actions and verifies checkpoints. It does not invoke an LLM. Conditions and bounded product handlers separate expected business outcomes, recoverable interruptions and hard failures. Results retain step identity, expected/observed state, timing, locator fallbacks and recovery details. A successful business outcome is not an automation crash.

Maintenance acknowledgements and session expiry have explicit handlers. Irreversible actions are not automatically retried when their confirmation is uncertain. Runtime-classified writes also block automatic dismiss and reauthentication recovery after dispatch. Meridian final-post payloads are checked against the invocation inputs before network dispatch; mismatches fail closed. Missing targets, unhandled conditions and exhausted recovery on a usable session can request human intervention. A closed browser or invalid configuration cannot be repaired by manual UI input and fails explicitly.

## Heterogeneity & multi-tenant

Observations normalize controls independently of the underlying DOM. A desktop driver would translate UI Automation or macOS accessibility controls into the same vocabulary. Desktop launch specifications, executable allowlists and screen transport require additional implementation; desktop execution is not claimed. See `src/surface/desktop/README.md` for the mapping and limitations.

Reuse is keyed by vendor product. Tenant overlays map labels/routes and support explicit step patches and interrupts. One CorePoint recording was replayed against the Riverstone fixture with different labels, routes and an acknowledgement screen. Unmapped tenants are rejected unless explicitly permitted. Locator fallback events and digest-specific reliability measurements expose drift. Scheduled canaries, version compatibility validation and automatic demotion are future work; significant flow divergence requires review or re-recording.

## Escalation & handoff

Discovery detects repeated actions without progress and supports an explicit help tool. Interventions include goal/capability, step or discovery turn, attempted action, reason, current location and evidence. Raising an intervention cedes the control lease immediately. The operator claims the live session, acts through the console, and chooses resume, authorize-and-resume, skip or abort. Automation cannot mutate the page while the operator owns control.

The recorder attaches once per page and switches its action sink for successive interventions. Clicks, committed field changes and navigation are captured; password values are omitted. Control transitions and redacted intervention records remain associated with the run. On resume, checkpoints are inspected before another action. Single-action authorization is distinct from approving an artifact. A timeout aborts rather than implicitly granting permission. This is a local handoff mechanism, not authenticated multi-user remote administration.

## Safety

Action and destination allowlists are explicit; deny patterns win. Browser requests are checked before dispatch during automation, with frame-location checks as a second defense. During operator ownership, the automation request allowlist and payload guard are bypassed. The human is trusted and operates under the target application's entitlements. Risk classification uses product-specific committing terms and known navigation controls; unknown buttons require authorization. Labels remain a heuristic, so reviewing an unfamiliar product's semantics is still necessary. A resolve/act race remains a limitation on rapidly changing interfaces.

Vault values, declared sensitive inputs and observed values inform redaction. JSONL events and persisted interventions are scrubbed; saved input/output history withholds sensitive values. Failure screenshots hide text/form/media content, and snapshots remove text, attributes and hidden fields. Capture/write failures are reported explicitly. Redaction is not universal PII recognition: old evidence is historical and is not served as newly sanitized evidence. Current callers receive requested outputs in memory and must handle them appropriately.

## Cuts

Not built: desktop execution, generated test code, LLM-assisted replay recovery, distributed queues, production authentication, scheduled drift checks and automatic approval. The two stretch features emphasized are the callable capability interface and cross-tenant reuse; approval and multi-run statistics support those features.

With more time, I would prioritize:

1. **Resolve and verify the hosted contact-save confirmation failure.** Reconcile the target state, identify why the expected checkpoint is absent, and demonstrate a completed dashboard-to-operator-to-replay write without weakening retry safeguards.
2. **Schedule read-only canaries per tenant.** Run saved capabilities against representative inputs to detect vendor changes before a caller encounters them. Local cross-tenant replay exists; scheduled monitoring does not.
3. **Add confidence-based promotion and demotion.** The original Assignment 1 report proposed persisting reliability separately from immutable artifacts. The current catalog now derives stability from persisted summaries matching the artifact digest. Automatic approval, demotion and a durable approval-time reliability snapshot remain future work.
4. **Harden operator access and recovery.** The same-session console is implemented. Authenticated operators, queue filtering, action playback and reviewed conversion of manual steps into new artifact versions would make it suitable for broader use. A resolution handle could also close the policy gate's resolve-then-act race.
5. **Consider bounded assisted recovery after the deterministic core is stable.** A single policy-checked model suggestion could help with a missing target, with evidence and review before changing a recording. It must not retry an uncertain transaction or turn replay into an open-ended agent loop.

If starting again, I would test checkpoint synthesis against a second member and tenant earlier. That exposes recorded values accidentally treated as page structure before they spread into multiple capabilities. These priorities retain the original report's drift, confidence and operator-hardening plans while distinguishing what has since been implemented.

Setup and exact demo commands are in README.md. Real discoveries, deterministic replays and backup video are in `evidence/`. A fresh clone of the final submitted commit must be rehearsed separately. README.md distinguishes historical verification from the unresolved hosted contact-update confirmation. Adaptation details are in `docs/ADAPTATION.md`.
