# Fair scheduler production — QA verdict: APPROVED (qa-f3560083, 2026-08-10)

Commit `3e03279`. Gate re-run by QA: `pnpm --filter @moe/scheduler test` = 41 files / 1047 tests,
exit 0. `pnpm --filter @moe/scheduler typecheck` exit 0.

## What I verified independently, not from the worker's summary

**9 mutation drills of my own**, each reddening its named test, each restored byte-identical
(`git hash-object` before/after, FINAL HASHES MATCH: True):
| drill | red |
|---|---|
| `if (index < 0) continue` -> `break` (kill the empty-queue skip) | 2 |
| drop `.sort(compareStrings)` in `orderedResourceIds` | 1 |
| derive queue order from entry array position | 1 |
| `safeAdd` returns `sum` unguarded | 2 |
| `checkPromotionHeadroom` always returns null | 2 |
| `readProvenBypasses` swallows the evidence verdict (`return 0`) | 3 |
| **layer only** RING -> RESOURCE on one refusal | 1 |
| **code only** CARDINALITY_EXCEEDED -> INVALID_IDENTITY, same site | 1 |
| `forced: earnsForcing && !withheld` -> `earnsForcing` | 1 |

Layer-only and code-only reddening the SAME test separately is the epic-rail-6 proof that both
halves are pinned independently. This is the check worth repeating on every fairness task.

**DoD 3 drilled with real imports, not read**: injecting `import { PRIORITY_LADDER } from
"@moe/testkit";` AND a relative `../../../testkit/src/...` import into `fairness-rotation.ts` each
reddened `package-boundary.test.ts > keeps DEVELOPMENT_ONLY reference code out of scheduler
production sources`. The guard reuses the package tokenizer, so the three prose citations of the
reference path in `fairness-contract.ts:11` / `fairness-evidence.ts:7` / `fairness-ring.ts:9` stay
legal — a raw grep would have flagged them. Floor `MINIMUM_PRODUCTION_SOURCES_SCANNED = 60` plus 5
named witness paths, so a narrowed scan cannot pass on the floor alone.

**Constant drift checked against the reference myself**, since production cannot import it:
`DEFAULT_M_D = 10_000` (fairness-policy.ts:8) == `FAIRNESS_DIMENSION_CEILING`;
`BYPASSES_PER_LEVEL = 8` (:25) == `FAIRNESS_BYPASSES_PER_LEVEL`; `PRIORITY_LADDER` P0..P3 (:17-22)
== `FAIRNESS_PRIORITY_LADDER`; `bucketsToForced` P0=1..P3=4 == `bypassesToForced` 8/16/24/32. No
drift, so the "no fairness-constant change without approval" scope bar holds.

## Per-file cap
248 / 250 / 224 by `grep -c ''`. `index.ts` is 273 but pre-existing and this task's 24 lines are
PURE INSERTIONS (zero deletions in `git show`), so no neighbouring export was reflowed on a
contended file.

## Disclosed, deliberately NOT a rejection
A permanently capacity-blocked queue is still credited every advanced round, so its deficit grows
without bound and eventually refuses `FAIRNESS_CONTRACT_INVALID_COUNTER`. That is fail-closed with a
stable code (epic rail 4) and a documented classic-DRR trade-off — dropping the credit would turn a
transient block into lost share. Recorded so a later task does not "fix" it into a fail-open.

## Scope
`index.ts`, `index-surface.test.ts` and `package-boundary.test.ts` sit outside the stated owned
paths (`packages/scheduler/src/fairness/**`) but plan steps 7 and 8 name them explicitly. Plan-
authorised, not creep.
