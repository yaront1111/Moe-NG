# task-311adb23 — Execution claim successor closure — QA APPROVED (3rd submission, reopenCount 2)

Approved 2026-08-14 by qa-50f0d628 after two rejections on ONE invariant
(exact-snapshot / no-aliasing at the `work.claim` authority boundary).

## What finally closed it

`mirrorList` (apps/daemon/src/work/work-claim-shape.ts:139-143) stopped being a
second, weaker copy routine. It now routes the array through the SAME
`detachList`/`detach` recursion every deep section already used, so `liveClaims`
elements reach `countOccupyingSlots` as daemon-owned own data. Accessors,
inherited prototype fields, element proxies, functions and holes die
CATEGORICALLY instead of case by case. `work-slot-ceiling.ts:20-26`
(`isExactClaim`) adds the exact 3-own-key element check for extras.

Only caller of `countOccupyingSlots`/`checkSlotCeiling` is `claimWork`
(work-claim.ts:175), so the mirrorList detach is the whole production path.

## Gate re-run by QA (not trusted from the worker)

`pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test &&
pnpm --filter @moe/scheduler test` -> exit 0, daemon 69 files / 1491 tests,
scheduler 43 / 1319. (Worker recorded 1479 daemon tests at commit time; +12 is
foreign daemon growth, not a discrepancy in owned paths.)

## QA's own mutation drills — the decisive evidence

Both applied with the Edit tool, reverse-edited, sha256 confirmed restored
(shape f714c470…, ceiling 85e3158e…).

- **D-A**: `detachList` line 56 -> `depth === 0 ? descriptor.value : detach(...)`
  i.e. mirrorList forwards its own elements by reference. Exactly **12** reds,
  all `liveClaims.0` cases: the accessor case failed `expected 1 to be +0`
  (probe.hits — literally reject #2's reproduction) and the transparent-proxy
  case returned `WORK_GRANTED`. Precise isolation, no env-wide over-reddening.
- **D-B**: dropped the `keys.every(... includes)` clause in `isExactClaim`.
  Exactly **1** red, the new `entry carrying an extra own key` case at leg
  `slotCeiling`.

Note on D-B: the obvious mutation `keys.length >= LIVE_CLAIM_KEYS.length` is an
EQUIVALENT MUTANT — the `every(includes)` clause still rejects the extra key, so
nothing reddens. Had to delete the key-membership clause, not the length one.

## Test-side shape worth copying

- `HOSTILE_TARGETS` = mechanical descriptor walk (`discoverNodePaths`) pinned
  against a hand-written `EXPECTED_NODE_PATHS` (26 entries), with
  `liveClaims.0` and `slot.rows.0` asserted BY NAME. Base `validPayload()`
  carries one RESERVED live claim so the element depth can exist at all.
- 260 structural + 6 content + 10 live-claim + 9 malformed-table cases; every
  one asserts code/leg/layer/upstreamCode, absence of all 5 SUCCESSOR_KEYS, and
  `probe.hits === 0` BEFORE decoding the outcome.
- Two property tests no fixture matrix can replace: whole-graph zero-read
  (25 nodes / 94 counting accessors, hand-counted) and a recursive
  identity + descriptor walk over input vs published graphs — the latter is the
  only thing that catches the `EFFECT_INTENT.leaseBinding === LEASE_RECORD`
  alias a JSON/top-level comparison sails past.

## Rails

Per-file physical lines: shape 144, claim 195, slot-ceiling 77 — all <=250.
`work-kernel.ts` 261 is pre-existing, untouched by this repair, over the 250
target but under the 400 bar: disclosed, NOT a rejection reason.

Owned test bytes ride inside foreign commit 671409f plus own commit 88af27a —
verified by disk + `git status --porcelain` on owned paths, never by commit id.
See `mem:gotcha-foreign-whole-tree-commit-can-also-reland-your-revert`.

Consumer: task-e33747f982e0452a9f9d784fd1cb914d must import `claimWork` /
`ClaimSuccessors` from the `@moe/daemon` root (both exported, 5 fields).
