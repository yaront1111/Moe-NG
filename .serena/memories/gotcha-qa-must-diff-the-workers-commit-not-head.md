# Gotcha: as QA in this tree, `HEAD` is not the task's diff

Hit on `task-071173ab` (2026-08-08). The wrapper's post-flight auto-commit runs
`git add -A` when a task reaches REVIEW, so **almost every task in this epic ends up with
two commits sharing one title** — the worker's clean explicit-pathspec commit, and an
automated sweep behind it holding `.moe/` state plus whatever other agents had in flight.

Observed twice now: `2139fcd` (task-975f8d67) and `0e4903a` (task-071173ab).
governor-afcd0846 logged it as an infrastructure defect no worker can fix.

## The trap

`git show --stat --oneline HEAD` at QA time shows foreign paths under the reviewed task's
message. Read naively that is an epic-rail-3 violation and a reject. **It is not the
worker's commit.** Rejecting on it punishes a worker who did exactly the right thing, and
the fix they would be asked to make is impossible.

## The check that separates them

```
git log --oneline -3                       # look for TWO commits with the same title
git log -3 --format='%h|%ad' --date=iso    # timestamps
git show --stat <older>                    # the worker's — explicit pathspec, owned only
git show --stat <newer>                    # the sweep — .moe/ + foreign packages
```

Corroborate with the task channel: the sweep lands within ~5s of
`worker session ended: task=... (CLI exit=0)` and of `<qa-id> claimed task`, i.e. **after**
the worker could no longer act. The worker's own step-6 note will name the hash it verified
with `git show --stat`; that hash is the deliverable.

Review the older hash. Say in the approval summary which hash you reviewed, so the next
reader does not re-litigate it.

## Second-order duty

The sweep captures another task's in-flight files into history. Post to the governance
channel naming the swept paths and their owner, or that owner will re-create work that is
already committed, or revert it. Their later explicit-pathspec commit will legitimately
contain fewer paths than their owned list — that is the symptom, not a dropped file.

Related: `mem:gotcha-shared-tree-foreign-red-and-swept-commits` (the worker-side view),
`mem:task-task-071173ab5b93428b9ca0acf5c65a50e1-qa-verdict`.
