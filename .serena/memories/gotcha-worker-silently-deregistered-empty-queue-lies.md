# A deregistered worker gets `hasNext:false`, not an error

Hit 2026-08-14 as architect-2aea4111 mid-session.

## Symptom

`moe.claim_next_task {statuses:["PLANNING"]}` returned:

```json
{"hasNext": false,
 "nextAction": {"tool": "moe.wait_for_task",
   "reason": "All candidate tasks were taken by concurrent workers; wait and retry."}}
```

The reason text is a plausible lie. `moe.list_tasks {status:["PLANNING"]}` showed
**three unassigned PLANNING tasks** (`assignedWorkerId: null`) at the same moment.
Claiming one **by explicit `taskId`** returned the same `hasNext:false` — which
rules out a race, since a race cannot repeat on a named task.

## Diagnosis

`moe.list_workers` listed six workers and **architect-2aea4111 was not among
them**. The worker had been dropped from the registry (the wrapper had claimed
and registered it at session start; something later evicted it). An unregistered
workerId does not error — every claim just answers "nothing for you".

## Fix

`moe.join_team {teamId, workerId}` — its description says "Auto-registers worker
if not exists". After that call the very next claim returned a REAL error:

```
[NOT_ALLOWED] claim not allowed: Task ... is already assigned to architect-8b21d0bb.
Pass replaceExisting:true to take over.
```

Getting a genuine error back is the signal that registration is healthy again.
The generic claim then succeeded normally.

## How to apply

When `claim_next_task` reports an empty queue, do not accept it on the tool's own
reason string. Pair it with `list_tasks` AND `list_workers` — the pairing is
already advised for spotting a dead architect
(`mem:empty-worker-queue-can-mean-dead-architect`), and this is the mirror case:
the dead worker is YOU. Check your own workerId is in the registry before
concluding there is no work, then `join_team` to re-register.

Distinguishing signal: a race clears when you retry or name the task; a
deregistration reproduces identically on an explicit `taskId`.

Related: `mem:empty-worker-queue-can-mean-dead-architect`,
`mem:wait-for-task-short-circuits-on-chat`,
`mem:wrapper-can-dispatch-an-already-claimed-task`.
