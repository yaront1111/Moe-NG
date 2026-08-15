# Board dependency scans: four ways to be confidently wrong

Learned 2026-08-10 governing the moe-next board. Each of these produced a WRONG answer that looked
authoritative, and I hit all four in one session.

## 1. Short task ids
Blockers are written both ways: `task-5855a9c6` and the full 32-hex form. A
`/task-[0-9a-f]{32}/g` regex silently misses the short form. `task-5e43a9e2` reported "no id deps"
while its blockedReason names five. **Match `{8,32}` and resolve by prefix**, asserting the prefix is
unique.

## 2. Prose dependencies
Many tasks state deps as TITLES, not ids: "Hard dependencies: Readiness explanation engine, Lease
presence core, Conserved budget core." An id scan sees nothing and reports "no deps" — which reads
as *promotable*. And the clause is not even stable: `task-8af4562f` uses the SINGULAR
"Hard dependency:", which a `/Hard dependencies:/` regex skips. Resolve titles against the task list.

## 3. Every mentioned id is not a dependency
`task-acf73253`'s blockedReason names `task-6cbff010` as explicitly **downstream** ("remains
downstream task-6cbff010's responsibility"). `parentTaskId` relationships read as deps too. Treating
mentions as deps invented an `acf73253 <-> 4d1f8ba5` deadlock that does not exist — they are parent
and child. **There was no cycle anywhere on the board.** Check the direction before reporting one.

## 4. For a SHELL, children are the gate — not blockedReason
`task-97554aa4` (Foundation self-host canary) scanned as "all deps satisfied" because the ids in its
blockedReason were all DONE. It has **9 children, 6 open**. A SPIDR parent is gated by
`parentTaskId` children, and a scan that ignores them promotes finished-looking shells that are not
finished. Conversely a shell whose children are ALL done is *closable* and should not sit in BLOCKED
misreporting the board.

## The structural payoff, once the scan is right
The 19 blocked tasks were not 19 independent blocks — they were four SPIDR trees plus one
standalone. Every one was either a shell awaiting its own children (auto-resolves, no governor
action) or a leaf awaiting exactly one WORKING task. Correct conclusion: nothing was
architect-unblockable, and that was the healthy state rather than a stall. Adding architects would
not have helped; the remaining work was serial by genuine dependency.

## Closing a finished shell
Moe permits `BLOCKED -> {WORKING, PLANNING, REVIEW, BACKLOG}` only; `DONE` is NOT directly
reachable, and `REVIEW` is barred when the task was blocked *from* PLANNING. `archive_task` accepts
BACKLOG/REVIEW/DONE. So the clean route is **BLOCKED -> BACKLOG -> archive**. Do not push a no-diff
shell through WORKING+REVIEW just to reach DONE — that manufactures phantom QA work.
Related: `mem:deps-done-is-not-deps-reachable`, `mem:moe-hard-dependencies-are-prose-not-fields`.
