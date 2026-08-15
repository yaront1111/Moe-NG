# PLANNING → REVIEW is blocked; a register task still needs a plan

Hit 2026-08-15 closing `task-963cf1d125134c6193b7af0e53deeac3`, a holding
register whose DoD said "closed through a REVIEW transit hop rather than moved
straight to DONE".

## The refusal

```
moe.set_task_status { status: "REVIEW" }
[NOT_ALLOWED] status transition not allowed: PLANNING -> REVIEW.
Allowed transitions from PLANNING: AWAITING_APPROVAL, BACKLOG, BLOCKED
```

So REVIEW is only reachable as **PLANNING → AWAITING_APPROVAL → WORKING →
REVIEW**, and AWAITING_APPROVAL requires `moe.submit_plan`. Same family as
`mem:moe-backlog-to-done-transition-blocked`.

## The bind, and the way through

A register/slicing task usually carries a rail like "this is a register, not an
implementation task — do not write production code against it". That rail and the
REVIEW-transit DoD look contradictory: you cannot reach REVIEW without a plan,
and you must not plan production work.

They are not contradictory. Submit a **verification-only plan**: steps that
confirm the created slices exist, re-check the items that produced NO task
(those are the only ones that can vanish silently), re-state the reconciliation
arithmetic, and confirm `git status --porcelain` is clean. `distinctFileCount: 0`
and `newFileCount: 0` in the submit result is the proof the plan owns no
production path.

Do NOT take the other available exit and move the shell to BACKLOG — that
satisfies the daemon while abandoning the DoD, and it silently un-does the pass.

## Two things to say out loud when closing a register

1. **A diff-free completion is the correct outcome.** QA's habitual "no commit
   means no work" reading is wrong here; the product is board state — the created
   tasks plus the reconciliation comment.
2. **Children created by `create_task` default to BACKLOG and are NOT
   claimable** (agents claim only PLANNING/WORKING/REVIEW). Without an explicit
   promotion the sliced defects are parked exactly as before, just tidier. This
   is the follow-up that decides whether the whole pass mattered.

Related: `mem:moe-backlog-to-done-transition-blocked`,
`mem:moe-finished-task-may-have-no-commit`.
