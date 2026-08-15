# `git merge-base HEAD origin/main` can return a commit that already contains your work

Seen on task-159f4c21 (2026-08-15), branch `moe/work-2026-08-08`.

The path-attributed-baseline rail says to compare gate failures at the task's
merge-base against HEAD. The obvious way to get that baseline —
`git merge-base HEAD origin/main` — returned **60ced04**, and a base-ref diff
from it showed only 6 files / 133 insertions for owned paths, with
`provider-run-record.ts` (241 new lines) **absent from the diff entirely**.

Cause: origin/main had since absorbed this work branch, so the merge point moved
forward past the task's own commits. The diff was not wrong, it just answered a
different question — "what changed since the branches last met", not "what did
this task add".

Failure mode if you don't catch it: you hand QA a base-ref diff that omits your
main deliverable, which reads exactly like an untracked or never-landed file.
The reverse is worse — a baseline that already contains your regression makes a
red you introduced look foreign.

## Check before trusting any baseline

1. `git merge-base --is-ancestor <base> HEAD` — necessary but NOT sufficient;
   60ced04 passed this.
2. Diff from it and confirm the task's NEW files actually appear as new. A
   deliverable missing from the diff means the baseline is downstream of it.
3. Prefer the merge-base recorded at land time (here 98d6e72, from the task's
   own handoff memory) over one recomputed later. From 98d6e72 the same owned
   paths were 14 files / 1537 insertions.

Related: `mem:git-log-path-names-mover-not-author`,
`mem:head-moves-mid-verification`.
