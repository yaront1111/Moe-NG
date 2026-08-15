# QA APPROVED — scheduler edgeKey tie-break code-point determinism

Verdict: APPROVED, DONE. Register item 9 of `task-963cf1d1`. One-hunk production
fix (-1/+9) at `readiness-projection.ts:158-160`, +196 test lines.

## What I re-ran rather than trusted

| Check | Result |
|---|---|
| `pnpm --filter @moe/scheduler typecheck` | exit 0 |
| `pnpm --filter @moe/scheduler test` | exit 0, 43 files / 1324 tests |
| localeCompare grep, scheduler prod, + positive control | 1 hit = comment; control 4 hits |
| Drill: restore `localeCompare` into production | **RED**, 2 outcome assertions |
| Drill: swap fixture to an AGREEING pair | **RED**, `expected 1 not to be 1` |
| sha256 both files after restore | bit-exact, clean gate re-run green |
| `grep -c ''` on the production file | 248, under 250 |

## THE REUSABLE JUDGEMENT: an honest equivalent-mutant disclosure is not a reject

The worker disclosed that `return 0` in place of the tie-break is an EQUIVALENT
MUTANT through `projectReadiness`, because `packages/scheduler/src/frontier.ts:219-221`
already sorts each blocked node's reasons by edgeKey in the same code-unit form
and `Array.prototype.sort` is stable. I verified that upstream sort exists. So
the tie-break's *positive* contribution is not independently observable here.

**That is not a DoD failure, and the reflex to reject it is wrong.** Classify
what the mutant proves:

- `return 0` green indicts the MUTANT'S REACHABILITY, not the test.
- `localeCompare` restored goes RED — and *that* is the defect being locked out.
  The bug was never a missing tie-break; it was a tie-break that CORRUPTED an
  already-correct input into host collation order.

DoD asked the order be asserted total **on the production surface**. It is. A
worker writing down the narrower truth in the doc comment, instead of shipping
the stronger claim the plan hoped for, is the behavior epic rail 6 wants.
See `mem:qa-surviving-mutant-behind-stronger-downstream-guard`.

## Drill the anti-vacuity guard, not only the fix

`localeCompare` is host-dependent — *that is the property under test* — so the
fixture can silently stop diverging in CI and the test passes before AND after
the fix. The suite guards this in-test. I did not take the guard on faith: swapped
`TIE_EDGE_LOWER` to `dev-edge-Zeta` (agrees with `dev-edge-Beta` under both
orders) and the guard failed loudly. **A guard never shown to fail is decoration.**
Divergent pair that works: `dev-edge-Beta` (0x42) vs `dev-edge-alpha` (0x61).

## The DoD grep hits its own fix comment

DoD 2 wanted zero `localeCompare` in scheduler production. A bare word grep
returns ONE hit — `readiness-projection.ts:155`, the comment documenting the
convention, matching the three landed modules. Not a call site, not a defect.
Read the hit before scoring the grep. Positive control must still be run:
`packages/import/src/canonical-bytes.ts` + `packages/runner/src/recovery-inventory/`.

## Restore discipline in the shared worktree

Both drills restored by **reverse string edit + sha256 compare**, never
`git checkout --` (`mem:git-checkout-restore-destroys-uncommitted-work`).
Production `2957dd0d…`, test `436b1f84…`. A foreign whole-tree commit had already
swept these bytes in under another task's label — per epic rail, verified by
`git diff 192360e..HEAD -- packages/scheduler/`, not by hunting a commit bearing
this task id.

## Measured, not a defect

`readiness-projection.ts:241-242` call bare `.sort()`. Default SortCompare
stringifies and orders by UTF-16 code units per ECMA-262 — no ICU, no locale.
Determinism-safe; correctly left alone under the tie-break-only rail.
