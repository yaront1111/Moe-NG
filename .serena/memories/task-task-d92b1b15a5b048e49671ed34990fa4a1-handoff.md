# task-d92b1b15a5b048e49671ed34990fa4a1 handoff — COMPLETE, in REVIEW (worker-1fe6c848, 2026-08-16)

All 6 steps DONE. Task handed to QA. Commit **f33d4a2** on `moe/work-2026-08-08`.

## What is where

`git diff e9b3796..HEAD -- <eight owned paths>` is the review surface, NOT a single commit.
- f33d4a2 (mine, explicit pathspec, 2 files): `activation-ledger-reader.ts` +56/-16, `foundation-launch-authority.test.ts` +10/-1.
- The other six owned paths were already in the tree from earlier FOREIGN whole-tree sweeps (6ca5da0 etc.): +146 foundation test, +68 `event-read-model-contract.test.ts`, +13 `event-read-model.ts`, +4 `sqlite-event-store.ts`, +2 `decision-ledger.ts`.
- Committed bytes hash-match the gated bytes: reader `45fcc7a963612578e87ce5c46e35efd3f42d36ce761d668faadf5c88fb62e26a`, foundation test `7e9ac12ec050ade280f4f4408a4a59a618711cd8fb8be9b4b9dd90c8ba59a3de`. `activation-ledger-commit.ts` `832cdc13...` = drill baseline, unmodified.

## Design (do not weaken)

`readEventHorizon(): bigint` on `EventReadModelStore` — one scalar `SELECT CAST(COALESCE(MAX(global_position),0) AS TEXT)`, `"0"` -> `0n`, nonzero through the canonical positive-bigint durable-row validator so >2^53 stays exact. Forwarded through `DecisionLedgerCore`, its frozen facade, `SqliteEventStore`. No schema/version/index/codec/barrel/manifest change.

`scanForEffect` calls `captureHorizon()` EXACTLY ONCE, then `while (cursor < horizon)` requesting `min(SCAN_PAGE_SIZE, H-cursor)`. Per item: position must be exactly the next contiguous value AND `<= H`. Per page: non-empty/progress, `nextCursor === last position`, `hasMore === (position < H)`. Throw -> `EVIDENCE_UNREADABLE`; every shape violation -> `SCAN_INCOMPLETE`. **No early return on a hit** — a second distinct aggregate past the old 6,400 bound still refuses exact `FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS`.

Defect 1 lives at the COMMIT site: `activation-ledger-commit.ts:158-161` filters the aggregate to `ACTIVATION_LEDGER_EVENT_TYPE` and hands the singleton to the strict reader. Do NOT move that filter into the reader — a lone wrong event type must stay `EVENT_TYPE_UNEXPECTED`.

## Gate actually run (governor 01:22Z rescope)

One foreground command, EXIT 0: `pnpm --filter @moe/store typecheck; pnpm --filter @moe/daemon typecheck; (cd packages/store && npx vitest run --root ../.. packages/store/src/event-read-model-contract.test.ts); (cd apps/daemon && npx vitest run --root . --config package.json src/activation)`.
Counts: store contract **1 file / 25 tests**; activation **7 files / 94 tests**. Both scoped typechecks 0 **with NO exclusions** — the `activation-ledger-aggregate-id.test.ts` exclusion reopen-1 QA needed is DEAD; that suite is green now (7, not the required 6).

Package/repo legs read separately: STORE_TEST=1, DAEMON_TEST=1, VERIFY_STORE=1, VERIFY_FOUNDATION=0, ROOT_TYPECHECK=0, ROOT_TEST=1. Delta ∩ owned paths = EMPTY.

## Foreign red at handoff (disclosed, never repaired)

- `packages/store/src/recovery-anchor.test.ts:694` "RECOVERY_ANCHOR_FAULT_POINTS leaked onto the root". grep-count on `packages/store/src/index.ts`: 0 at e9b3796, 1 at HEAD; `git log -S` names foreign `4e0201a` (task-0c89476b). Store 1 failed | 513 passed.
- `apps/daemon/src/orchestrator/agent-spawner.test.ts` x3, "expected [] to include ''" at :168 — `agent-spawner.ts` last touched by foreign `c970f10` (task-ff589abd).
- `apps/daemon/src/work/foundation-attempt-windows.test.ts` "launches through the shipped broker once and adopts replay", "expected false to be true". Daemon 4 failed | 1990 passed.
- `packages/runner/src/providers/claude/claude-launcher.windows.test.ts:178` (foreign c970f10).
- `tests/integration/release-archive-cleanup.test.ts` x2 — last touched AT the merge-base e9b3796 itself, pure baseline. Root 4 failed | 6579 passed.

BASE PROBE was required, not optional: `foundation-attempt-service.ts` really does import `readFoundationActivationHistory` from my owned reader. Reverted ONLY the production file to HEAD bytes (probe sha `7c7d1a9f...`), re-ran both daemon files, the SAME 4 test NAMES failed (2 files, 4 failed | 19 passed), restored by `cp` from an out-of-repo copy with hash re-verified.

## Mutation drills (all 5 + 2 extra, byte-exact restores)

1. whole-aggregate replay input -> tailed replay test RED, two-activation guard stayed independently green.
2. 64-page ceiling reinstated -> literal 6,500-event test RED on `SCAN_INCOMPLETE`.
3. captured-H comparisons deleted -> moving-stream child RED at 2021ms `WATCHDOG_TIMEOUT` (reproduces QA's exit-124 hang).
4a/4b/4c. continuity clause / overshoot clause / refusal code -> hostile generated case RED on literal code AND layer.
5. return on first match -> late-second-match test RED.

Adversarial self-review BEFORE the drills caught that the five original hostile cases all refused via the cursor/`hasMore` checks, leaving BOTH halves of the per-item guard as surviving mutants. Added "positions mislabelled" and "overshoots horizon"; cardinality literal 5 -> 7. See `mem:gotcha-generated-case-sweep-leaves-guard-clauses-unkilled`.

## Open items

Production physical lines: reader 375, commit 227, sqlite 372, decision-ledger 151, event-read-model 109 — all under the 400 split, none refactored.

DISCLOSED TRADE-OFF (plan-approved, not a deviation): requiring `hasMore === false` AT H means a concurrent append during a scan refuses `UNKNOWN`/`SCAN_INCOMPLETE` instead of answering. Fails closed, retry succeeds. Weigh it in follow-up performance/index task `task-16d5bc3a10864351adf5be10dfa7df00`; **no index was added here**.
