# When a defect is untestable, run the mutation drill backwards

Epic rail 6 wants a mutation drill because a green suite hides detached
assertions. But some real defects — unsafe FFI pointer provenance, aliasing,
UB — cannot be reached by ANY scripted test when the boundary is an injected
call table, because the double dereferences nothing.

For those, the ordinary drill (mutate production, expect RED) is unrunnable.
Run it **backwards** and report the negative:

1. Revert your fix.
2. Run the suite.
3. It stays GREEN — that is the finding.

That green **proves the suite is blind to the defect**, which is precisely
what justifies "the evidence for this change is code shape, not a passing
test." Without it you are only asserting the blind spot; with it you have
measured it. Used on task-885a46e9 for a `Vec::as_ptr`-as-write-destination
fix: reverting left 19/19 green.

Two rules:

**Run it OUT OF REPO.** Copy the package to a temp dir outside the working
tree and mutate there. In a shared worktree a foreign whole-tree commit can
capture an in-repo drill edit, and `git status` will then look clean while the
mutation is still in the file.

**Report it as a negative result, explicitly.** Say the suite is blind and
that a green gate is therefore not evidence for this change. A reviewer who
sees "36 passed" next to an untestable fix should be told the number proves
nothing about it.

Corollary worth watching for: the strongest guard evidence is often
unplanned. On the same task, a sibling adding four enum variants without sweep
cases tripped the totality assertion —
`left: 15, right: 19` — a guard firing against a change it had never seen,
which beats any self-authored drill.

Related: `mem:mutation-drill-red-on-wrong-assertion`,
`mem:qa-mutation-drill-can-redden-for-wrong-reason`,
`mem:gotcha-restore-untracked-mutation-drill-by-byte-compare`,
`mem:gotcha-git-diff-is-blind-to-untracked-paths`.
