# Drilling every CASE in the table still misses branches with no case at all

Found reviewing task-f6c9011b round 2 (`packages/runner`, @moe/runner).

## The trap

Epic rail 6 says "verify a failure-path test by mutating the production surface
and confirming the test goes red." The natural reading is *iterate the test
table, mutate the guard each case names, confirm that case reddens*. I did that
in round 1, found three detached cases, rejected, and the worker fixed all three
plus one they found themselves. Round 2 every tabled case was sound.

That procedure is **table-complete but branch-blind**. It can only ever discover
cases that point at the wrong guard. It cannot discover a production refusal
branch that no case points at, because there is no case to iterate.

## Invert the enumeration

Enumerate the **production branches**, not the test cases. For each refusal site
that the task ADDED, mutate its code and its layer and require some named test to
redden. Two survived a fully green 1409-test suite:

- `retagRefFailure` (scope-git.ts): removing the whole
  `overflowed ? "RUNNER_SCOPE_OBSERVATION_OVERFLOW" : error.code` promotion
  changed nothing. The `describe` was even *titled* "listRefs overflow" — it held
  a `MAX_SCOPE_OBSERVATION_BYTES === 8 * 1024 * 1024` check, which is a constant
  assertion, not a classification assertion. A block title is not coverage.
- `classify`'s `readAll` catch (artifact-enumeration.ts): both the code and the
  layer were freely rewritable. The DoD named "an unreadable entry" and a case
  called `listing-unreadable` existed — for the *directory listing*, a different
  branch. Adjacent names read as coverage.

## Always run a CONTROL mutation

Mutate something else in the same function — the layer string on a branch you
believe IS covered. If that reddens and the target does not, you have proved the
function is reached and only that arm is dark. Without the control, "zero red"
is ambiguous with "the test file never loads".

## Cheap and mechanical

Run the WHOLE package suite per drill, not a focused file, or "nothing covers
it" is only "nothing in the file I picked covers it". A 45-file / 1409-test
vitest run is ~3 s. Anchor count asserted ==1, restore in `finally`, re-hash.
Harness lives in `%TEMP%`, never in the repo — see
`mem:gotcha-refusal-fixture-must-be-accepted-when-its-guard-alone-dies` for the
complementary rule about fixture construction, and
`mem:mutation-drills-in-shared-worktree`.

Two consecutive rejections on one DoD item flip a Moe task to **PLANNING**, not
WORKING. Cost of finding this in round 2 instead of round 1 is a full re-plan.
