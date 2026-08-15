# M1's exit gate is blocked on command composition, not on missing logic

Found 2026-08-09 by chasing the Foundation canary's (`task-97554aa4`) block report and
verifying every claim on disk. Records the state so the next session does not re-derive it.

## The finding

M1's exit condition is "J1, J3, J4 pass". **J1 cannot complete**, because the daemon's
command surface stops short of the journey:

```
GOAL_HANDLERS      = { "goal.create" }                      goal-services.ts:66
PLANNING_HANDLERS  = { "approval.decide", "plan.propose" }   planning-services.ts:156
BOOTSTRAP_COMMAND_KINDS = 9 kinds, none of them acceptance or close
```

Design 1095 says J1 is exactly three human actions: goal.create, plan/initial-graph
approval, **final acceptance of the verified reviewed result**. The third does not exist
anywhere in the daemon, and approval does not activate the graph (design 299 requires
approval + activation to be ONE atomic action).

## Why this is smaller than it looks

**@moe/core already implements all of it.** goal-contract.ts has GoalActivateInitialGraph /
GoalClose / GoalCancel / GoalQualificationInvalidated / GoalReopenAsRevision / Pause /
Resume; goal-reducer.ts has reduceGoal plus validActivation, validClosure,
validCancellation, validExpectedVersion, validProjectReady; planning-command-contract.ts
has PlanApprovalWitness and PlanningActivationWitness, both unused.

The daemon exposes handlers covering **two** of the eight goal commands. This is pure
composition work, which is why `task-671578e5` fits in 8 steps / 3 files.

## The general pattern this epic kept hitting

**Pure cores landed complete; the composition into authenticated durable commands did
not.** The same shape appeared three times as the exports-map wall (scheduler, runner,
daemon all had committed surface unreachable from their package root) and now a fourth
time as missing handlers. When auditing "is feature X done?", check the COMMAND PATH a
human would drive, not whether the domain logic exists.

## Still open after task-671578e5 (J1 only)

- **J3** — runner/Claude observation and recovery helpers are not composed into a real
  launcher and restart boundary.
- **J4** — @moe/review has pure helpers but no daemon/store persistence for finding
  lineage, changed-hash invalidation and carry-forward, successor replan, or retained
  review records.
- Fault schedules still declare core-to-store dispatch, durable restart adoption/outbox
  acknowledgement, terminal release, atomic release+handoff and review assignment ABSENT.

Neither J3 nor J4 has an owning task yet. A green J1 must not be read as a green canary.
