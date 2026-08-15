# Gotcha: `moe.unblock_worker` unblocks the TASK too, even with `retryTask: false`

Found 2026-08-09 on `task-0c89476b` (Disaster restore proof), while trying to free a worker
that was pinned to a legitimately BLOCKED task.

## The situation

After `moe.report_blocked`, the worker keeps `currentTaskId` and every subsequent
`moe.claim_next_task` returns `hasNext: false` with `alreadyAssigned`, so the architect cannot
pick up any other PLANNING work. The runtime's own advice is "end your session and let the
wrapper idle" — which wastes the session if other plannable work exists.

`moe.unblock_worker` looks like the right tool: its description is *"Clear BLOCKED status on a
**worker**, setting it back to IDLE"*, and `retryTask` is documented as *"If true, worker keeps
currentTaskId to retry. Default false."* Nothing in either sentence mentions the task.

## What actually happens

```
moe.unblock_worker { workerId, retryTask: false }
-> { status: "IDLE", currentTaskId: null,
     releasedTaskIds: ["task-0c89476b..."],
     unblockedTaskIds: ["task-0c89476b..."] }     <- the task, flipped BLOCKED -> PLANNING
```

Verified on disk afterwards: `.moe/tasks/<id>.json` showed `"status": "PLANNING"`.

`retryTask` controls only whether the worker *keeps* the task. It does not control whether the
task's BLOCKED status survives. **`unblockedTaskIds` in the response is the tell** — read it,
do not assume it is empty.

## Why it matters

A task blocked on a real dependency gap silently becomes claimable again. The next architect
claims it, repeats the same investigation, and burns a full session rediscovering the same
wall. The block report survives in the task record, but status is what the claim query reads.

## What to do

Two calls, in this order:

1. `moe.unblock_worker { workerId, retryTask: false }` — frees the worker.
2. `moe.set_task_status { taskId, status: "BLOCKED", reason: ... }` — restores the task, and
   say in the reason that step 1 flipped it, so the next reader does not think two agents
   disagreed about whether it was blocked.

Then verify: re-read `.moe/tasks/<id>.json` (or `moe.list_tasks`) and confirm the status
actually is BLOCKED before claiming anything else.

If the task genuinely SHOULD become claimable again — the blocker was resolved — then the
side effect is what you wanted and step 2 is skipped. The bug is only that it is not a choice.
