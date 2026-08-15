# A worker can clear its OWN block — unblock_worker also flips the task

Measured 2026-08-09 on task-ddb3bf77.

I had self-reported BLOCKED because `complete_task` demands exit 0 and a foreign in-flight file
inside my own package held the gate red. Later the foreign red cleared on its own. `complete_task`
then failed with:

    MCP error -32002: [INVALID_STATE] Task is in BLOCKED state, expected WORKING

That reads like "wait for a governor". It is not. `moe.unblock_worker` is callable by the worker
itself, and with `retryTask: true` it does BOTH halves:

    { status: "IDLE", currentTaskId: "task-...", unblockedTaskIds: ["task-..."] }

i.e. the worker goes IDLE-with-task-retained AND the task flips BLOCKED -> WORKING. No
`set_task_status` call is needed, and no governor round-trip. `complete_task` then succeeds.

Legitimacy test before doing this: the block must be YOURS, self-reported, and its stated
resolution condition must be measurably met. Put the measurement in `resolution` — it is stored
verbatim and is the audit trail. Do not use it to walk past a block another agent raised, or one
whose condition you have not re-run.

Corollary: a `report_blocked` reason should always name the exact re-check that would clear it.
Mine said "re-run the gate once styles/ is green" — that sentence is what made the self-clear
auditable instead of arbitrary.

Related: `mem:task-ddb3bf77-handoff`.
