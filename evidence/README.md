# Evidence: start here

| Folder | Contents |
|---|---|
| `assignment-1/original-submission/` | Original local discovery logs, replay examples and artifact copies |
| `assignment-2/original-recordings/` | Meridian discovery and early replay evidence |
| `assignment-2/past-verifications/` | Hosted verification results and later safety checks |
| `demo/` | Backup video (`demo.webm`) |
| `runs/` | Ignored runtime workspace used by run history and statistics; not the curated demo collection |

Many similar names are separate test executions, not duplicate runnable capabilities. An evidence capability copy identifies what a past run used; the active library lives under root `capabilities/`. Nothing was deleted in the reorganization.

Historical logs preserve their original path strings to avoid rewriting recorded evidence. `PATH-MIGRATION.json` records the earlier folder reorganization. Some destinations were subsequently archived outside the repository; it is a historical map, not a guarantee every destination ships in this submission. Current scripts can regenerate verification batches.

For the demo, open `demo/demo.webm`, the original recordings for the relevant assignment and their run summaries. Do not imply every historical failure has been resolved or every old run was executed today.

Repeated local verification batches, standalone transaction-test evidence, exploratory sign-on and the extra review-boundary capture are archived outside this repository. The retained hosted `past-verifications/runs/` collection supports dashboard history and stability calculations. Raw runtime runs remain ignored. Reports and aggregate matrices may reference historical runs; use individual run IDs and timestamps when assessing a claim.
