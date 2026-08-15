# QA verdict: APPROVED — production scheduler fairness contracts (task-e8e27f76)

Approved 2026-08-10 by qa-3227efb6. Task moved DONE. Full evidence in task
comment `comment-097f44db`. Unblocks the 5-task expansion tail (task-10cab3e5 first).

## What I actually re-ran (do not take the worker's word next time either)

- Gate, foreground, from repo ROOT:
  `pnpm --filter @moe/scheduler typecheck && pnpm --filter @moe/scheduler test && pnpm typecheck`
  -> 38 files / 882 tests, exit 0. Every repo-wide typecheck leg printed `Done`,
  so there was no foreign red to path-attribute. Run from root or the third leg
  lies (`mem:pnpm-typecheck-from-subdir-is-not-repo-wide`).
- Per-file `grep -c ''`: 161 / 150 / 235 / 176 / 191. All under the 250 target.
  Test file 700 lines — the cap is production-only, not a finding.
- `git diff 1e3057ab..HEAD -- packages/testkit/src/scheduler-fairness/` EMPTY (DoD 5).

## Three drills I ran MYSELF — the reason this passed rather than merely looked green

1. Disabled BOTH bypass proof guards in `fairness-evidence.ts`
   (`if (opportunityRefs.length === 0 && claimedBypasses > 0)` and the
   `!== claimedBypasses` comparison, both -> `if (false)`). 4 failed / 150 passed.
2. **The one worth remembering.** The DoD-4 no-authority test classifies exports by
   NAME regex, which the worker disclosed as a hole. I attacked exactly that hole:
   appended a REAL sorter named `validateWhoseTurnItIs` — passes `VALIDATOR_NAME`,
   dodges `AUTHORITY_NAME` (no next/order/sort/rank/... in the name). It still went
   RED: `expected 3 to be 2`. The per-module **export COUNT pin** (11/2/2/1/1), not
   the regex, is the real backstop. A disclosed weak check can still be sound if a
   second pin covers it — test the hole before you reject on it.
3. Removed `fairness-ring.js` -> vitest contract test 154/154 **GREEN**, plain-Node
   probe **RED** with `Cannot find module ...fairness-ring.js imported from
   ...index.ts`. Live confirmation of `mem:gotcha-vitest-blind-to-missing-js-bridge-only-probe-reddens`.

All three restored; `git status --porcelain` on the touched paths came back empty
before I moved on (`mem:mutation-drills-in-shared-worktree`).

## Commit shape — approved despite no task-named commit carrying the code

All 11 files under `src/fairness/` are committed inside **foreign** commit `17bfb37`
(task-04e4367). Global rail 5 makes that a non-issue. What I verified instead, and
what any QA should demand here: `git rev-parse HEAD:<path>` == `git hash-object <path>`
for all 15 owned paths — committed bytes ARE the gated bytes. That check also closes
`mem:qa-untracked-deliverable-passes-every-habitual-check`: it distinguishes
"swept into a foreign commit" from "never committed at all".

## Test-design patterns this task got right (reusable QA yardstick)

- Reachability table is **hand-written** and pinned in BOTH directions against the
  frozen vocabulary (`covered.sort()` toEqual `[...CODES].sort()`), so an unreachable
  code AND an undeclared code both redden. Compare
  `mem:qa-generated-table-cannot-police-its-own-generator`.
- Every sweep asserts a hand-counted literal (12 / 60 / 11 / 34) *and* `> 0`.
- Refusal assertions are whole-object `toEqual([{code, layer}])`, never `.length`.
- Every refusal case has a positive twin, so "refuses everything" cannot pass.
- The UNKNOWN biconditional is asserted against production output
  (`missingInputsOf(result)` toEqual `[testCase.missingInput]`), not against the table.

## Not a finding

Untracked `packages/scheduler/src/supersession/` is task-dddfaf83's in-flight work
(its own file header says so). Not this task's path, nothing committed.
