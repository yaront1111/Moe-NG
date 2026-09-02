# A measurement can go stale inside one session — correct it yourself

2026-08-14: I blocked task-01c5f96e citing two causes. Cause 1 was "the macOS platform observation boundary
has not landed" — measured correctly: `packages/runner/src/platform/` had no `macos/` dir and
`PLATFORM_LAYERS` was frozen at `["PLATFORM_CONTRACT","PLATFORM_LINUX"]`. Within the hour, while I planned
other tasks, `task-45d12ecf` landed at commit `3b928c2`: `macos/` exists and PLATFORM_LAYERS is now three
members. My block reason was true when written and false when read.

**Rules this produces:**

1. **Re-measure immediately before the tool call that records the measurement**, not at the start of the
   investigation. On a live multi-agent board, minutes matter.
2. **When you discover your own recorded claim went stale, post the correction yourself**, naming the commit
   that invalidated it and stating which parts still stand. A governor routes on the recorded reason; a
   stale cause either wastes a re-plan or gets the block dismissed wholesale, including the half that is
   still real.
3. **Prefer disk/board reads through the daemon over `.moe/tasks/*.json`.** I read a task status from the
   on-disk JSON (modified/uncommitted at session start) and reported it as PLANNING; the live board did not
   list it at all. See also `mem:moe-status-messages-name-no-task`.
4. A block with two causes should say **which single condition remains** once one clears, so the reader does
   not have to re-derive the residue.

5. **An empty `wait_for_task` is not evidence of a dead board — it can mean the sole non-terminal row is
   already owned.** 2026-08-19, worker-57b745d5: `.moe/tasks` showed task-97554aa4 (Foundation self-host
   canary) as BLOCKED with 43 BACKLOG and 0 WORKING/PLANNING/REVIEW, matching a peer's independent scan.
   A full 600s `wait_for_task(WORKING)` returned `hasNext:false, timedOut:true`. The obvious reading —
   "board stalled behind a human gate" — was wrong. `moe.list_tasks` returned that same row as **WORKING**,
   `assignedWorkerId: worker-bb4011b8`; the unblock had landed at 14:43:37Z, mid-wait, wiping
   `blockedReason` to null. The queue was empty because the one row was taken, not because none existed.
   **`moe.list_workers` is the tool that separates the two cases**: it showed bb4011b8 `isAlive:true`,
   `status: READING_CONTEXT`, `lastActivityAt` 28s old, `staleWithAssignedTask: 0`. Never resolve an empty
   queue with `claim_next_task(replaceExisting:true)` before that check — a live holder mid-boot looks
   identical to a stranded row from the queue side alone, and stealing it puts two sessions on one file set.

Related: `mem:head-moves-mid-verification`, `mem:moe-block-conditions-go-stale-silently`,
`mem:peer-write-during-test-run-fakes-a-red`.
