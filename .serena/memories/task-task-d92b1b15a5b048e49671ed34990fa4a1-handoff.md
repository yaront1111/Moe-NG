# task-d92b1b15a5b048e49671ed34990fa4a1 handoff (worker-1fe6c848, 2026-08-16 reopen 1)

Steps 1-5 DONE and green. Step 6 (final gate) BLOCKED on foreign red inside the two owned packages.

## What landed this session (steps 3-5)

Working tree at HEAD `d447a34`, task merge-base `e9b3796`. Two owned files modified, UNCOMMITTED:
- `apps/daemon/src/activation/activation-ledger-reader.ts` sha256 `45fcc7a963612578e87ce5c46e35efd3f42d36ce761d668faadf5c88fb62e26a`, 375 physical lines
- `apps/daemon/src/activation/foundation-launch-authority.test.ts` sha256 `7e9ac12ec050ade280f4f4408a4a59a618711cd8fb8be9b4b9dd90c8ba59a3de`

Out-of-repo byte copies: `/d/tmp/d92-drills/reader.mine.ts` and `/d/tmp/d92-drills/foundation-launch-authority.test.mine.ts`. If a foreign whole-tree commit sweeps them, that is the known hazard - verify by `git diff e9b3796..HEAD -- apps/daemon/src/activation`, not by looking for a commit bearing this task id.

Design: `captureHorizon()` reads `store.readEventHorizon()` EXACTLY ONCE (throw -> EVIDENCE_UNREADABLE; non-bigint or negative -> SCAN_INCOMPLETE). The rejected `for (;;)` became `while (cursor < horizon)` requesting `min(SCAN_PAGE_SIZE, H-cursor)`. Per item: position must be exactly the next contiguous value and <= H. Per page: non-empty/progress, `nextCursor === last position`, `hasMore === (position < H)`. No early return on a hit, so a second distinct aggregate still refuses EVIDENCE_AMBIGUOUS.

## Cross-package edge (step 3, all three re-measured fresh)
(a) `apps/daemon/package.json:22` `"@moe/store": "workspace:*"`. (b) lock importer `apps/daemon` -> `'@moe/store' version: link:../../packages/store`. (c) trap-cleaned probe under `apps/daemon/src` importing the BARE `@moe/store` typechecked exit 0 and was deleted (PROBE_DELETED=YES). The old blockedReason (foreign TS2322 in `apps/daemon/src/review/verifier-receipt-ledger.test.ts`) is DEAD - that file is gone and daemon tsc is exit 0.

## Mutation drills (all restored byte-exact by `cp` from out-of-repo copies, never `git checkout`)
Baselines: reader `45fcc7a9...`, commit `832cdc13...`.
1. commit.ts `activations` -> `events`: tailed replay test RED, "TWO activation events as AMBIGUOUS" stayed GREEN.
2. 64-page ceiling reinstated: literal 6,500-event test RED on `FOUNDATION_BINDING_SCAN_INCOMPLETE`.
3. all three captured-H comparisons removed: moving-stream test RED at 2021ms `WATCHDOG_TIMEOUT` - QA's exit-124 hang reproduces exactly.
4a/4b. continuity clause / overshoot clause dropped: hostile-shape test RED both times ('ABSENT' vs 'UNKNOWN').
4c. contiguity guard's refusal code swapped: RED on the literal code assertion.
5. return on first match: late-second-match test RED, lost the AMBIGUOUS refusal.

Adversarial review found the five committed hostile cases left BOTH halves of the per-item guard as surviving mutants. Added "positions mislabelled" and "overshoots horizon" and raised the cardinality literal 5 -> 7.

## Why step 6 blocked
Owned-package typechecks are 0; owned-package TEST legs are 1, both from foreign deterministic red. See `mem:gotcha-foreign-red-inside-your-own-owned-package`. Base probe (my production file reverted to HEAD bytes) reproduced the daemon failures IDENTICALLY, so none of it is mine.

## For the next agent
Do NOT redo steps 1-5 and do NOT weaken the horizon contract. Re-run the plan's exact gate; if `packages/store/src/recovery-anchor.test.ts` and the two daemon files are green, complete_task immediately with that output. Follow-up performance/index task is `task-16d5bc3a10864351adf5be10dfa7df00`; no index was added here.

Disclosed trade-off (pinned by QA and the approved plan, not a deviation): requiring `hasMore === false` AT H means a concurrent append during a scan makes that lookup refuse UNKNOWN/SCAN_INCOMPLETE rather than answer. Fails closed, retry succeeds; worth weighing in the index follow-up.
