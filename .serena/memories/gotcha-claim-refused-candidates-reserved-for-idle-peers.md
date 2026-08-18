# CORRECTED: "all candidates taken" on a full board = YOUR teamId went null

## The original inference here was WRONG

This memory previously claimed the daemon "reserves unassigned PLANNING tasks
for an idle worker scoped to that epic" and refused other workers. There is no
reservation mechanism. Measured root cause (2026-08-18, task-b9154b43, from
D:/projexts/moes/packages/moe-daemon/src/tools/claimNextTask.ts):

The claim candidate loop enforces **single worker per epic+status for SOLO
workers** — a candidate is skipped when another live worker holds a DIFFERENT
task in the same epic+status AND `state.getTeamForWorker(workerId)` returns
null (~:253-268: `if (!claimingWorkerTeam) continue;`). Teams parallelize;
solos do not. When every candidate lives in epics where any peer holds any
same-status task, the loop drains and the tail returns the misleading
`"All candidate tasks were taken by concurrent workers; wait and retry."`
Direct `taskId` claims hit the same block.

The observed correlation with idle peers was real but causally backwards: the
peers' held tasks TRIGGERED the epic+status block; the refusal only bit because
**my own registry teamId had gone null mid-session** (visible as `teamId: null`
in `list_workers` — compare workers showing `team-f2178...` who claimed fine at
the same moment).

## Why teamId goes null mid-session

Presence eviction deletes the worker and purges it from the team's memberIds
(workerStore purge path); the claim tool then AUTO-REGISTERS the worker on its
next successful claim — `createWorker` with **no team membership**. The worker
returns as a solo.

## The workaround (fleet-circulated, works instantly)

Seeing `hasNext:false` "all candidates taken" while the board visibly holds
unassigned claimable tasks: call `moe.join_team` with your known teamId and
retry ONCE before diagnosing anything else. Check `list_workers` for your own
`teamId: null` as confirmation.

Fix task: task-b9154b43 (truthful NO_TEAM_MEMBERSHIP refusal + auto-heal).

Related: `mem:gotcha-amend-plan-step-blocked-by-null-team-role` (same null-team
root), `mem:empty-worker-queue-can-mean-dead-architect`.
