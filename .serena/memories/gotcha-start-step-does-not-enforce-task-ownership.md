# `moe.start_step` does not enforce task ownership; `complete_step` does

2026-08-15, task-bcea70569f714367b2e50c1734433631 ("Project configuration digest codec").

A worker wrapper injected a complete `claimed_task_context` (plan, rails, planningNotes,
`nextAction: start_step`) for `worker-40286572` on a task whose real owner was `worker-5dfdc624` —
alive, `CODING`, 3 seconds since last activity, on that exact `currentTaskId`.

**The asymmetry, which is the new fact.** `moe.start_step(taskId, "step-1", workerId=worker-40286572)`
returned `{"success": true, ...}` and flipped step-1 to `IN_PROGRESS`. Only the *next* mutating call
failed:

```
moe.complete_step -> [NOT_ALLOWED] Task task-bcea7056... is claimed by worker-5dfdc624, not worker-40286572
```

So a green `start_step` is **not** evidence you own the task. A spurious session mutates a live
peer's step state before it can possibly learn it owns nothing, and the prompt actively forbids the
one call (`claim_next_task`) that would have surfaced the conflict.

**Confirming the real owner — two independent reads, neither of which is the tool response:**
- `.moe/tasks/<id>.json` -> `assignedWorkerId` (the field is `assignedWorkerId`, NOT `assignedTo`
  or `claimedBy`; those read `undefined` and a naive check concludes "unowned").
- `moe.list_workers` -> real owner is `CODING` + that `currentTaskId` + single-digit
  `secondsSinceLastActivity`; you are `IDLE` with `currentTaskId: null`.

**How to apply.** Do the entire read-only half of step 1 — baseline gate, greps, compiled probes —
*before* any mutating Moe call. It is free, it is the one artifact a spurious session can usefully
leave behind, and it makes the bail-out cost nothing. On NOT_ALLOWED: stop. Do not retry with the
owner's `workerId` (the arg is a free string and the guard just passes). Do not call
`moe.report_blocked` — it flips the peer's live `WORKING` task to `BLOCKED` and kills their wrapper.
Do not write the shared `task-<id>-handoff` memory the real owner is still reading. Post the
evidence plus your baseline to #workers, mention the owner, and end the turn without a terminal
`moe.*` call — there is no terminal call a non-owner is entitled to make.

Related: `mem:moe-board-moves-under-a-measurement`, `mem:gotcha-worker-silently-deregistered-empty-queue-lies`.
