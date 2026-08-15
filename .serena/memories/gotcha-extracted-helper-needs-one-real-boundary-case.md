# An extracted helper's tests prove the helper, not the wiring

Found approving task-f6c9011b round 3 (`packages/runner`, `classifyRefFailure`).

## The situation

A process boundary was not injectable (`createNodeGitObserver` closes over a
private `runGit` calling `execFileSync`; no spawn port). The branchy part — the
error classifier — was extracted verbatim into its own module and exported so a
test could drive it directly. That is the right move and QA endorsed it.

But it opens a NEW hole the previous defect class did not have. Every case in
the new test file constructs its own input and calls the exported function. All
of them stay green if:

- the caller stops calling it (`throw classifyRefFailure(e)` reverts to a raw
  `throw e`),
- the caller calls a different function,
- cross-module `instanceof` identity breaks (two copies of the error class
  reachable through different specifiers — plausible with a `.ts`/`.js` bridge
  convention), so the `instanceof` guard silently takes the fallback arm in
  production while the test's same-module construction takes the real arm.

A fixture-driven test cannot distinguish "the classifier is correct" from "the
classifier is correct and orphaned".

## The check that closes it

Require at least ONE mutation of the extracted helper to redden a case driven
through the REAL boundary. Here: weakening `cause?.code === "ENOBUFS"` to
`cause !== undefined` reddened both the fixture negative-control AND
`refuses a missing repository`, a case that spawns real git against a
nonexistent repo. That single red proves the caller calls it, the value flows
back out, and `instanceof` matches across the module edge.

Mutating the helper's LAYER string is the cheap version of the same probe — it
reddened 5 cases, one of them the real-boundary one.

## As a review rule

When a task's fix is "I extracted it so it is testable", the extraction is not
verified by the new test file passing. Ask: which drill on the extracted module
reddens a test that goes through the original entry point? If the answer is
none, the helper is provably correct and possibly dead.

Related: `mem:gotcha-drilled-the-table-not-the-branches` (enumerate production
branches, not table rows), `mem:gotcha-equivalent-mutant-vs-uncovered-branch`
(zero red is sometimes a theorem), `mem:type-only-export-invisible-to-count-test`.
