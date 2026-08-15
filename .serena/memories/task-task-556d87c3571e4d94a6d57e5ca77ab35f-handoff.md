# Handoff: policy approval core — reopened for DoD 2, fixed, back in REVIEW

Second pass. First pass landed in `afbdfa7` and was rejected on DoD 2 with a REPRODUCED
escape (see `mem:gotcha-policy-slice-relaxation`, written by QA — it carries the repro).

## What the fix is

Production change is 12 lines across two files.

1. `policy-composition.ts` `ruleRelaxation` — added the `requiredFactIds` comparison:
   a redeclaration whose set is not a superset of its ancestor's is an UNCONDITIONAL
   relaxation. Placed beside the weakened-effect test, deliberately NOT inside the
   obligation loop, because that loop holds the waiver branch and this must never reach it.
   It cannot be waivable: `validWaiver` requires a `namedObligationId` and the waiver branch
   fires only for an ancestor obligation of kind SOFT. A required fact is neither.

2. `policy-evaluation.ts` `assessEvidence` — required set now unioned over EVERY slice in
   `input.sliceChain`, not over `fold.rules` (the last declaration per ruleId). Identical
   behaviour on legal chains, since a child may only widen; illegal ones are already DENY.
   The point is the failure mode: both layers must regress before the escape reopens.

Do not "simplify" either back. The two are deliberately redundant.

## Test surface added

- NEW `policy-relaxation.test.ts` (133) — QA's exact repro; partial shrink with every fact
  present (proves the refusal is monotonicity of the DECLARED set, not a side effect of a
  missing fact); tighten direction admitted and explicitly NOT flagged; no waiver path over
  a shrink (three `namedObligationId` spellings); three-link chain proving comparison is
  against the RUNNING effective rule, not the root.
- `policy-decision-table.test.ts` relaxation loop rebuilt around a shared `base` rule so each
  entry varies exactly ONE dimension. Fifth entry = the shrink.
- `policy-invariants.test.ts` generator varies required facts BETWEEN links (keep/widen/
  shrink). `hasUnusableRequiredFact` unions over all slices — it previously read only
  `input.requiredFactIds` and never looked at rule-declared facts, so it could not have
  caught this even with a biased generator.

Non-vacuity measured: outcomes over 320 seeds HOLD_UNKNOWN 169 / DENY 74 /
REQUIRE_HUMAN_APPROVAL 67 / ALLOW 10; unusable-fact seeds 222; SHRINK seeds 10 (was 0).
The floor assertion is `>= 5`, not `> 0`, with the observed value recorded next to it.

## Sizes and gate

Every policy file <=250 (invariants exactly 250, decision-table 249). Area total 2052 across
11 files. `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` exit 0,
13 files / 226 tests, run twice identical. Repo-wide `pnpm test` 109 files / 1549 passed,
1 skipped, zero foreign red.

## Commit attribution — read before reviewing

The fix is SPLIT ACROSS TWO COMMITS. `d6c7bcf` (task-18c7921f, "Foundation executable
specification") landed mid-session with a broad add and captured five of my in-flight policy
paths. My commit `9369318` holds exactly ONE path, the final `policy-invariants.test.ts`.

Whole diff: `git diff afbdfa7..HEAD -- packages/core/src/policy`.

Not reset or rebased — foreign work is preserved. See
`mem:gotcha-shared-index-commit-capture`. Flagged in #general
msg-9541ffaba28f410d9ff32d59d9f36567.

## Everything from the first pass still holds

The four-layer model, the truth floors, the registry trap (`ILLEGAL_TRANSITION` is the ONLY
code legal from `{aggregate:"APPROVAL"}`), the waiver rules, and the root-index settlement are
all unchanged and were re-verified by QA's own re-run. `mem:gotcha-core-policy-lattice-and-guard-exports`
carries the lattice and exported-guard lessons.
