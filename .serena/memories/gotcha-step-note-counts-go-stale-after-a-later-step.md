# Gotcha: a step note's test count is a snapshot, and a later step can silently invalidate it

Found 2026-08-09 reviewing `task-53680e91db1c4789a42b7129e61bdd7a` (runner supervisor root
surface, commit 9bfaa3b).

## The shape

Step 6 was "prove zero behaviour change, stated as numbers". Its note said, correctly at the
time:

```
BEFORE: Test Files 21 | Tests 721
AFTER:  Test Files 22 | Tests 801
801 - 721 = 80 = EXACTLY the 80 cases in the one added file.
```

Step 7 repeated `Tests 801 passed (801)` from its own fresh gate run. Both were honest
measurements. **The committed artifact has 799 tests, and the new file has 78.**

Nothing was faked. Step 8 was "adversarial self-review, then commit", and the review correctly
removed two exports (`MIRRORED_LEASE_KEYS`, `MIRRORED_PROOF_KEYS` — unfrozen arrays, see
`mem:gotcha-publishing-an-unfrozen-array-is-a-tamper-vector`). Those two names were rows in an
`it.each` table, so the count fell 80 -> 78 and 801 -> 799. The two earlier notes were never
re-measured, because nothing in the workflow says a *review* step invalidates a *counting* step.

## Why it matters

The numbers in a step note are the evidence a DoD item like "stated as an explicit before/after
number" is graded on. A stale number is indistinguishable, on the page, from an invented one —
and epic rail 4 says unverifiable evidence never gains authority. Here the underlying claim
survived (721 -> 799 is still `after >= before`), so it was a blemish and not a reject; had the
step-8 change *deleted* pre-existing tests, the same staleness would have concealed a real
regression behind a green-looking note.

## Rule

- **Worker:** any step that edits the surface after your counting step invalidates that count.
  Re-run the count in the final step and amend, or state the count only in the last step.
  A count and a commit should be separated by nothing.
- **QA: never grade a count off a step note. Re-run it.** And derive the *before* number without
  checking out the parent commit in the shared worktree — run the full suite, run the new file
  alone, subtract. `799/22 files − 78/1 file = 721/21`, which both confirms the claimed baseline
  and proves nothing pre-existing was lost, in two commands and zero `git checkout`.

## Tell

Total test count minus the new file's count does not equal the claimed BEFORE. If the residual
is *lower* than the claimed baseline, stop — that is a deleted or silently skipped pre-existing
test, not a bookkeeping slip.

Related: `mem:task-task-53680e91db1c4789a42b7129e61bdd7a-qa-verdict`,
`mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion`.
