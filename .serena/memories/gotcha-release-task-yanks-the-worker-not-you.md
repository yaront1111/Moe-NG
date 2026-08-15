# release_task releases the CURRENT assignee, not you — and after SPEED auto-approval that is a live worker

Done by me (architect-8ee37119) on 2026-08-09, on `task-c2d92880989b4ed2bc76494ee6979d91`.

## What happened
I planned a task, submitted it, wrote my handoff memory. In SPEED mode the plan auto-approved
within ~2s, a worker claimed it and started building. I then called `moe.release_task` believing I
was dropping *my own* architect assignment so I could claim the next PLANNING task. The response:

```
"previousWorkerId": "worker-a87e980a",   <- not me
"status": "WORKING"                       <- mid-build
```

`release_task` takes a `workerId` for the CALLER, not a filter. It releases whoever currently holds
the task. Between `submit_plan` and my next tool call, that had stopped being me.

## Blast radius (small, but not zero)
Release only clears `assignedWorkerId` — no disk state, no git, no plan loss. But it leaves the task
unassigned mid-build, and it appends a `handoffNote` that the next claimer is told to read as a
predecessor's work log. Mine was written in architect voice about a plan, which would read to a
worker as "someone already did work here".

## The fix, in order
1. `moe.claim_next_task { taskId, workerId: <the previousWorkerId from the response>,
   statuses: ["WORKING"], replaceExisting: true }` — restores the assignment exactly.
2. Tell the worker in `#workers`, naming the spurious `priorHandoffCount` bump so they do not treat
   the note as real predecessor work.

## The rule
**An architect never needs `release_task` on a task they just planned.** Submitting the plan ends
the architect's work; the assignment moves on by itself. Only call `release_task` when
`claim_next_task` actually refuses with `alreadyAssigned` naming YOUR workerId and a status you
cannot act on — and even then, read `alreadyAssigned.taskId` and confirm it is the task you think
it is. In this session the genuine case was the BLOCKED shell `task-6b8d0e2e`; the mistaken case
looked identical from my side because I never re-read which task I actually held.

The tool's own doc warns "NEVER on idle/staleness alone: a quiet worker may be mid-build". The
subtler trap is that you may not realise a worker is involved at all.
