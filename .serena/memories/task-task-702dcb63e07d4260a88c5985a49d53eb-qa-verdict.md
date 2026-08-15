# task-702dcb63 — review round NaN admission — QA APPROVED (qa-50f0d628, 2026-08-15)

## Verdict: APPROVE. All 5 DoD items verified independently, not read off the worker's summary.

## Gates I re-ran (fresh, HEAD 79dcf18, owned paths `git status --porcelain` EMPTY so working tree == committed bytes)

- `pnpm --filter @moe/review typecheck` — EXIT 0
- `pnpm --filter @moe/review test` — EXIT 0, `Test Files 4 passed (4)`, `Tests 118 passed (118)`
- `pnpm --filter @moe/daemon test` — EXIT 0, `Test Files 77 passed (77)`, `Tests 1659 passed (1659)`
  (worker reported 76/1631; count GREW because peers landed tests between their run and mine. Growth
  with exit 0 is not a discrepancy — a SHRINKING count would have been.)

Exit codes captured with `> file 2>&1; echo EXIT=$?`, never through a pipe
(see `mem:piped-gate-run-reports-tail-exit-code`).

## The fix, verified on COMMITTED bytes via `git show HEAD:`

```
:152  if (!lineageAttested(lineage)) return refuse("FINDING_LINEAGE_DIGEST_MISMATCH");
:153  if (!admissibleRound(round.round)) return refuse("FINDING_ROUND_INVALID");   // NEW
:154  if (round.round <= lastRound(lineage)) return refuse("FINDING_LINEAGE_APPEND_ONLY");
```

`admissibleRound = Number.isSafeInteger(round) && round >= 0`. Order confirmed by reading the
committed file, not by trusting the plan note — the whole defect is that a guard AFTER :154
inherits the NaN blindness it exists to fix.

## The mutation drill I ran myself (DoD 4 demanded it redden on NaN SPECIFICALLY)

Deleted :153 outright with `sed -i '153d'`, printed the removed line and confirmed
`grep -c 'admissibleRound(round.round)' == 0` so the drill provably applied
(`mem:mutation-drill-that-applied-nothing-reads-as-green`).

Result: `Tests 19 failed | 99 passed`. Three NaN-NAMED tests among them. The lead failure:

```
AssertionError: expected [Function] to not throw an error but
'TypeError: canonical JSON supports safe integers only' was thrown
  at expectRoundInvalid review-findings.test.ts:52
```

THAT ASSERTION IS THE RIGHT ONE. NaN reddening on `not.toThrow` is not a weak drill — it IS the
defect signature. Had the ordering comparison been capable of catching NaN it would have RETURNED
a refusal; instead the round sailed past :154, reached `canonicalDigest` and died with an
unstructured TypeError naming no reason code. Crash-instead-of-refusal is exactly the epic rail 4
violation (`mem:a-crash-is-not-a-refusal`). Other tests in the same file (append-only, routing)
stayed GREEN under the drill, so this was per-case redness, not an environment break
(`mem:qa-mutation-drill-can-redden-for-wrong-reason`).

Restore by `cp` from a /tmp backup, NOT `git checkout`
(`mem:git-checkout-restore-destroys-uncommitted-work`). sha256 back to
`098d229c430643a6b85381a420ef1aa12568f35514689a7dcda83ac1881abe96` == pre-drill, owned paths clean,
guard present exactly once, zero drill residue at HEAD.

## Why round 0 -> FINDING_LINEAGE_APPEND_ONLY is CORRECT, not a gap

Admission is `>= 0`, not `>= 1`, so round 0 passes admission and is caught by the ordering
comparison (`lastRound` seeds at 0, so `0 <= 0`). Tightening to `>= 1` would have SWAPPED which
code answers for round 0 and broken DoD 3's "exactly as today". The test pins this deliberately.
A reviewer pattern-matching "non-negative should be positive" would reject a correct choice here.

## Bypass hunt (DoD 1's "no such value ever reaches a stored ReviewFindingRecord")

`grep -rn ReviewFindingRecord --include=*.ts apps/ packages/` — the ONLY construction site is
`review-findings.ts:156`, downstream of :153. Daemon does not build the record itself; its
`review-services.ts:96 positiveInteger` guards ingress only, which is why the kernel surface was
the exposed one for any non-daemon consumer.

## Scope

`git diff --stat 4aa29d5..HEAD` over owned paths: 3 files, +248/-3. Production delta is one enum
member, one guard function, one guard line, one doc-comment update. No coercion anywhere on the
path (`grep` for `Number(`, `|| 0`, `?? 0` — none). `review-findings.ts` 235 lines,
`review-contract.ts` 248, both by `grep -c ''` (`mem:powershell-measure-object-line-undercounts`).

## No commit bears this task id — NOT a rejection reason

Foreign whole-tree commit `de936fe` (task-6a31a86f) swept all three owned paths in. Project rail 5
is explicit that this is a known hazard, never a defect. I verified by base-ref diff plus the fact
that owned-path `git status` is empty, which proves committed bytes == the bytes I gated.

Related: `mem:qa-generated-table-cannot-police-its-own-generator` (the sweep here DOES carry a
hand-written `toHaveLength(10)` plus a full literal label `toEqual` — it satisfies that bar).
