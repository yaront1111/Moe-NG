# A stale block premise can strand a fully-approved plan

Measured 2026-08-15 on epic-bf111658f9694b558bdc5596bbf0f924 (M5 GA evidence)
during a total board starvation (0 PLANNING, 0 live architects, 0 live QA,
5 idle workers).

## The finding

`task-5dfc98fc3e7f4035a8012bd9ba032de3` "Path-neutral project configuration
manifest" — BLOCKED, HIGH, `planStepCount: 7`, `completedStepCount: 0`,
`planSubmittedAt`/`planApprovedAt` both 2026-08-13T22:51Z,
`blockedFromStatus: WORKING`, `blockedAt` 2026-08-13T22:58Z.

Stored `blockedReason`, verbatim:

> Its approved step 1 explicitly requires task-0c21ba2 and task-bcea7056 DONE,
> but both are BACKLOG and absent on disk. Keep the daemon selection parent
> blocked rather than letting an unassigned WORKING shell be claimed against
> missing contract/codec authority.

Re-ran that literal condition against disk on 2026-08-15:

    task-0c21ba2f07cc4f4a829e475bbd7f0562  DONE  Project configuration manifest contract
    task-bcea70569f714367b2e50c1734433631  DONE  Project configuration digest codec

Both DONE, both present. **The premise is false on both clauses** and has been
since those two landed. It was true when written; nothing re-checked it.

## Why this shape is worth recognising

A BLOCKED task with `planStepCount > 0` is categorically different from a
BLOCKED task with `planStepCount: 0`. The latter needs an architect. The former
needs only a premise re-check — and because `blockedFromStatus` was WORKING,
unblocking returns it straight to a worker-claimable column with an approved
plan already attached. On a board with no live architect, that is the ONLY kind
of task that can be made workable without spawning one.

So when diagnosing a starved queue, do not stop at the BACKLOG count. Two peers
reported this stall from a BACKLOG-only query and both missed it; the BLOCKED
column was larger (9 vs 6) and contained the one cheap unblock.

## How to apply

1. Starved queue -> pair `list_tasks` over BOTH backlog AND blocked with
   `list_workers`. See `mem:empty-worker-queue-can-mean-dead-architect`.
2. For each BLOCKED entry, read `.moe/tasks/<id>.json` -> `blockedReason` and
   **re-run the literal condition**. Block conditions go stale silently.
3. Sort candidates by `planStepCount`: >0 means already planned, no architect
   needed. Check `blockedFromStatus` to know which column it returns to.
4. Premise-satisfied is NOT work-verified. Here step 1 still demands the
   export grep plus the three-form consumer-edge proof (package.json dep,
   pnpm-lock importer, bare-specifier probe) — deps DONE is not deps reachable
   (`mem:deps-done-is-not-deps-reachable`). That is the claiming worker's job.
5. ARCHIVED is not DONE in a dependency check
   (`mem:moe-archived-is-not-done-in-dep-checks`) — confirm the literal status.

## What a worker must NOT do about it

BLOCKED is not an agent-claimable column, and flipping your own next task out
of BLOCKED is an ownership bypass. Report it; let a governor/human/architect
move it. Same rail as never taking a live peer's task with `replaceExisting`.
