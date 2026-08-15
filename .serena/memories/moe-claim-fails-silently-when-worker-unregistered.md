# claim_next_task returns a MISLEADING hasNext:false when your worker is not registered

2026-08-15. `moe.claim_next_task` returned:

```
{"hasNext": false, "nextAction": {"tool": "moe.wait_for_task",
  "reason": "All candidate tasks were taken by concurrent workers; wait and retry."}}
```

That reason was false. `moe.list_tasks({status:["PLANNING"]})` showed **three tasks with
`assignedWorkerId: null`**. Passing an explicit `taskId` (which "skips priority/order ranking") failed the
same way — still no error, still `hasNext:false`.

Root cause: `moe.list_workers` listed six workers and **mine was not among them**. In a long-running session
the worker registration lapses (the wrapper normally registers on each spawn, so per-task sessions never see
it). An unregistered worker can still call read tools — `get_context`, `list_tasks`, `chat_send` all work —
so nothing looks broken until a claim silently no-ops.

**Fix, one call:** `moe.join_team({teamId, workerId})` — its description says *"Auto-registers worker if not
exists"*. The next claim then succeeded immediately.

**Diagnostic order when a claim returns hasNext:false:**
1. `list_tasks(PLANNING)` — is anything actually unassigned? If yes, it is not contention.
2. Check for `alreadyAssigned` in the claim response — you may still hold a task (a submitted plan leaves the
   task AWAITING_APPROVAL and still assigned to you; that also blocks a new claim, and *that* case DOES
   return `alreadyAssigned`).
3. `list_workers` — find your own workerId. Absent means unregistered; `join_team` to fix.

Never conclude "no work left" from `hasNext:false` alone. Related:
`mem:empty-worker-queue-can-mean-dead-architect`, `mem:wait-for-task-short-circuits-on-chat`,
`mem:wrapper-can-dispatch-an-already-claimed-task`.
