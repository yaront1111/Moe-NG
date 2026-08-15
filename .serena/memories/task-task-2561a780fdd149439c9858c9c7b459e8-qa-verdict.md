# task-2561a780 (Scheduler expansion admission) — QA APPROVED

qa-f3560083, 2026-08-11. Commit **b865e7c** (9 files, all `packages/scheduler/src/expansion/`).
`f9172b6` carries the same task id but is the completion hook's `.moe/` metadata sweep only —
zero source files, so it is not scope creep.

## Gate, re-run by QA

`pnpm --filter @moe/scheduler typecheck && pnpm --filter @moe/scheduler test` -> exit 0,
**42 test files / 1125 tests, 0 failed**. Matches the worker's claim exactly.
Repo-wide `pnpm -r typecheck` -> 18 of 19 projects, zero `error TS`.
Committed bytes == working-tree bytes: `git rev-parse HEAD:<p>` equals `git hash-object <p>` for
all nine owned files.

The plan's "KNOWN baseline red" in `package-boundary.test.ts` **does not exist**. Package green.

## The nine mutation drills I ran (production surface, NOT the tests)

Every one restored; `git status --porcelain packages/scheduler/src/` empty at the end.

| drill | mutation | result |
|---|---|---|
| identity sweep ×15 | `digestOf({...bound, K: null})` for each of the 15 bound keys | **all 15 redden** |
| layer-only | `fromLayered` `layer: issue.layer` -> `layer: origin` | 2 failed, alone |
| code-only | `fromLayered` `code: issue.code` -> constant | 2 failed, alone |
| fromFlat code | `code: issue.code` -> `"ZZZ"` | 6 failed |
| no unwind | `return cause;` before `cancelReservation` | 1 failed — the named meters test |
| caller verdict | `if (false && FORBIDDEN_VERDICT_KEYS.includes(key))` | 8 failed |
| UNKNOWN pass | `if (false) return unknown(...)` on materialization | 2 failed |
| **foreign limits** | `admission-records.ts:22` 3/6/9 -> 4/7/10 | **3 failed** |

The last one is the decisive DoD-2 evidence: mutating the LANDED `EXPANSION_LIMITS` in a file this
task does not own reddens all three N/N+1 boundary tests in the expansion suite. The limits are
genuinely COMPOSED via `checkExpansionLineage`, not redeclared. Composing the CHECKER rather than
exporting the CONST also means no unowned file was touched.

The layer-only and code-only pair is the compliant signature from
`mem:gotcha-layer-only-and-code-only-drills-must-be-run-separately`: each reddens the SAME two
tests ALONE, so both halves of "verbatim delegated code AND layer" are independently asserted.

## The digest-masking fix holds

`mem:gotcha-a-digest-can-mask-every-field-it-covers` was found ON this task. I re-swept all 15
bound keys myself rather than trusting the worker's claim, because that defect's whole signature is
a GREEN drill. `evidenceDigest` now digests only `childFacts` (which omits `childKey`), and
`ExpansionChildFacts` carries nothing the scalars beside it carry. Every key is falsifiable.

## Scope judgements a successor may re-litigate

**9 files landed against 5 named owned paths — ACCEPTED.** `expansion-receipt.ts` (235) and
`expansion-preparation.ts` (208) are per-file-cap splits, and the cap is epic rail 5's mandated
remedy. Measured: evidence+receipt = 465 lines combined, admission+preparation = 525. Both splits
were forced, and both new files sit inside the same brand-new owned directory, so no foreign work
is touched. Max production file is 317 < 400.

**No `@moe/core` import, against plan step 3 — ACCEPTED.** Step 3 said compose
`validExpansionProposalIdentity`. The task DESCRIPTION says "NOT in scope: ... importing
@moe/core/@moe/runner" and DoD 5 forbids cross-package imports. The DoD and the description bind;
a plan step cannot authorise a DoD violation. Imports are same-package relative + `node:crypto` +
`vitest` only. Ban grep empty, verified with a positive control that hits 5 other files.

## The one weakness I did NOT reject on

`FORBIDDEN_VERDICT_KEYS` is swept by `it.each` but policed only by `length > 0`. Drop
`admissible`, `capacityAvailable`, `eligible` or `inputsMaterialized` from the const and the sweep
shrinks silently — `mem:qa-generated-table-cannot-police-its-own-generator`. The other two keys are
pinned by hand-written tests. DoD 5 and epic rail 6 require the case be "actually generated"
(nonzero), which IS asserted, and the same file already uses exact set equality for
`EXPANSION_EVIDENCE_ISSUE_CODES` — so the written bar is met and my preferred stronger form is not
the requirement. See `mem:qa-grade-against-the-written-requirement-not-your-own-suggestion`.

Related: `mem:gotcha-a-restore-anchor-can-go-ambiguous-after-the-mutation`.
