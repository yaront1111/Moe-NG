# Board deadlock: BACKLOG with planStepCount 0 and no architect

Observed 2026-08-09. `wait_for_task(WORKING)` returned `hasNext:false` twice in a
row (20 min). Not a daemon bug — the board had no worker-claimable task and no
way to produce one.

## How to recognize it

Run `moe.list_tasks` (no filter) and read `counts` plus `planStepCount` per task:

- `planning: 0`, `inProgress: 0` — nothing claimable for architect or worker.
- Every BACKLOG task has `planStepCount: 0` — none has an approved plan, so no
  worker can start any of them.
- `moe.list_workers` shows every registered worker BLOCKED except you.

That combination is a hard deadlock for the worker role. Waiting longer cannot
resolve it: BACKLOG -> PLANNING is an architect transition, and no architect
session exists to make it.

## Diagnosis order (cheap, three calls)

1. `moe.list_tasks` limit 200 — read `counts` and per-task `planStepCount`.
2. `moe.list_workers` — alive/BLOCKED split. Check `secondsSinceLastActivity`:
   a BLOCKED worker under the 120s liveness timeout is *alive and stuck*, not
   crashed. Never release its task; presence staleness alone is never grounds.
3. `moe.get_pending_questions` — rules out a human gate you could answer.

## What a worker must NOT do about it

Do not self-promote a BACKLOG task to WORKING to escape the idle. That
transition is an open governance question on this project, still unruled — see
`mem:moe-supervisor-spidr-children` for the surrounding epic state. Post the
diagnosis to the epic channel and end the session instead.

`moe.report_blocked` is not available here: it requires an owned task, and a
deadlocked worker owns nothing. Chat is the only durable channel.

## Routing dies silently when a role has no session

`moe.chat_send` returned `routingTargets: []` for a message mentioning
`@architect`. An @mention of a role with no live session is delivered nowhere
and reports success. Empty `routingTargets` in the send result is the only
signal that nobody will read it — check it, and say in the message body who is
missing so a later human reader can see the gap.

Same failure mode caught a REVIEW handoff: qa-cbad3a29 left (terminal_closed)
before the handoff was posted, so task-ba3a45f9 sat in REVIEW addressed to a
dead agent. Read the channel for `<agent> left (terminal_closed)` lines before
trusting that a handoff has a reader.

## Completion-gated vs work-gated BLOCKED

BLOCKED tasks with `completedStepCount == planStepCount` (seen on task-8ee125d0
at 4/4 and task-2d1f94f9 at 11/11) are not waiting on implementation — the work
is done and something at the completion gate refused. Distinguish these from
partially-stepped BLOCKED tasks before proposing any recovery; they need a
ruling, not a worker.
