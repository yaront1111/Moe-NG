# Gotcha: a <=250-line file cap is a DESIGN constraint, discovered too late if you treat it as cleanup

Hit hard on `task-3602672fd0c74de6b6fc72f90e1745c8` (budget-settlement.ts, 2026-08-08). The first
readable, correct, fully-guarded implementation landed at **329 lines** against a hard 250 cap in
the task DoD. It compacted to exactly 250 with zero behaviour change — but only after two full
rewrites, because the savings that mattered were **structural**, not cosmetic.

## What did NOT save enough

Merging short lines, deleting blank lines, shortening comments. Together those bought ~35 of the
79 lines needed. Comments and blanks were only ~57 of 291 lines at the worst point; you cannot
delete your way from 329 to 250 without gutting the documentation the epic actually values.

## What DID save it — find these BEFORE writing, not after

Look for operations that are the same computation with different parameters:

1. **Two ops that differ only by a starting bucket and a baseline.** settle (RESERVED, nothing
   committed yet) and reconcile (QUARANTINED, some already committed) collapsed into one
   `dispose(meter, hold, credited, from, reading)` once I noticed a receipt quantity is the TOTAL
   measured use, so the committed delta is `quantity - credited` and settle is just `credited=0`.
   That one insight was worth ~30 lines *and* was the only way to express "receipt below the
   already-committed lower bound" as a check at all.
2. **A shared preamble for ops that share a precondition.** Three ops all needed: re-read the
   record, require one state, run op-specific checks, apply the version fence, check backing
   units. `openQuarantine(view, record, cmd, extra)` where `extra` is a
   `(record) => readonly Check[]` callback: ~11 lines replacing ~30.
3. **A shared guard-row emitter.** `fence(...)` returning the COUNTER_EXHAUSTED/STALE_VERSION
   `Check` pair, spread into all four ordered tables.
4. Plus the landed-sibling tricks: messages DERIVED from the code string
   (`code.slice(PREFIX.length).toLowerCase().split("_").join(" ")`), ordered `Check` tuple tables
   with `firstOf`, multi-declarator `const A = ..., B = ...;` for related constant lists.

## Rules

- If the surface is 4 ops x N dispositions x M codes, do the line arithmetic **before** the first
  GREEN commit. Budget ~35 lines for helper clones the siblings don't export, ~30 for the type
  block, ~12 for the header.
- **Get it green first, then compact.** Compacting a passing suite is safe and each step is
  verifiable; compacting while red conflates two failure sources.
- Long lines are cheap and legitimate: the landed siblings in this repo already run to ~176 chars.
  Check the real max in a neighbouring file rather than assuming 100/120.
- The escape hatch (`report_blocked` rather than a fourth unowned file or a dropped guard) is
  real, but exhaust structural sharing first — it got 79 lines here without losing one check.

Related: `mem:gotcha-phantom-per-task-loc-bar` (the cap is PER FILE; there is no per-task LOC bar).
