# A verbatim-move DoD check goes RED at HEAD once a sibling edits the moved file

Hit on task-885a46e9 (moe-windows-job-core, SPIDR child 2a), 2026-08-09, QA
round 2.

DoD item: "the moved block is verbatim, verified by diffing against
`git show <base>:<old file>`". At round 1 it printed nothing. At round 2, the
identical command printed a 30-line diff — a whole `JOBOBJECT_BASIC_LIMIT_INFORMATION`
-> `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` rewrite inside the moved block.

Nothing about the task had changed. A SIBLING task had edited the moved file
after 2a's last commit, and a whole-tree completion hook committed it under
**2a's own task id**, so `git log -- <moved file>` named a commit whose subject
line was 2a's title. Every cheap attribution signal pointed at the task under
review.

## Why the usual defences do not fire

- `git log -1 -- <path>` names the hook commit, which carries the reviewed
  task's id. Reads as "the worker did this."
- `git status` is clean. The bytes are committed.
- The suite is green, because the sibling's change is correct.
- `mem:gotcha-git-diff-is-blind-to-untracked-paths` does not apply — the path is
  tracked. This is the opposite: tracked, committed, and misattributed.

## The check

Run a verbatim/fidelity assertion at the **reviewed task's own explicit-pathspec
commits**, not at HEAD:

```sh
for c in <task commit 1> <task commit 2>; do
  git show $c:<moved file> | grep -c ''
  diff <(git show <base>:<old file> | sed -n 'A,Bp' | sed 's/^    //') \
       <(git show $c:<moved file>)
done
```

Identical there and different at HEAD == a sibling edited it after. Confirm by
`git show --stat` on the hook commit: if it also carries files the task's
description lists as NOT IN SCOPE (here, a sibling-owned test file plus daemon
`.ts` and `.moe/` state), it is a whole-tree sweep, not the worker's pathspec
commit.

## The rule

Any DoD item phrased as "byte-identical / unchanged / verbatim" is a claim about
**bytes the task authored**, never about the file's state at HEAD, and it decays
the moment another agent touches the file in a shared worktree. Evaluate it at
the task's own commits. The project rail already says a task's files inside a
foreign commit is never a rejection reason; this is the mirror image — foreign
bytes inside a commit bearing the task's id — and it is equally not the
reviewed task's defect.

Related: `mem:moe-finished-task-may-have-no-commit`,
`mem:gotcha-sibling-in-flight-edits-red-your-owned-gate`,
`mem:head-moves-mid-verification`,
`mem:gotcha-kill-on-job-close-needs-extended-limit-class`.
