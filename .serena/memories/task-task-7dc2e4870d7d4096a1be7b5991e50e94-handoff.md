# Budget contract vocabulary — DONE, in REVIEW

Task `task-7dc2e4870d7d4096a1be7b5991e50e94` on `moe/work-2026-08-08`. First child of the
conserved budget SPIDR split (`mem:decision-budget-core-spidr`); the ledger, reservations, and
settlement children consume this vocabulary and must not invent their own.

## What shipped

`packages/scheduler/src/budget/` — new subdir, three paths:

- `budget-contract.ts` (250 lines, AT the cap — split before appending)
- `budget-contract.test.ts` (246 lines, 19 tests)
- `budget-contract.js` (1 line shim, `mem:gotcha-scheduler-js-shims`)

Exports: nine frozen vocabularies, `MAX_BUDGET_METERS` (64), record/result types, and exactly
three pure validators — `validateBudgetAccount`, `validateUsageMeasurement`,
`validateReserveDeclaration`. **Zero movement authority**: no allocate/settle/transfer/refund.

## Vocabulary provenance — the part most likely to be got wrong

`docs/plans/2026-08-05-moe-rebuild-design.md` (in `D:/projexts/moes`, NOT this repo):

- **DESIGN-PINNED**: account states (591), buckets (592-597), coverage (634).
- **DESIGN-PINNED but NOT in section 11** — measurement sources. The plan for this task assumed
  section 11 left the set open and authorised a LOCAL fallback of "adapter-reported / billing
  receipt / daemon observation". It does not. **Design 20.5 line 1260 (benchmark binding T-D1)**
  pins exactly `PROVIDER_REPORTED_COMPLETE`, `PROVIDER_REPORTED_PARTIAL`, `DERIVED_LIST_PRICE`,
  `SUBSCRIPTION_QUOTA`, `ACTUAL_BILLED`, `UNKNOWN`. Shipping the plan's guess would have created
  a vocabulary no adapter can emit. A test refuses `"ADAPTER_REPORTED"` so it cannot creep back.
  Note `LIST_PRICE` (design 640) is a price-kind, not a source — do not conflate.
- **LOCAL**: reserve purposes. Design 587 gives prose only ("mandatory verification, eligible
  review, final acceptance processing, and contingency" + fan-out "input materialization and
  integration"); `VERIFICATION | REVIEW | ACCEPTANCE_PROCESSING | CONTINGENCY |
  INPUT_MATERIALIZATION | INTEGRATION` are this module's spelling and are marked LOCAL.
- **MIRRORED**: policy outcomes/tiers from `packages/core/src/policy/policy-contract.ts:17-30`,
  truth classes from `packages/contracts/src/runtime/runtime-vocabulary.ts:61-63`. Verified
  IDENTICAL by value+order. @moe/scheduler depends on neither package, so re-diff on any change.
- **Meter is an OPEN bounded identifier**, not a closed set — design 11.2 fixes `attempt.count`,
  `runner.authorized_ms`, `verification.authorized_ms` but admits provider meters.

## Semantics worth preserving

- **UNKNOWN-never-zero is a BICONDITIONAL**, not a one-way check:
  `coverage === "UNKNOWN" ? quantity !== null : quantity === null` -> mismatch. UNKNOWN+0 and
  UNKNOWN+1200 both refuse; COMPLETE/PARTIAL+null refuses; **PARTIAL+0 is ACCEPTED** — a measured
  zero is a different fact from an unknown (design 11.3, PARTIAL is an exact lower bound).
- **Two-phase issue accumulation** is what makes `sortIssues` observable. Malformed shape returns
  one terminal `*_MALFORMED`; a well-shaped record accumulates one `*_FIELD_INVALID` per bad field
  then sorts. Messages are chosen so canonical sort ≠ emission order for the tested pair (state is
  checked second but sorts first), per `mem:convention-scheduler-validator-invariants`.
- **Detachment is snapshot semantics.** Records are rebuilt field by field from validated values,
  never spread from the caller's object, so no caller reference reaches the record.
- **Empty meters list is ACCEPTED** — deliberate. Design 607 does not require a meter at creation
  and this module grants no authority. If the ledger child needs at-least-one, enforce it there.

## Verification

Task gate `pnpm --filter @moe/scheduler typecheck && pnpm --filter @moe/scheduler exec vitest run
--root ../.. packages/scheduler/src/budget/budget-contract.test.ts` -> exit 0, 19/19.
Full package `pnpm --filter @moe/scheduler test` -> 27 files / 383 tests, exit 0.

## Sweep incident (second this session) — check HEAD, not your working tree

`e97250e fix(task-18c7921fb1f34a8cb1ed39509bf67a31): ...` swept all three budget files under
another task's title, capturing `budget-contract.ts` at an intermediate **258 lines — over the
hard 250 cap**. My own commit `326e146` (explicit pathspec, 1 file) is the compaction that brings
HEAD to 250. Lesson: with `mem:gotcha-shared-index-commit-capture` active, **measure file sizes
with `git show HEAD:<path> | wc -l`, not from the working tree** — a sweep can commit a
non-compliant intermediate and the working tree will still look fine.

## Gotcha found on the sibling task, relevant here

`mem:gotcha-package-boundary-test-matches-comments` — never spell `scheduler/src/` or
`@moe/scheduler/` in prose anywhere under `adapters/`/`apps/`/`packages/`. Greps confirmed zero
occurrences in these three files before commit.
