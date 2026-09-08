# Test layout

Run all non-browser tests with `npm test`. Run real-browser checks with `npm run test:browser`; keep the local target running with `npm run target-app`. The browser suite is separate because it needs Chromium and local application access. Neither command is the complete hosted Meridian verification batch.

| Directory | Responsibility |
|---|---|
| `agent/` | Model-provider backoff behavior |
| `api/` | HTTP contracts, chat orchestration, result envelopes and run history |
| `artifact/` | Schema, recorder, saved search binding, product profiles, overlays and stability |
| `config/` | Environment configuration |
| `escalation/` | Control ownership, intervention broker and operator server |
| `evidence/` | Persisted intervention privacy and capture failure reporting |
| `policy/` | Allowlist, action/risk gating, Meridian guards and transaction validation |
| `replay/` | Input/condition binding, extraction and condition evaluation |
| `surface/` | Target matching logic |
| `browser/` | Real-browser perception, safety/handoff, API handoff and dashboard locking |
| `helpers/` | Reusable synthetic observations and controls; not a test suite |

Test counts are reported by the runner; use the executed output rather than a static count as verification.

For a focused run, supply the current path, for example:

```bash
npx vitest run tests/policy/transaction.test.ts
npx vitest run --config vitest.browser.config.ts tests/browser/safety-and-handoff.test.ts
```

Keep these executable tests with the source code in version control. Personal audit reports and demo rehearsal notes are separate from the test suite.
