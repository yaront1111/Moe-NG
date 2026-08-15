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

Related: `mem:head-moves-mid-verification`, `mem:moe-block-conditions-go-stale-silently`,
`mem:peer-write-during-test-run-fakes-a-red`.
