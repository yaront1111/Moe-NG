# An empty PLANNING queue can mean the board is DAMMED, not starved

`claim_next_task {statuses:["PLANNING"]}` returning `hasNext:false` looks like
"no work". On 2026-08-15 it meant the opposite: **12 BLOCKED, 0 PLANNING,
0 REVIEW**, with three CRITICAL tasks fully implemented, committed,
adversarially reviewed and green — stranded on ONE shared stale block premise.

## The shape
task-e33747f9 (8/8 steps), task-6f786c58 (10/10), task-cf7fb147 (8/8) each
reported BLOCKED because `pnpm --filter @moe/daemon typecheck` was held red by
committed FOREIGN files they did not own:

    src/daemon-entry.ts(176,5): TS2322  string | undefined -> string
    src/daemon-entry.ts(191,3): TS2322  Readonly<{csrfToken: string|undefined…}> -> DaemonStartResult
    src/identity/session-services.test.ts(173): TS2339

Every refusal was CORRECT under epic rail 4 (never fabricate a pass). Someone
then fixed those files. **Nothing re-runs a block premise when the world
changes**, so all three stayed blocked with no live worker attached.

Re-measured at HEAD 65a3241: typecheck EXIT 0, full gate 89 files / 1823 tests,
`TRUE_GATE_EXIT=0`.

## What to do when the PLANNING queue is empty
Do NOT conclude "no work". Run `list_tasks` across BLOCKED/WORKING and look for:
- tasks whose `completedStepCount === planStepCount` sitting in BLOCKED — that is
  finished work that cannot move, never normal flow;
- several blockedReasons quoting the SAME error text — one shared cause;
- `status: WORKING` with `assignedWorkerId: null` / `hasWorker: false` — a dead
  session, not progress.
Then re-run each block's literal condition. See `mem:moe-block-conditions-go-stale-silently`
and `mem:count-the-clauses-in-a-block-premise`.

## Two reading traps that hid it
1. `moe.list_tasks` `counts` **omits `blocked` entirely**
   (`mem:moe-counts-object-omits-blocked-entirely`). Summing the named counts
   showed 4 of 16 and read as a nearly idle board.
2. I nearly quoted `GATE_EXIT=0` from a `| tail` run — that is **tail's** exit
   code, not the suite's (`mem:piped-gate-run-reports-tail-exit-code`). Re-ran
   unpiped before reporting. Do not diagnose a stale gate with a stale method.

## Role boundary
An architect may re-measure and post the evidence to the tasks; **releasing the
blocks is the governor's call**. Note a lapsed worker registration blocks
`chat_send`/`chat_join` ("Unknown worker" — the 30-min stale timeout), but
`moe.add_comment` still accepts a free-string `author`, so task comments remain
a working escalation channel.
