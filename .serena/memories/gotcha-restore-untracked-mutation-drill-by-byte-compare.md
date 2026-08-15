# A mutation drill on an UNTRACKED file cannot be un-done by `git diff`

Hit on task-885a46e9 (Win32 process crate), 2026-08-09, on a task whose plan
step literally said "verify with `git diff` that no mutation survived".

## The trap

Epic rail 6 requires mutation drills: break the production surface, confirm the
test goes red, restore, confirm green. The habitual restore check is
`git diff` / `git status`. On a task that LANDS NEW FILES, the files you mutate
are untracked — so `git diff` reports nothing whether the mutation survived or
not. A clean status is not evidence; it is the tool's blind spot. The plan's own
wording steered straight into it.

Compounding it here: a foreign whole-tree commit landed mid-drill and moved HEAD,
so some of those files became tracked partway through. Either state alone is
survivable; the transition is what makes "check git" useless.

## What to do instead

Copy each file you are about to mutate somewhere outside the repo, then after
restoring:

```
cp src/process.rs /tmp/drill/process.rs      # BEFORE mutating
... mutate, run, observe RED ...
cp /tmp/drill/process.rs src/process.rs      # restore
cmp /tmp/drill/process.rs src/process.rs && echo IDENTICAL
grep -n '<the exact residue string>' src/process.rs   # second, independent check
```

`cmp` proves byte identity regardless of tracking state. Follow it with a grep
for the literal text you injected — two checks that fail differently.

## Second finding from the same drill

**A drill can go red for the wrong reason and still look like proof.** Deleting
a case from the sweep array made the test red — but on the `CASES.len()` LENGTH
GUARD, which fires first and says nothing about the cross-check you were trying
to exercise. The cross-check was still untested.

Neutralise the earlier guard too (set the length assertion to the mutated value)
so only the assertion under test can catch it, and read WHICH assertion fired in
the panic message. Then restore both. A drill that does not name the assertion
that went red has not proved that assertion works.

## Third: verify a "verbatim move" against the BASE, not HEAD

The DoD said to diff against `git show HEAD:<file>`. Once a foreign commit
captured my own split, HEAD's copy WAS my new version, and the check produced a
large bogus diff that looks exactly like "you edited the moved block". Pin the
base commit sha at step 1 and diff against that sha forever after.

Related: `mem:gotcha-git-diff-is-blind-to-untracked-paths`,
`mem:mutation-drills-in-shared-worktree`,
`mem:moe-finished-task-may-have-no-commit`.
