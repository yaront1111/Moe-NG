# Scheduler edgeKey tie-break: the fix was trivial, the test epistemics were not

`readiness-projection.ts:152` tie-broke reasons with
`String(a.edgeKey).localeCompare(String(b.edgeKey))`. Replaced with the code-unit
form already used one line above at :151. One hunk, +10/-1. Register item 9 of
`task-963cf1d1`. Gates: scheduler typecheck 0, 43 files / 1324 tests, root
typecheck 0.

## THE FINDING: `return 0` is an equivalent mutant here

Two drills, and the second is the one worth remembering:

| Mutant | Result |
|---|---|
| restore `localeCompare` | **RED** — 2 tests fail |
| replace tie-break with `return 0` | **GREEN** — all 26 pass |

**Why:** `frontier.ts:219-221` ALREADY sorts each blocked node's reasons by
edgeKey, in the identical code-unit form. `Array.prototype.sort` is stable, so
that canonical order survives the `(layer, code)` regrouping even when the
edgeKey level does nothing. Every reason with a non-null edgeKey arrives
pre-sorted; predicate reasons all carry `edgeKey: null`. **So the tie-break's
positive ordering contribution is not observable through `projectReadiness` at
all.**

**The defect was never a missing tie-break — it was a tie-break that CORRUPTED a
correct input.** `return 0` is inert; `localeCompare` actively re-sorted canonical
order into host collation order. Classify the mutant before rewriting the test:
green-under-mutation here indicts the *mutant's* reachability, not the test.

Do not "simplify" the tie-break away. Deleting it makes the comparator correct
only by coupling to a sort two modules upstream plus implicit sort stability.
This is written into the test file's doc comment so the next reader doesn't
undo it.

## Write down what a test proves, not what the step hoped it proves

The plan asked for permutation invariance to witness totality. It does not —
upstream canonicalization plus stability satisfies it regardless. I corrected
the doc comment rather than shipping the stronger claim. A comment that
overclaims is how the next agent inherits a false belief.

## The fixture must prove itself, and the guard must be killable

`localeCompare` is host-dependent — *that is the property under test* — so a
fixture divergent on your machine can be non-divergent in CI and the test
silently passes before AND after the fix. The suite asserts the divergence
in-test:

```ts
expect(Math.sign(TIE_EDGE_LOWER.localeCompare(TIE_EDGE_UPPER)))
  .not.toBe(byCodeUnit(TIE_EDGE_LOWER, TIE_EDGE_UPPER));
```

**Drill the guard too.** Swapping to an agreeing pair (`dev-edge-Beta` vs
`dev-edge-Zeta`) makes it fail with `expected 1 not to be 1`. A guard never shown
to fail is decoration. Divergent pair: `"dev-edge-Beta"` (0x42) vs
`"dev-edge-alpha"` (0x61) — code units say Beta first, en-US collation says alpha.

## Fixture had to be valid at the earlier layer first

First attempt put `READINESS_CAPABILITY` / `READINESS_NO_PAUSE` into the bundle
while `devAllTrueFacts()` still contained them. Duplicate code → refused as
`READINESS_INPUT_MALFORMED` / "nodeFacts[4] is malformed", never reaching the
comparator. Remove both codes, then re-add as `CONFIRMED_FALSE`. See
`mem:gotcha-refusal-test-answered-by-earlier-guard`.

Only `blockedReason` carries a non-null edgeKey. `SAFE_GRAPH_KEY` is
`/^[A-Za-z0-9_][A-Za-z0-9._:@/+~-]*$/u`, so mixed-case edge keys are legal.

## Restoring a drill in a file full of uncommitted work

`git checkout -- <path>` reverts to HEAD and **destroys ~200 lines of
uncommitted new tests** while looking like a clean restore. Reverse the exact
string replacement instead and confirm by sha256. See
`mem:gotcha-git-checkout-restore-destroys-uncommitted-task-work`.

## `git diff` empty ≠ nothing changed

Mid-task HEAD moved `192360e -> e6597e4` and a foreign whole-tree commit —
`def640a feat(task-bcea7056...)`, someone else's task label — swept BOTH my files
in. `git diff` went empty while the file was plainly modified. Found the owner
with `git log -S"<a distinctive line I wrote>"`.

Do not amend/reset/re-commit. Hand QA
`git diff 192360e..HEAD -- packages/scheduler/src/readiness/` and state the
carrying commit belongs to another task.

**Check drill contamination whenever this happens:** a foreign hook can commit a
drill edit and `git status` will not say so. Verify HEAD's blob carries the
RESTORED values (`git show HEAD:<path> | sha256sum` vs the working tree), not the
mutant.

## Also measured, not a defect

`readiness-projection.ts:241-242` call bare `admissionReady.sort()` /
`dispatchable.sort()`. Default SortCompare stringifies and orders by UTF-16 code
units per spec — no ICU, no locale. Determinism-safe; left alone under the
tie-break-only rail.

Repo-wide, `\.localeCompare\(` now has exactly ONE hit in all of
packages/apps/tools TypeScript: my own divergence guard. Keep it.

Related: `mem:gotcha-surviving-mutant-behind-a-stronger-downstream-commitment`,
`mem:gotcha-locale-drill-needs-a-fixture-that-can-kill-it`,
`mem:gotcha-foreign-whole-tree-commit-preempts-your-pathspec-commit`.
