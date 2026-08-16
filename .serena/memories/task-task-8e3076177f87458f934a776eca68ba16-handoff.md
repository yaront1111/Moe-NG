# Task task-8e3076177f87458f934a776eca68ba16 — QA APPROVED 2026-08-16 (qa-c7cedba3)

## Scope graded
Governor comment 2026-08-15T18:01Z is the scope of record: SPIDR slice 1 = **DoD 2 + DoD 6 only**.
DoD 1/3 -> task-ea27beb6; DoD 4 + real-store half of 5 -> task-1a7ff170; codec -> task-fc658104.
Gate premise rescoped by human-approved governor unblock 2026-08-16 00:39Z to the
path-attributed baseline rail. I graded under both; rejecting on DoD 4 would have graded
another task's work.

## What I re-ran (not inherited from the worker)
LEG 1, exit 0 required:
- scoped daemon tsc over the four owned .ts -> exit 0. Non-vacuity proven myself with
  `--listFiles`: all 4 owned files present in a **521-file** program, zero codec files.
- owned suites `vitest run --root . --config package.json provider-run-contracts.test
  provider-run-refusals.test` -> exit 0, `Test Files 2 passed (2)`, `Tests 32 passed (32)`.
LEG 2, path-attributed (owned = apps/daemon/src/telemetry/provider-run-{contracts,refusals}.*):
- `pnpm --filter @moe/daemon typecheck` -> **exit 0** (the worker's 2 review-slice TS2741 are gone)
- `pnpm --filter @moe/daemon test` -> exit 1, `Test Files 3 failed | 94 passed (97)`,
  `Tests 7 failed | 1986 passed (1993)`: activation/foundation-launch-authority,
  orchestrator/agent-spawner, work/foundation-attempt-windows. All outside src/telemetry/.
- `pnpm --filter @moe/runner test` -> exit 1, 1 file: claude-launcher.windows.test.ts >
  "stays alive beyond the control poll slice". Reproduces for me too; this task changed ZERO
  runner bytes. Belongs to task-ff589abd's review (c970f10), load-sensitive.
- `pnpm --filter @moe/scheduler test` -> exit 0, `Test Files 43 passed (43)`, `Tests 1326 passed`.
- HEAD-failing-paths ∩ owned = EMPTY, so delta ∩ owned = EMPTY.

## My own mutation drills (worker's drills confirmed, not taken on trust)
- Deleted `PROVIDER_RUN_EVIDENCE_AMBIGUOUS` from PROVIDER_RUN_LEDGER_CODES -> refusals suite RED
  on both membership cases (`expected [ …(16) ] to deeply equal [ …(17) ]`, `expected 16 to be 17`).
  Proves the expected list is hand-written, not self-derived.
- Added `"STORE_BUSY"` -> scoped tsc RED at provider-run-refusals.test.ts(135,69) TS2554.
  Proves the store-half disjointness guard (`Extract<ProviderRunCode, DurableStoreErrorCode>` =
  never) bites AND that the scoped-tsc leg really covers the test file.
- Both restored, sha256 re-verified: refusals.ts 7e4b9862ed24…, contracts.ts e151af9295d7…,
  `git status --porcelain` on owned paths empty.

## DoD 2 field audit (nouns counted, producer shapes grepped)
providerRunRef whole ✓ | declared (ClaudeLaunchSelection: reasoningEffort ✓, profileRevisionId ✓)
| observedModel SEPARATE from declared ✓ | launch (runtimeBinding/quoted/fresh/pinnedClosure
digests + startedAt/completedAt) ✓ | observedStart/End: ClockObservation
(serverWallSeconds + monotonicObservation + bootId) ✓ | terminal, infrastructure, tokens.coverage,
steps.coverage, concurrency ✓ | usage: NormalizedMeasurement[] whose .pricebookBinding is the
cost basis ✓ | stdout/stderrReceiptDigest ✓ | recordDigest ✓ | every field readonly ✓.
Rails: two provenance fields disjoint (upstreamRefusal vs usageRefusals) ✓; store port names only
commitExpectedVersionDecision/getCommandDecision/readEvents, no *WithApply ✓; no producer type
re-declared locally ✓; PROVIDER_RUN_RECORD_UNREADABLE present for slice 2 ✓.
Files 204 / 104 production lines (cap is per FILE, 250 target); bridges are exact LF bytes
`export * from "./provider-run-{contracts,refusals}.ts";` verified with `od -c`.
Both task commits (9d60091, cf137c6) touch owned paths ONLY; no scratch in either.

## Consumer edge already materializing
Slice 2's uncommitted WIP (provider-run-codec.ts / .validation.ts) already imports
PROVIDER_RUN_RECORD_VERSION, ProviderRunRecord, PROVIDER_RUN_LEDGER_CODES/LAYERS. Nothing outside
src/telemetry/ imports these modules, which is also why the 3 daemon reds cannot be this diff.
