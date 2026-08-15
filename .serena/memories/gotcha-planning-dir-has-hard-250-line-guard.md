# `packages/core/src/planning/` has a hard 250-physical-line guard in the test suite

`packages/core/src/planning/planning-source-size.test.ts` sweeps **every `.ts` file in its own
directory** (`planningDirectory = dirname(fileURLToPath(import.meta.url))`) and fails when any of
them exceeds `MAX_PHYSICAL_LINES = 250`. No allowlist, no basename exception, it sweeps itself,
and it has a vacuity floor (`MINIMUM_SWEPT_FILES = 15`) so a mis-resolved directory cannot pass
silently. It runs inside `pnpm --filter @moe/core test`.

## Why this bites

The epic rail reads "target <=250 lines, and split before 400". For this one directory the soft
250 target is a **mechanical ceiling**, and 400 is unreachable. A plan that says "stay strictly
below 400" for a planning leaf is infeasible if the leaf is already at 250.

Measured at HEAD ffa39d6 (2026-08-09):
- `planning-validation.ts` — 250 lines: **zero headroom**
- `planning-invariant-drivers.ts` — 235
- `planning-run-reducer.test.ts` — 228
- `planning-command-contract.ts` — 216 (34 free)
- `planning-event-contract.ts` — 163 (87 free)

`packages/core/src/expansion/` has **no** such guard (`expansion-planning-hold.ts` is 300 lines,
`expansion-planning-hold.test.ts` is 627). The guard is planning-directory-local, not repo-wide.

## How to count it correctly

Use the guard's own algorithm, not `wc -l` or PowerShell `Measure-Object -Line`: strip a leading
BOM, split on `/\r\n|\r|\n/`, and drop the final empty segment. `grep -c ''` happens to agree.

## Consequences

- Before planning any edit to a planning leaf, measure its physical lines. Headroom, not the
  400 cap, is the real budget.
- Adding capability to a planning leaf that is at 250 requires either a new focused leaf
  (`*-validation.ts` is the established sibling pattern, cf. `graph-revision-validation.ts`) or
  reformatting legacy lines in that file.
- Do **not** defeat the guard by writing 300-character lines. It counts physical lines only, so
  that technically passes while destroying the reviewability the guard exists to protect.
