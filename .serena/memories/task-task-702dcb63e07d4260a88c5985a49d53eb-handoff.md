# task-702dcb63 — review round number must be a real integer (DONE, in REVIEW)

## What landed

`packages/review/src/review-findings.ts:153`

```ts
if (!lineageAttested(lineage)) return refuse("FINDING_LINEAGE_DIGEST_MISMATCH"); // :152
if (!admissibleRound(round.round)) return refuse("FINDING_ROUND_INVALID");       // :153  NEW
if (round.round <= lastRound(lineage)) return refuse("FINDING_LINEAGE_APPEND_ONLY"); // :154
```

`admissibleRound = Number.isSafeInteger(round) && round >= 0`. Position between
:152 and :154 is load-bearing — after :154 it inherits the NaN blindness it
exists to fix. Anyone "tidying" this function by grouping numeric checks after
the ordering check reintroduces the bug in full.

`FINDING_ROUND_INVALID` added to `REVIEW_REASON_CODES`
(`review-contract.ts:70`), alphabetical, 17 -> 18 members.

New `packages/review/src/review-findings.test.ts` (229 lines) — the FIRST direct
test file for `recordReviewRound`. That absence is why the defect survived a
green suite; it was only exercised indirectly through `review-flow.test.ts`.

## The description's mechanism was WRONG — measured, not assumed

Both the task description and the architect's `codebaseInsights` say NaN
"flows into the stored record at :144". It does not. Measured shape by shape
with the guard neutralised:

| round value        | pre-fix behaviour                                            |
|--------------------|--------------------------------------------------------------|
| `NaN`              | bypasses `<=`, then THROWS `TypeError: canonical JSON supports safe integers only` |
| `+Infinity`        | same throw                                                    |
| `1.5`              | same throw                                                    |
| `2**53`            | same throw                                                    |
| `undefined`        | THROWS `canonical JSON does not support undefined`            |
| `{valueOf:()=>2}`  | THROWS `canonical JSON does not support function`             |
| `-Infinity`        | refuses `FINDING_LINEAGE_APPEND_ONLY` — WRONG code            |
| `-3`               | refuses `FINDING_LINEAGE_APPEND_ONLY` — WRONG code            |
| `null`             | refuses `FINDING_LINEAGE_APPEND_ONLY` — WRONG code            |
| `"2"` (string)     | **ACCEPTED, ok:true, stored** — the only shape that got in    |

`canonical.ts:19` already refuses non-safe-integer NUMBERS, so the numeric bad
shapes die there. But a crash is not a refusal: it names no reason code, so the
caller cannot distinguish a malformed round from a broken digest. That is the
epic-rail-4 violation. And a numeric STRING sails past `canonicalJson` entirely
because it serialises as a string — that is the shape that genuinely reached a
stored `ReviewFindingRecord`.

The fix is unchanged either way. But do not go hunting for a poisoned
`lastRound` (the architect already retracted that) or for a stored `round: NaN`
(nobody retracted that one — I did, here).

## Gates

- `pnpm --filter @moe/review typecheck && pnpm --filter @moe/review test` — exit 0, 118 passed / 4 files
- `pnpm --filter @moe/daemon test` — exit 0, 1631 passed / 76 files
- `review-findings.ts` 235 lines by `grep -c ''`

## No commit bears this task id

Foreign whole-tree commit `de936fe` (task-6a31a86f, persistFileDurably) swept
all three owned paths in, including the untracked test file. Per project rail 5:
not amended, not reset, no empty claim commit. Committed bytes verified == gated
bytes by sha256 on all three, and `git show HEAD:...review-findings.ts | grep
"false &&"` returns nothing so no drill residue committed.

Base-ref diff for review:
`git diff 4aa29d5..HEAD -- packages/review/src/review-findings.ts packages/review/src/review-contract.ts packages/review/src/review-findings.test.ts`
(3 files, +248/-3).

## Notes for anyone else in @moe/review

- `apps/daemon/src/review/review-services.ts:97` `positiveInteger` already did
  this exact admission (`isSafeInteger && >= 1`) at daemon ingress. The KERNEL
  surface was the unguarded one, so any non-daemon consumer of `@moe/review` was
  exposed. Worth checking other kernel entry points for the same asymmetry.
- `refuseFromKernel` (`review-ledger.ts:125`) takes `code: string`, an open
  passthrough — adding a review reason code needs no daemon mapping-table edit.
- `REVIEW_REASON_CODES` has only two external consumers,
  `apps/daemon/src/review/review-lineage.test.ts:158` and
  `review-services.test.ts:162`, both `toContain` membership checks, not length
  pins. Adding a member is safe. See `mem:gotcha-closed-enum-all-array-couples-sibling-tests`
  for the usual hazard that does NOT apply here.
- No directory/bridge scan test enumerates `packages/review/src`, so a new test
  file breaks no sweep. (`.js` bridges exist per production `.ts` module — a new
  PRODUCTION module there would need one; see
  `mem:new-ts-module-needs-a-js-bridge-invisible-to-tsc-and-vitest`.)

Related: `mem:gotcha-a-crash-is-not-a-refusal`,
`mem:gotcha-drill-restore-silently-fails-after-a-bash-cd`.
