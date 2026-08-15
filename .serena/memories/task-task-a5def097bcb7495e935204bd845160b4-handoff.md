# Hierarchical budget ledger — DONE, in REVIEW

Task `task-a5def097bcb7495e935204bd845160b4` (SPIDR 17.02) on `moe/work-2026-08-08`.
Commit `406eb95`, 3 files, 501 insertions. Consumes 17.01
(`mem:task-task-7dc2e4870d7d4096a1be7b5991e50e94-handoff`), which is byte-unchanged.

## Surface (packages/scheduler/src/budget/budget-account.*)

`openBudgetRoot(authorization)`, `allocateToChild(state, cmd)`, `returnToParent(state, cmd)`,
`closeBudgetAccount(state, {accountId, expectedVersion})`, `replayBudgetLedger(auth, entries)`,
`deriveSubtreeTotals(state)`, plus `BUDGET_ACCOUNT_ISSUE_CODES` (9 transition codes) and
`MAX_BUDGET_VERSION`. Sizes 250 / 250 / 1 — **both TS files AT the cap, zero margin**.

## Design decisions the next sibling (17.03 reservations, 17.04 settlement) must know

- **Commands are multi-meter**: `amounts: {meter, amount}[]`, one balanced entry PER METER.
  A single-meter command would have made "duplicate meter in one command" untestable.
- **Child creation is folded into allocation** via `expectedChildVersion: null`. A new child is
  born at version 0 (not bumped); existing accounts bump on both sides of every movement.
- **`BudgetLedgerEntry` carries `ownerRef: string | null`**, beyond the plan's six fields. It is
  set ONLY on the ALLOCATED entry that creates an account. Without it replay cannot reconstruct
  the child's ownerRef and replay-equals-live fails — I hit exactly that.
- **`BudgetLedgerResult` carries `state` on BOTH arms**: `{ok:true,state}` and
  `{ok:false,state,issues}`. On rejection it is the SAME REFERENCE as the input. Tests assert
  `toBe`, not deep equality — a kernel that mutated then rebuilt an identical object must fail.
- **Local issue codes**, because the contract's `BUDGET_ISSUE_CODES` is a closed frozen union of
  eight SHAPE codes and 17.01's files are not editable from here. Only `{code, message}` is reused.
- **`overrun` exists but is always empty** here; settlement (17.04) is the only thing that may
  raise it. It is a term in the conservation equation so 17.04 need not reopen this file.

## Published check order — DO NOT REORDER without updating tests

malformed → duplicate identity → unknown account → exhausted counter → stale version →
parent mismatch → unknown meter → insufficient available. **First failing check decides the single
reported code** (lease-fencing.ts:87-95 precedent). All 22 rejection cases assert exactly a
one-element code array, so a second reported cause fails the suite.

## Rules that are structural, not incidental

- Sibling-funds-sibling is impossible on two grounds: the parent-mismatch check, AND there being
  no entry shape that credits without debiting the same amount from one named account.
- Source must always carry the meter; the sink must also carry it when RETURNING (a parent's meter
  set is authorized and must not autovivify). A child being funded MAY gain a meter.
- Close requires direct AVAILABLE/RESERVED/QUARANTINED all zero AND every child already CLOSED.
  COMMITTED may be nonzero; the account is RETAINED so its committed units keep counting.
- `BUDGET_ACCOUNT_COUNTER_EXHAUSTED` is unreachable via legal transitions (ceiling is
  `MAX_SAFE_INTEGER - 1_000_000`). The coverage test names it as the sole excluded code so it
  cannot be quietly forgotten.

## Testing technique worth copying

- 22-case table-driven rejection matrix; every case asserts code + `toBe` reference identity +
  unchanged entry count + frozen issue. Dense enough to fit ~22 cases in ~30 lines.
- A test asserts the covered code set EQUALS the production `BUDGET_ACCOUNT_ISSUE_CODES` (minus
  the unreachable one), so adding a code without a case fails.
- `expectConserved` sums buckets INDEPENDENTLY, then requires the independent sum,
  `deriveSubtreeTotals`, and `authorized + overrun` to all agree — the roll-up is never checked
  against itself.
- Hand-built state literals reach bucket shapes this kernel cannot mint (nonzero RESERVED /
  QUARANTINED). Legitimate: these are pure functions over state, and that is how 17.03 will call in.

## Mutation evidence (epic rail: prove failure-path tests can go red)

Three production mutations each reddened the suite: parent-mismatch guard neutered (8 red),
rejection returning a rebuilt `{...state}` (8+ rejection tests red — the one deep-equality would
have missed), and movement crediting without debiting (8 red). **Read
`mem:gotcha-mutation-testing-restore-safety` before running your own — my first harness corrupted
the file, and it was untracked so git could not restore it.**

## Verification

`pnpm --filter @moe/scheduler typecheck && pnpm --filter @moe/scheduler exec vitest run --root
../.. packages/scheduler/src/budget/budget-account.test.ts` → exit 0, 32/32.
`pnpm --filter @moe/scheduler test` → 28 files / 415 tests, exit 0 (includes package-boundary and
17.01's own suite). index.ts / package.json / pnpm-lock.yaml untouched; no package-root export.
