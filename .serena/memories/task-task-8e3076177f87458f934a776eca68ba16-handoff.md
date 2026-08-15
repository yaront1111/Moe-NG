# Task task-8e3076177f87458f934a776eca68ba16 handoff

## Scope of record
This is SPIDR slice 1 only: frozen provider-run record/refusal contract (DoD 2) plus the four-leg gate (DoD 6). Moved work:
- codec -> task-fc6581042426444a826981943f441908
- normalize composition -> task-ea27beb6e1954d0e9dba8ad49cc1641e
- durable ledger -> task-1a7ff170ee544a3a8a10962c25e2ca5b
- live dispatch consumer -> task-6cbff01023b14b26a78fc5e3eb1dd8a9

Original six-file contract commit is 9d60091561e7f8c5946d89849500d65a7f117fb3 (parent d01a512a984e22c34f3b45c2529a1e6cea0f2934).

## Final adversarial fix
Final review found the original length-framed aggregate id could be 679 bytes for a producer-admitted ProviderRunRef (three 200-byte refs), while @moe/store caps ids at 512 and refused with stable code STORE_INPUT_INVALID. TDD red: provider-run-contracts.test.ts max-ref real SqliteEventStore.readEvents case failed exactly with STORE_INPUT_INVALID. Production now derives a 107-byte namespace + domain-separated SHA-256 of UTF-8 byte-length-framed identity components, pins the exact digest format, calls the real store for the max admitted case, and documents that record readers—not hash uniqueness—remain authority. Refusal store-case assertions now pin family code, store code, layer and outcome.

Mutation drills on the new production surface:
- raw framed output: exact-format test and max-ref store-admission test red; store refusal was STORE_INPUT_INVALID
- omitted attemptRef: exact-format test and named attemptRef separation row red
- unframed digest preimage: exact-format plus four named naive-join collision rows red
Restored SHA exactly; focused result 2 files / 28 tests green; daemon typecheck exit 0; production LOC contracts.ts=204, refusals.ts=104.

## Shared-tree commit hazard
While waiting for the git index lock, the task-6cbff completion hook created foreign whole-tree commit f4966b534ee5e9f9671668795d5dd1e844f0521b and swept the three in-progress fix paths:
- apps/daemon/src/telemetry/provider-run-contracts.ts SHA e151af9295d791fe387bffd830c33bdb46c489d7353bb37a78e82db90dc3cfa9
- provider-run-contracts.test.ts SHA 48cd28ff0c6840641d60ce21ced8db5959a4fe3f08e2cc0ead979ef0807a0075
- provider-run-refusals.test.ts SHA 2ed289482006adf8b4b8762f3b8aad77791db29473ef9d84344002d1452dd106
Committed/live/tested hashes match. Per global rail, do not amend/reset/recommit/empty-commit. QA review command:
`git diff d01a512a984e22c34f3b45c2529a1e6cea0f2934..HEAD -- apps/daemon/src/telemetry/provider-run-contracts.ts apps/daemon/src/telemetry/provider-run-contracts.js apps/daemon/src/telemetry/provider-run-contracts.test.ts apps/daemon/src/telemetry/provider-run-refusals.ts apps/daemon/src/telemetry/provider-run-refusals.js apps/daemon/src/telemetry/provider-run-refusals.test.ts`

## Gate evidence / current blocker
Fresh base daemon: 80 files / 1675 tests, exit 0. Fresh HEAD f496 committed snapshot:
- runner: exit 1, 1 failed / 61 passed files, 1 failed / 2104 passed / 3 skipped tests; only packages/runner/src/platform/windows/windows-boundary.test.ts. Baseline had 7 failed files / 45 failed tests; new failing-path set empty, owned intersection empty.
- scheduler: 43 files / 1326 tests, exit 0
- daemon typecheck: exit 0
- daemon test: exit 1, 2 failed / 90 passed files, 3 failed / 1918 passed tests. Foreign failures: runtime-entrypoint.test.ts missing orchestrator/verifier-process-runner.js; goals/j1-command-path.test.ts two stale goal.close cases refusing GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED. No failing path under owned telemetry.
The reopen note required the raw daemon gate to quiesce, so completion awaits governor ruling or foreign fixes; do not invent green and do not repair those paths.

## Follow-up
The same store-bound defect exists in deriveActivationAggregateId. Architect created focused task task-8f84c56d88504f80aa2fefdf69f093bd to fix it without rekeying already-valid durable rows.
