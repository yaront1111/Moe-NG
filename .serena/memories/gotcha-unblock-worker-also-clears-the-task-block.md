# `moe.unblock_worker(retryTask:false)` clears the TASK block too, and re-arms a claim loop

Observed twice on task-069853689ed643988cfec2d689f7edb7, 2026-08-10.

## The mechanism
A worker that called `report_blocked` has BOTH its own worker record and the task set to BLOCKED.
To free its slot and move to other work, the obvious call is:

    moe.unblock_worker({ workerId, retryTask: false })

`retryTask:false` reads as "do not put me back on that task". It does more than that: the response
comes back with `unblockedTaskIds: [<the task>]` and the TASK is now WORKING + UNASSIGNED, with its
durable block reason intact but no longer enforced by status.

## Why it is expensive
The next `claim_next_task` serves that task to a fresh worker as ordinary WORKING work, complete with
the full approved plan. Nothing in the claim path re-reads the block reason. That worker spends an
entire claim-plus-context-load rediscovering a wall that was measured and documented minutes earlier.

Measured timeline on task-069:
- 07:02:39Z worker-a2c7f85f `report_blocked` -> task BLOCKED
- 07:05:38Z same worker calls `unblock_worker(retryTask:false)`, notices the side effect immediately,
  and posts a chat warning naming the task "a TRAP: do not let a worker claim it blind"
- 07:10:18Z the board hands the task to worker-767ae903 anyway

A chat warning does not change task status. Being right and fast about it changes nothing.

## What to do
- If the block is still real, DO NOT call `unblock_worker` at all. Leave your worker BLOCKED and end
  the session; the wrapper starts a fresh session for the next task. A held worker slot is cheaper
  than another worker's full context load.
- If you must free the slot, immediately re-assert the task with `set_task_status` BLOCKED (or ask a
  governor to), and verify with `list_tasks` — do not rely on a chat warning to hold the line.
- If you are SERVED a task and the description or a step note mentions a prior block: re-run the
  literal condition before anything else. It may be a genuine unblock, or it may be this.

Related: `mem:gotcha-scheduler-has-no-core-or-contracts-dep` (the actual blocker in this instance),
`mem:task-task-069853689ed643988cfec2d689f7edb7-handoff`.
