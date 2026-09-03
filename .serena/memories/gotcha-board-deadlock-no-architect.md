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

## 2026-08-30 variant: deadlock with ZERO BACKLOG-shaped rows

Same symptom (`wait_for_task(WORKING)` -> `hasNext:false`, 300s timeout), but the
recognizer above does NOT fire: rows are not "BACKLOG with planStepCount 0".
Every non-terminal row is unclaimable for a *different* reason. Measured
04:23:37Z, HEAD b8dd739a, `total 7` (BACKLOG 1, PLANNING 2, BLOCKED 2, WORKING 2,
REVIEW 0, archived 46):

| row | status | why unclaimable |
|---|---|---|
| be80cb74 | BLOCKED | `blockedOnTaskIds: null`, `dependsOnUnmet: 0` -> no auto-unblock branch can key on a null |
| f42d5165 | WORKING | `dependsOnUnmet: 1`; claim returns `[NOT_ALLOWED] ... has unmet dependencies` |
| c289b8fb | WORKING | `dependsOnUnmet: 2` (be80cb74 + f42d5165) |
| e60b874b | BLOCKED | operator-deferred; `blockedOnTaskIds` live, auto-unblocks behind c289b8fb |
| c4321b6f | BACKLOG | human-gated column |
| 2f554e29, 5d462855 | PLANNING | architect seat; none registered |

So `counts.inProgress: 2` reads as a healthy board and is a lie about
claimability. **Recognizer for this variant: `inProgress > 0` but every WORKING
row has `dependsOnUnmet > 0` and `assignedWorkerId: null`.** `dependsOn` gates
the *claim*, not the plan, so a WORKING row can hold a full 6-step plan and still
be untakeable by every seat.

Remedy verb is `moe.set_task_dependencies`, which errors "must be on an architect
or governor team" for worker and QA seats. `list_workers` showed 5 alive, 0 stale,
zero architect, zero governor. Seats come from the JetBrains plugin, not the repo,
so no session here can produce one.

Do NOT `report_blocked` a dep-gated WORKING row to make it visible: it is
correctly WORKING, and blocking it adds a *second* manual block that also never
auto-unblocks (and BLOCKED -> PLANNING nulls the quartet on the way back).
File on the row as a comment and end the session.

## Routing dies silently when a role has no session

`moe.chat_send` returned `routingTargets: []` for a message mentioning
`@architect`. An @mention of a role with no live session is delivered nowhere
and reports success. Empty `routingTargets` in the send result is the only
signal that nobody will read it — check it, and say in the message body who is
missing so a later human reader can see the gap.

`@all` is not a workaround: at 21:57Z on 2026-08-18, a `@all` census sent with
five alive+IDLE workers and a live qa on the roster STILL returned
`routingTargets: []`. Empty routing does not imply an empty roster — it means
no session is currently parked on a receive, so a census posted at the end of a
hold reaches only a later human reader. Write it for that reader.

Same failure mode caught a REVIEW handoff: qa-cbad3a29 left (terminal_closed)
before the handoff was posted, so task-ba3a45f9 sat in REVIEW addressed to a
dead agent. Read the channel for `<agent> left (terminal_closed)` lines before
trusting that a handoff has a reader.

## Second variant (2026-08-18): architects ALIVE and IDLE, PLANNING unclaimed

Same symptom for a worker (`wait_for_task(WORKING)` -> `hasNext:false`, twice,
15+ min) but the opposite cause. Measured at 20:43Z and again at 20:59Z, board
byte-identical between the two reads:

- `list_tasks` counts: `planning: 9`, `inProgress: 0`, `review: 0`,
  `awaitingApproval: 0`, `backlog: 0`. Every PLANNING row `planStepCount: 0`
  and `assignedWorkerId: null` — including CRITICAL rows (task-2b4aa38f,
  task-3ac5c237).
- `list_workers`: 9/9 `isAlive: true`, ALL `status: IDLE`, including
  architect-2bd00363 and architect-6c720ab6 with `secondsSinceLastActivity`
  under 45. Both architects had claimed and released tasks minutes earlier, so
  the sessions are real and healthy.

So: live architects, zero claimed PLANNING rows, for a quarter hour. This is NOT
the 2026-08-09 deadlock (no architect session existed there) and NOT something a
worker can fix. The suspect is the wrapper's PLANNING dispatch — an architect
that is registered and IDLE is between wrapper-launched sessions; if the wrapper
stops launching them, the roster still reads healthy while the lane starves.

Distinguish the two variants by `list_workers` alone: no architect row at all =
2026-08-09 deadlock; architect rows alive+IDLE with PLANNING > 0 unclaimed =
dispatch gap. Only the second is worth escalating to the human as a fleet
defect, and the escalation belongs to the governor, not the worker.

Also: a governor saying "N claimable" can mean architect-claimable. Before
treating it as work for you, filter by status yourself — `PLANNING` rows are
claimable for the architect role and invisible to `wait_for_task(WORKING)`.
See `mem:moe-wait-for-task-offers-what-claim-refuses` for the inverse trap.

## The dispatch gap DEGRADES into the no-architect deadlock (2026-08-18, 21:46Z)

Same board, ~1h after the variant above, measured by worker-1d896f28 after four
consecutive 10-minute `wait_for_task(WORKING)` timeouts (40 min, all
`hasNext:false`, `timedOut:true`):

- `list_tasks` counts: `total: 369`, `backlog: 43`, `planning: 9`,
  `awaitingApproval: 0`, `inProgress: 0`, `review: 0`, `done: 314`. Identical
  9 PLANNING rows, all still `planStepCount: 0` (task-2b4aa38f, task-3ac5c237,
  task-1162c002, task-90283f0f, task-3767f2cd, ...).
- `list_workers`: SEVEN rows, and **not one architect among them** — 5 workers
  + qa-bbdecc14 (all `isAlive: true`, all `status: IDLE`) + governor-f4cdc6ee
  (`GOVERNING`, `secondsSinceLastActivity: 421`, `isAlive: false`).

So the two variants are not disjoint states, they are a sequence: the wrapper
stops dispatching PLANNING sessions (architects read alive+IDLE), then the last
architect session exits and its row leaves the roster entirely. The
`list_workers` discriminator still works — it just tells you which *stage* you
caught it at, not which distinct bug. Re-run `list_workers` before quoting an
earlier census: the roster changes shape underneath a hold.

Corollary worth its own note: the governor can *read* stale (`isAlive: false`)
while its own escalation is still the only open remedy. A governor message
saying "human notified twice, hold pattern is correct" can outlive the governor
session that sent it. Confirm the escalator is still alive before assuming
anyone is watching for the respawn.

### CORRECTED 2026-08-18 21:57Z: that stale governor was NOT dead

worker-bb4011b8 re-measured 11 minutes after the census above. governor-f4cdc6ee
posted to the channel at 21:57:29Z and `list_workers` then read
`secondsSinceLastActivity: 11, isAlive: true`. The governor's own explanation:
**`chat_wait` long-polls do not heartbeat mid-wait**, so a governor parked on a
blocking receive accrues unbounded `secondsSinceLastActivity` and crosses the
120s liveness timeout while perfectly healthy. The 421s reading was a
measurement artifact of the presence signal, not an eviction.

Practical rule: `isAlive: false` on a **governor** (or any agent that parks on
`chat_wait`/`wait_for_task`) is weak evidence. `isAlive` measures
last-tool-activity, not liveness, and a long-poll is deliberate silence. Same
caution the memory already states for BLOCKED workers ("never release its task")
applies to reading a governor as dead. To actually test it, post to the channel
and see if it answers — a reply is proof of life; a roster row is not.

This does NOT weaken the architect finding: an architect that is absent from
`list_workers` has no row at all, which is a different signal from a row with a
stale timestamp. Absence still means no session. Only the governor-is-stale
conclusion was wrong.

Board state at 21:57Z, 22:08Z, and again at 22:09Z (after a 6th 10-minute
`wait_for_task(WORKING)` timeout, this one measured by worker-1d896f28 in a
fresh session) was unchanged: 7 roster rows / 0 architects, `planning: 9` all
`planStepCount: 0`, `inProgress: 0`, `review: 0`. Deadlock real, remedy still
human-side wrapper respawn. Note the shape of the fresh session: the wrapper's
pre-flight reported "no claimable task" and ordered `wait_for_task` as the first
call, so a respawned worker does not break the deadlock — it just re-enters the
same dry hold and burns a session.

Direct @mentions do not escape the empty-routing trap either. At 21:59Z a
`chat_send` naming five specific agents (governor + 3 workers + qa), every one of
them `isAlive: true` in a `list_workers` call 30 seconds earlier, still returned
`routingTargets: []`. So empty routing is not about @all vs. explicit mentions
and not about roster liveness — it means no session is parked on a receive at
send time. Alive-and-IDLE is not the same as listening.

One row deserves a human's eye on respawn: **task-a9fd91c373c244c78df97945965a8038**
("Foundation attempt ingress composition", CRITICAL, epic-bd387eeb) sits in
BACKLOG with `planStepCount: 7, completedStepCount: 2` — a partially executed
plan pushed back into an unclaimable column. BACKLOG does not imply untouched;
check `completedStepCount` before re-planning such a row from scratch.

**It is not one row — it is four** (worker-a211f4b4, 22:33Z, `list_tasks` over
BACKLOG+PLANNING+WORKING+REVIEW, limit 60, 52 live rows returned). Every census
above reported "9 PLANNING rows, all `planStepCount: 0`", which is true and
incomplete: the plans that exist are all sitting in BACKLOG.

- task-a9fd91c3 "Foundation attempt ingress composition" (CRITICAL) — 7/2
- task-9a1eb61d "Graph Beta: mint the server-owned launch-template producers" — 11/3
- task-225d25f7 "Read the strict Foundation context manifest" (CRITICAL) — 5/1
- task-4d715e90 "Durable Claude provider-profile content and current resolver" (CRITICAL) — 6/0

So the deadlock is not purely "no plan exists to execute". Three tasks hold
in-flight step progress parked where no worker can reach it. Two consequences
for whoever triages after a respawn: (a) ~~these four need the *smallest*
architect action — a status move~~ **GOVERNOR RULING 22:34Z/22:44Z: DECLINED.
All four are DELIBERATE v0.2 scope-freeze parks (each carries a park
reopenReason). Do NOT status-move them under the 0.1 series; re-promotion requires fresh
measurement + governor approval. a9fd91c3's own step-2 probe OVERTURNED its
plan's route (comment-27c93fe9), so "resume the parked plan" is doubly wrong
there.** (b) a completed step may already have its
commit at HEAD, so re-running one blind risks a double-commit — though on
a9fd91c3 specifically the 2 completed steps were read-only investigation with
NO commits (comment-27c93fe9) — see
`mem:step-can-be-in-progress-with-its-commit-already-landed`. Read
`completedStepCount` on every BACKLOG row before quoting a board as unplanned.

Worker's correct move at this stage is unchanged from 2026-08-09: do not
self-promote anything, post the census once, and end the session. Nothing in
band promotes BACKLOG -> PLANNING or launches an architect; both are
wrapper-side.

## The governor row lives on a DIFFERENT team than the fleet (2026-08-18 21:57Z+)

Independent of the liveness question, `list_workers` shows a team split that no
census above called out. Measured by worker-6abf6bd7 at 21:57Z, 22:08Z and
22:28Z, identical all three times:

- 5 workers + qa-bbdecc14 -> `teamId: team-f2178c1f74704c72b927102498b5edd5`
- governor-f4cdc6ee -> `teamId: team-e6831a9fcefc483cbafed2878e29c0bf`

That is the `mem:two-teams-named-moe-next-heal-into-the-fleet-team` split showing
up in a live roster: the governor is not on the fleet team. Worth a human's eye
on respawn — if governance actions are ever team-scoped, a governor sitting on
the other team row acts on a board the workers are not watching. Not proven to
cause the deadlock; recorded because every deadlock census so far reported the
governor row without reading its `teamId`.

Also a third independent confirmation that the governor is NOT dead: its
`lastActivityAt` advanced 21:57:33Z -> 21:59:14Z -> 22:20:48Z across the three
samples, i.e. it ticks every 10-20 min and reads `isAlive: false` in between,
exactly as the `chat_wait`-does-not-heartbeat correction predicts. Do not
re-derive "governor dead" from a single stale row; sample it twice, minutes
apart, and compare `lastActivityAt`.

Hold evidence from this session: three consecutive
`wait_for_task(WORKING, 600000ms)` calls, 21:58Z-22:28Z, all
`hasNext:false, timedOut:true`, with zero architect rows in `list_workers`
before the first and after the last. Total observed dry hold across sessions is
now well over 90 minutes.

### The team split HEALED by 22:30Z — do not carry it into the respawn note

worker-a211f4b4 re-read `list_workers` at 22:30:53Z, two minutes after the 22:28Z
sample above: all **seven** rows now carry
`teamId: team-f2178c1f74704c72b927102498b5edd5`, governor-f4cdc6ee included
(`status: GOVERNING`, `secondsSinceLastActivity: 25`, `isAlive: true`). The
`team-e6831a9f...` row is gone. So the split is transient, not structural — it
re-appears when the governor row is (re)created and heals on its own, exactly as
`mem:two-teams-named-moe-next-heal-into-the-fleet-team` describes. Re-measure
`teamId` before quoting a split from any census older than a few minutes.

Same sample: still zero architect rows, all six non-governor rows `IDLE`, and a
`wait_for_task(WORKING, 600000ms)` spanning 22:20Z-22:30Z returned
`hasNext:false, timedOut:true`. Deadlock unchanged; only the team reading moved.

Confirmed independently by worker-bb4011b8 at 22:29:33Z (all 7 rows on
`team-f2178c1f...`) and, more usefully, by the governor itself in-channel at
22:29:28Z: it states it JOINED team-f2178c1f, and that the split "demonstrably
did NOT scope-block governance tonight — my status flips, releases and comments
all landed fleet-visible". So the heal is an action the governor took, not a
daemon self-repair, and the split's blast radius is now attested rather than
assumed: latent hazard, not the deadlock cause. Direction matters and matches
`mem:two-teams-named-moe-next-heal-into-the-fleet-team` — governance heals INTO
the fleet team, never the reverse.

Also note the governor said it "holds the watch alone" and expects the fleet to
go fully dormant. A worker arriving after that point should not read an empty
roster of peers as new information.

### Last observed state 22:40:27Z — deadlock intact after the heal

worker-57b745d5, one more `wait_for_task(WORKING, 600000ms)` spanning
22:30Z-22:40Z: `hasNext:false, timedOut:true` (fourth consecutive dry 600s wait
in that session). Re-measured immediately after:

- `list_workers`: 7 rows, `alive: 7`, `stale: 0`, still **zero architect of any
  id**, all six non-governor rows `IDLE`, all 7 on `team-f2178c1f...`
  (heal holds across a 10-minute gap, so it is stable, not a sampling blip).
  governor-f4cdc6ee `GOVERNING`, `lastActivityAt 22:39:56Z` — proof of life.
- `list_tasks(status: [PLANNING, WORKING, REVIEW])`: 9 rows returned, ALL
  PLANNING, every one `planStepCount: 0` and `assignedWorkerId: null`;
  `inProgress: 0`, `review: 0`, `awaitingApproval: 0`.

Note that status-filtered call is the cheap discriminator and it hides the
BACKLOG stepped rows entirely — `counts.backlog` reads `0` because counts are
filter-scoped (`mem:moe-list-tasks-counts-are-filter-scoped`). Do not conclude
"no parked plans exist" from it; the four stepped BACKLOG rows listed above are
still there. Query BACKLOG explicitly when triaging for the cheapest restart.

So the terminal state of the 2026-08-18 evening is: team split healed, governor
alive and watching, architect lane still empty, board frozen. Nothing changed in
the ~55 minutes from the 21:46Z census to here except the teamId reading.

## Completion-gated vs work-gated BLOCKED

BLOCKED tasks with `completedStepCount == planStepCount` (seen on task-8ee125d0
at 4/4 and task-2d1f94f9 at 11/11) are not waiting on implementation — the work
is done and something at the completion gate refused. Distinguish these from
partially-stepped BLOCKED tasks before proposing any recovery; they need a
ruling, not a worker.

### The census number "52 live rows" is WRONG — it is 55, and the 3 missing rows are BLOCKED

Every census in the 2026-08-18 thread (four independent agents) reported
"52 non-archived rows". That figure is `43 backlog + 9 planning + 0 + 0 + 0`,
summed from the `counts` object. `counts` has **no `blocked` key at all**
(`mem:moe-counts-object-omits-blocked-entirely`), so BLOCKED rows are invisible
to any total derived by adding up the reported fields. Measured by
worker-57b745d5 at 22:42Z:
`list_tasks(status: [BACKLOG, PLANNING, BLOCKED])` -> `pagination.total: 55`,
while the same response's `counts.total` reads 55 but its named buckets still
sum to 52. Always ask for BLOCKED explicitly and trust `pagination.total`, not
a hand-sum of `counts`.

The three hidden rows, and why one of them matters more than the four stepped
BACKLOG rows above:

- **task-97554aa4 "Foundation self-host canary" — CRITICAL, order 1,
  `planStepCount: 8`, `completedStepCount: 0`.** This is a FIFTH plan-bearing
  row, it is the highest-priority row on the entire board, it holds a complete
  8-step plan, and it sits in BLOCKED where the "four stepped BACKLOG rows"
  triage list never reaches it.
- task-f146fa2e "Foundation prepare-before-launch workspace lifecycle" (HIGH,
  order 119.5, 0 steps)
- task-31ea82e7 "Production captureResult producer for the Foundation attempt
  service" (HIGH, order 120, 0 steps)

~~Triage order on respawn should put task-97554aa4 ahead~~ **RETRACTED by its
author (worker-57b745d5, 22:50Z) and RULED by the governor (22:43Z): the
canary's block premise is NOT stale — it was re-measured at HEAD 2dcb30c and
recorded as comment-eca37ae6 on the task. Sole live gap: captureResult is the
deliberate null at daemon-foundation-command.ts:64, owned by task-31ea82e7,
gated behind f146fa2e, gated behind the four unplanned producer slices
(119.1-119.4). Unblocking the canary hands a worker a plan whose step-1 resume
gate re-blocks on the first read. CORRECT RESPAWN ORDER: explicit
claim_next_task statuses:["PLANNING"], then plan 4af0e3dc → a500fef0 →
e7a40bc0 → 6109b2f4, then 2b4aa38f and remaining 0.1-series rows; the canary
unblocks itself when 31ea82e7 lands.** If a block premise ever IS re-checked:
read the blocked reason BEFORE clearing it — `moe.unblock_worker` WIPES it
(`mem:unblock-worker-wipes-the-task-blocked-reason`), and block conditions go
stale silently (`mem:moe-block-conditions-go-stale-silently`).

Also unlisted in any census: 4 of the 9 PLANNING rows are epic-bd387eeb orders
119.1-119.4 (daemon host repository/scope catalog, detached per-attempt Git
worktree materializer, bounded workspace delta capture, durable prelaunch
capture context), all `planStepCount: 0`.

Roster at 22:42Z and again at 22:48Z after a fifth dry
`wait_for_task(WORKING, 300000ms)`: 7 rows, `alive: 7`, `stale: 0`, all on
`team-f2178c1f...`, still zero architect. Deadlock unchanged.

## 2026-08-19: the prescription WORKED, then the deadlock RECURRED one link later

The "CORRECT RESPAWN ORDER" above was executed overnight and it is validated —
do not treat it as untested advice. By 10:13Z on 2026-08-19 every task it named
is DONE: 4af0e3dc, a500fef0, e7a40bc0, 6109b2f4, 2b4aa38f, plus 3ac5c237. The
0.1 ship epic (epic-fbe4fc13) is complete. `done` went 314 -> 323.

Then the SAME deadlock reformed at the next link in the chain. Measured by
worker-a211f4b4 across two dry `wait_for_task(WORKING, 300000ms)` calls,
10:14Z-10:24Z, both `hasNext:false, timedOut:true`:

- Disk scan of `.moe/tasks/*.json`: 43 BACKLOG / 323 DONE / 23 ARCHIVED /
  2 BLOCKED / **1 PLANNING / 0 WORKING / 0 REVIEW**.
- `list_workers`: 7 rows — 5 workers + qa-bbdecc14 (all alive, all IDLE) +
  governor-f4cdc6ee. **Zero architect rows again.**
- The single PLANNING row, task-f146fa2e "Foundation prepare-before-launch
  workspace lifecycle" (HIGH, epic-bd387eeb), is unassigned with
  `implementationPlan: []` — 0 steps. It flipped BLOCKED -> PLANNING at
  10:04:54Z and no architect has ever touched it.

So the shape of the endgame is: each time the fleet drains its planned work, the
architect lane empties and the board freezes on the next unplanned row. Finishing
the prescribed batch does not end the deadlock class, it just advances it.

### ~~CORRECTION~~ RETRACTED BY GOVERNOR (10:27Z) — this section inverted the timeline

The claim below reads the a42ae2f-anchored blockedReason as a NEWER re-measure.
It is the OLDER text: a42ae2f is 127+ commits behind HEAD, and the reason field
is never rewritten on this board — comments supersede it
(`mem:blocked-reason-is-superseded-by-comments-newest-first` in the governor's
memory; same rule recorded on the task itself). The CURRENT premise is
comment-8fc650da on task-97554aa4 (10:12Z, HEAD 19f7d9b, double-verified by
git-grep at HEAD blobs): **Gap E is DEAD** (agent-wrapper-main.ts:285 wires
createVerifierAuthorityProvider; owner task-4dd4424c DONE 8/8), Gap A is 4/5
stale via renames (createFoundationClaudeLauncher → createFoundationLauncherAuthority,
launchClaudeWithTelemetry → launchActivationProviderRun), and the SOLE live
clause is captureResult null (owner task-31ea82e7). "Sole live gap" stands.
The original two-clause text is kept below only as the record of the error:

- **Gap A** — pinned Claude launch has zero production host caller.
  `createFoundationAttemptService` (work/foundation-attempt-service.ts:97) has 0
  production callers; its `captureResult` port (:41) has 0 production
  implementations; the real spawn path is agent-wrapper-main.ts:256
  `claudeSpawnStarter` -> agent-spawner.ts:352 `spawnRuntime`, raw
  `node:child_process`, no `@moe/runner`, no pin. Owner: task-a9fd91c3.
- **Gap E** — host verifier hard-wired to refuse. agent-wrapper-main.ts:240
  `verificationAuthority: () => null`; `VerifierAuthorityFacts` has ZERO
  producers, so node-verifier.ts:165-172 yields
  `VERIFICATION_AUTHORITY_UNAVAILABLE` for every node and records no receipt.
  Defeats the task's DoD 3. Owner: task-4dd4424c.

Five other prerequisites are recorded CLOSED and one DESCOPED. Practical lesson,
and it generalizes past this task: a blocked reason that gets re-measured is not
"stale vs current" — it is a *different premise* with a different clause count.
Re-read it in full and count the clauses each time
(`mem:count-the-clauses-in-a-block-premise`); do not diff it against your memory
of the last reading. The anchor is the SHA named in the prose (a42ae2f here),
never the reason's timestamp
(`mem:blocked-reason-timestamp-hides-measurement-anchor`).

task-31ea82e7 (HIGH, BLOCKED, 0 steps) still gates on f146fa2e being DONE *and*
its committed captureRef/workspace consumer edge being re-measured — so the
chain f146fa2e -> 31ea82e7 -> 97554aa4 is intact, just shorter than in the
2026-08-18 reading.

### RESOLVED 2026-08-19 10:34:51Z — the recurrence closed, and how it looked

Recorded by worker-bb4011b8 so this file stops ending mid-incident. The
2026-08-19 recurrence lasted ~30 minutes (10:04:54Z flip to PLANNING ->
10:34:51Z claim) and ended exactly as predicted: human-side architect respawn,
nothing in-band.

The transition, verified two ways rather than adopted from a peer's report:
- `.moe/tasks/task-f146fa2e*.json`: `assignedWorkerId: architect-2bd00363`,
  updatedAt 10:34:51.549Z, still `implementationPlan: []` at that instant.
- `list_workers`: **EIGHT rows** where every census that day returned seven —
  architect-2bd00363, `status: READING_CONTEXT`, `currentTaskId` set,
  `isAlive: true`. Row-count change is the cheapest deadlock-broken signal;
  watch `total` in the summary.

By 10:48Z f146fa2e was WORKING with 8 steps, held by worker-1d896f28, and
PLANNING was empty. Chain f146fa2e -> 31ea82e7 -> 97554aa4 is moving again.

Three things a waiting worker should know from the ending:

1. **The architect respawns with `teamId: null`**, not on team-f2178c1f. Same
   split shape as the governor's, and per the section below it heals. Do not
   escalate it on sight.
2. **A fresh architect reads `secondsSinceLastActivity: 170` in
   `READING_CONTEXT`.** That is long-tool-call silence, identical to the parked-
   governor artifact — do not read it as a stalled respawn and do not release it.
3. **Expect to LOSE the race for the first WORKING row.** Five workers were
   parked on `wait_for_task(WORKING)`; the row appeared and
   `claim_next_task` returned
   `[NOT_ALLOWED] ... already assigned to worker-1d896f28. Pass
   replaceExisting:true to take over.` That message is not an invitation:
   `replaceExisting` on a live peer's freshly claimed task is theft, not
   recovery (`mem:wrapper-can-dispatch-an-already-claimed-task`). Stand down and
   re-enter the wait. With N idle workers and one unplanned row, N-1 sessions
   correctly get nothing — that is the queue working, not a defect worth a
   message.

### Anti-pattern: five idle workers each file the SAME census

Between 09:59Z and 10:24Z, four workers independently posted near-identical
board censuses to chan-ced99359, plus four separate receipts discharging one
stale governor @mention. The governor had to spend a message suppressing it:

> "Governor consolidation, 10:14Z — CENSUSES END ... Workers/QA: nothing in-band
> produces work — hold one cycle or sign off cleanly; no further receipts on the
> discharged 09:22Z mention needed (four received, all correct). The single
> remedy is human-side: one architect respawn opening with
> `claim_next_task statuses:["PLANNING"]`. Escalated; I hold the watch."

This is structural, not carelessness: every worker's wrapper pre-flight orders
`wait_for_task` first, each times out dry, and each correctly concludes it should
report rather than idle silently. The result is N copies of one finding.

Before composing a census, **grep the channel jsonl tail for the last few
messages** (`tail -6 .moe/messages/<channel>.jsonl`) and check whether a peer or
the governor already filed it. Post only the delta you can prove is new — and if
the governor has already consolidated, post nothing and end the session. A
census that repeats a ruling is worse than silence: it buries the ruling.

Empty-routing confirmed again, and now with a same-session A/B: worker-a211f4b4
sent two messages six minutes apart, both opening `@governor-f4cdc6ee`. The
10:13:47Z one returned `routingTargets: ["governor-f4cdc6ee"]`; the 10:19:41Z one
returned `routingTargets: []`. Identical mention text, identical live roster.
Routing depends only on whether that session is parked on a receive at send time
— nothing about the mention or the roster predicts it.

### AMENDMENT (2026-08-19, HEAD 19f7d9b): the two-clause premise is back down to ONE

The "two clauses, not one" reading directly above is anchored to the a42ae2f
blockedReason and is now STALE. Governor ruled at 10:26:53Z (msg-21d36f811fcf)
and the current premise lives in **comment-8fc650da on task-97554aa4 (10:12Z)**,
not in `blockedReason`. Re-verified independently at HEAD 19f7d9b:

- **Gap E — DEAD.** `agent-wrapper-main.ts:13` imports
  `createVerifierAuthorityProvider` from `../review/verifier-authority-provider.js`
  and `:285` passes it as `verificationAuthority:`. The `() => null` at the old
  `:240` is gone. Owner task-4dd4424c is DONE.
- **Gap A — DEAD as written.** Its clause was "`createFoundationAttemptService`
  has 0 production callers". At HEAD `daemon-foundation-command.ts:93` calls it
  in production. Owner task-a9fd91c3 is still BACKLOG, so the *task* is open, but
  the *clause the block premise names* is closed — grade the clause, not the row.
- **Sole live clause:** `captureResult` is still the deliberate stub
  `const captureResult = (): null => null;` at `daemon-foundation-command.ts:64`
  (comment at :58 says so explicitly), passed into the service at :93. Owner
  task-31ea82e7 (BLOCKED), gated behind task-f146fa2e (PLANNING, 0 steps).

Lesson on top of the clause-counting one: when a premise is re-measured, the
*newest* record may be a task COMMENT, not the blockedReason — read comments
newest-first (`mem:blocked-reason-is-superseded-by-comments-newest-first`)
BEFORE re-counting clauses, or you re-derive a premise two revisions old.

### SECOND recurrence same day, 11:04Z-11:21Z — the architect row lasted ~30 min

worker-a211f4b4, fresh session. The 10:34Z respawn (architect-2bd00363) planned
task-f146fa2e and then left. By 11:20Z the roster is back to SEVEN rows with
zero architects, and the board has drained one link further:

- Disk scan of all 392 `.moe/tasks/*.json`: 43 BACKLOG / 323 DONE / 23 ARCHIVED
  / 2 BLOCKED / **1 WORKING / 0 PLANNING / 0 REVIEW**.
- Only WORKING row is task-f146fa2e, held by worker-1d896f28 (`CODING`, alive).
  So the chain f146fa2e -> 31ea82e7 -> 97554aa4 is advancing on its first link
  and the other 4 workers + qa have literally nothing reachable.
- Refusal measured three ways in ~16 min, none chat-short-circuited:
  `wait_for_task(WORKING, 300000)` timedOut; `claim_next_task(WORKING)` ->
  `hasNext:false` "No claimable task right now"; `wait_for_task(WORKING, 600000)`
  timedOut. Interleaving the claim between two waits is the cheap way to get an
  UNPROMPTED refusal rather than a poll you cannot trust
  (`mem:wait-for-task-short-circuits-on-chat`).

Pattern statement, now that it has repeated within one day: **the architect row
is ephemeral by design — it appears, plans exactly the rows that are ready, and
exits.** Steady state for this fleet is 0 PLANNING + 0 architect rows, so
"no architect in `list_workers`" is NOT by itself an incident. It is only an
incident when a *plannable* row exists at the same time (BACKLOG or BLOCKED rows
with cleared premises and no PLANNING row in flight). Check for a plannable row
before escalating; otherwise the fleet is simply serialized behind one worker.

Also: `counts` from a disk scan is the honest total here — 43+323+23+2+1 = 392 =
every file — whereas `list_tasks` counts stay filter-scoped and still omit
BLOCKED (`mem:moe-counts-object-omits-blocked-entirely`).

Anti-pattern check before you post: the governor's 10:14Z "CENSUSES END" ruling
was ~66 min stale by 11:20Z and the board had changed state twice since (respawn,
then drain), so a delta census was defensible. A ruling suppresses *repeats*, not
*state changes* — but quote the state change explicitly or it reads as a repeat.

### 2026-08-19 14:21Z-14:45Z — THIS ONE IS NOT THE DEADLOCK. Apply the plannable-row test and stand down.

Measured by worker-1d896f28. Symptom is byte-identical to every census above —
two consecutive dry `wait_for_task(WORKING, 600000ms)` (14:21Z-14:32Z,
14:32Z-14:42Z, both `hasNext:false, timedOut:true`, no chat short-circuit), zero
claimable rows for any role. **The cause is completely different, and reading it
as the deadlock would escalate for an architect that has nothing to do.**

Full disk scan of `.moe/tasks/*.json` (392 files, so the totals are honest —
`list_tasks` counts stay filter-scoped and omit BLOCKED):
`325 DONE / 43 BACKLOG / 23 ARCHIVED / 1 BLOCKED / 0 WORKING / 0 PLANNING /
0 REVIEW`. `done` advanced 323 -> 325 and BLOCKED fell 2 -> 1: the chain
f146fa2e -> 31ea82e7 -> 97554aa4 discharged its first TWO links overnight-to-midday.

- **task-f146fa2e is DONE**, 8/8 steps, verification exit 0 recorded 12:51:22Z
  (daemon typecheck 0; daemon test 160 files / 3495 tests; runner test 71 files
  / 2575 passed + 1 skipped; `DAEMON_TC=0 DAEMON_TEST=0 RUNNER_TEST=0`).
- **task-31ea82e7 is DONE**, landed at commit f19486d.
- Sole non-terminal row on the whole board: **task-97554aa4** (Foundation
  self-host canary, CRITICAL), BLOCKED, assignee worker-bb4011b8.

APPLY THIS FILE'S OWN TEST — "no architect is an incident only when a *plannable*
row exists". Measured, not assumed: **all 43 BACKLOG rows carry park markers
(reopenReason / v0.2 / scope-freeze); ZERO are plain unplanned rows.** The 4
stepped ones are exactly the four this file already names (225d25f7 1/5,
4d715e90 0/6, 9a1eb61d 3/11, a9fd91c3 2/7), all park-marked, and the governor's
22:34Z/22:44Z ruling DECLINED status-moving them. So there is no plannable row,
therefore no architect gap, therefore **nothing to escalate**. An architect
respawn here would open `claim_next_task statuses:["PLANNING"]` and get nothing.

WHY THE LAST ROW CANNOT BE CLEARED BY ANY AGENT. The canary's block is
OPERATIONAL, not a code gap, and its premise did NOT go stale despite two
landings that looked like they should retire it. Re-measured this session:
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_BASE_URL` are ALL unset, and there is no `.env` at repo root. Step 1's
resume gate already PASSED (all 7 capabilities host-reachable at HEAD f19486d),
so the code side is finished; what remains is that `claude -p --bare "say OK"`
exits 1 `"Not logged in"` while plain `claude -p "say OK"` exits 0, because bare
mode reads no keychain. Production already fails closed on exactly this
(moe-up-env.ts:114-119). Every agent-side path around it — dropping --bare,
injecting a fake key, mocking the child, env-gated skip — is the mock-backed
journey global rail Clause 2 forbids, and would retire `--bare`'s first live
proof with a tautology. Unblock condition is one operator-supplied
ANTHROPIC_API_KEY. **Leave it blocked.**

So the new terminal shape to recognize, distinct from the deadlock:
`0 claimable everywhere + every BACKLOG row park-marked + the only live row
BLOCKED on a human action` = the epic is FINISHED modulo a credential, not
dammed. Discriminator is one disk scan of BACKLOG for park markers — if the
count of plain unplanned rows is 0, do not escalate for an architect, do not
self-promote, post one delta census if the board state changed since the last
one, and end the session.

Empty routing held again and is now attested at full fleet-idle: BOTH sends this
session returned `routingTargets: []` — a direct `@qa-bbdecc14` reply and an
`@all` census. Consistent with this file's rule that routing reflects who is
parked on a receive at send time, and at this point nobody is. Write the census
for the later human reader.

#### AMENDMENT 14:43:31Z — that "sole live row BLOCKED" clause is STALE; BLOCKED is 0 and the canary is WORKING

Measured by worker-6abf6bd7 at 14:45Z. The section above is correct as taken and
wrong as read: the canary did NOT stay blocked. Two system messages in
chan-ced99359, both ~57s BEFORE 1d896f28's 14:44:34Z "board is FINISHED, signing
off" send:

- 14:43:31.487Z `Task moved to WORKING by worker-bb4011b8`
- 14:43:37.777Z `worker-bb4011b8 claimed task: Foundation self-host canary`

Current state, daemon and disk agreeing (the cross-check that matters, since
either alone can mislead): `list_tasks` unfiltered reads `inProgress: 1`, and
BLOCKED **derives to 0** (369 total − 43 backlog − 325 done − 1 inProgress − 0
planning/review/awaitingApproval) because `counts` still has no `blocked` key.
Disk scan of all 392 `.moe/tasks/*.json`: `{BACKLOG:43, DONE:325, ARCHIVED:23,
WORKING:1}` — sum exact, so WORKING/PLANNING/REVIEW are pinned by exhaustion,
not by a filter. Sole WORKING row: task-97554aa4, CRITICAL,
`assignedWorkerId: worker-bb4011b8`.

So the terminal shape this file names ("the only live row BLOCKED on a human
action") lasted minutes. Do not quote it without re-deriving BLOCKED yourself.

**The park-marker discriminator itself REPRODUCES independently** — that half of
the 14:21Z-14:45Z section stands, and it is the load-bearing half. Re-scanned
here with a per-marker tally rather than one OR'd regex, because "43/43 match
something" is a weaker claim than it reads: BACKLOG 43, `reopenReason` 43/43,
scope-freeze marker 43/43, park word 43/43, v0.2 41/43. **Plain unplanned rows:
0.** The 4 stepped rows reproduce exactly (225d25f7 1/5, 4d715e90 0/6,
9a1eb61d 3/11, a9fd91c3 2/7). Partition by TASK status when doing this — a naive
grep of the same files also surfaces PENDING/IN_PROGRESS *step* statuses and
inflates the count.

**Unblocking clears the claim, not the gate** (`mem:unblock-clears-claims-not-the-gate`).
A BLOCKED→WORKING move proves an agent took the row, nothing about the premise.
In THIS session all four credential variables are still unset with no `.env` at
root, unchanged — but env is per-process, so it says nothing about the session
bb4011b8 launched into. Either an operator supplied a key there or step 3 walls
again at the same place. Not knowable from another session; ask in-channel
rather than inferring either way.

RESOLVED 15:05:44Z — it walled again, and the ROOT CAUSE IS PROCESS AGE, not a
missing operator keystroke. The canary re-BLOCKED at step 3 (worker-bb4011b8,
`status: BLOCKED`, still alive and holding). BLOCKED re-derives to 1,
`inProgress` back to 0. So the WORKING window lasted ~22 min and bought a real
step: `completedStepCount` 1 -> 2, step 2 landed at commit **a675772**. A reopen
that ends in a re-block is not necessarily a wasted cycle — grade the step delta,
not the column.

Measured by worker-bb4011b8/57b745d5 with a positive control, which is what makes
it conclusive: `claude -p --bare "say OK"` EXIT 1 "Not logged in", `claude -p
"say OK"` EXIT 0, `--bare` again EXIT 1 — same binary, same cwd, 16s apart,
order-independent. Binary and machine are fine. The wrapper loop is PowerShell
**pid 65112, started 2026-08-18T18:47:32Z** — a live process's environment block
is fixed at creation, so a `$env:` set typed into a REPL today cannot enter it,
and `ANTHROPIC_API_KEY` is absent at Process, User AND Machine scope (probed
`${VAR+x}`, so unset is distinguished from empty). `moe-agent.ps1` matches
ANTHROPIC / API_KEY / OAUTH / .env / keychain **zero** times across 2702 lines:
credentials reach a session only by inheritance from the launching shell.

**The unblock is TWO actions and (a) alone reproduces today exactly:**
(a) export `ANTHROPIC_API_KEY` in the shell that launches `moe-agent.ps1`, or set
it User-scope; AND (b) restart wrapper loop pid 65112 **and** host terminal pid
2932. Verify from a NEW session: `claude -p --bare "say OK"` exits 0. Reopening
the row without (b) hands the next worker the same wall — that is literally what
happened here. Governor accepted this at 15:06:14Z and is relaying both verbatim.

**Do NOT let this become a second operator ask for an architect.** worker-57b745d5
paired the credential ask with "43 BACKLOG rows cannot reach PLANNING without an
architect". True clause, invalid conclusion: none of the 43 is *waiting* on one —
all are park-marked and the governor DECLINED status-moving them. A respawned
architect claims nothing. A second ask that cannot produce a claimable row
competes for operator attention with the one that can. Send the credential ask
alone and unqualified.

Third and fourth consecutive dry `wait_for_task(WORKING, 600000ms)` here,
14:45Z-15:05Z, both
`hasNext:false, timedOut:true` — correct behaviour, not a defect: the one live
row is claimed, and `replaceExisting` onto a live peer is theft, not recovery.
With N idle workers and one claimed row, N−1 sessions get nothing.

Also: a routed @mention can arrive stamped `MOE_MENTION_CONTENT_DIVERGED` while
being byte-faithful. Verified rather than assumed — the stored log line for
msg-34c768ab in `.moe/messages/<channel>.jsonl` is a single record, sender
qa-bbdecc14, ts 10:48:57.784Z, content length 3048, first and last 300 chars
identical to the delivered body. The flag is not self-certifying; confirm
against the jsonl before retracting anything on its authority.

## 2026-08-30 03:07Z — NEW VARIANT: `inProgress: 2` and STILL zero claimable

Every signature in this file so far pairs the dry wait with `inProgress: 0`.
This one does not, and that is the whole point: measured by worker-e98a7edb at
HEAD b8dd739a after two dry `wait_for_task(WORKING)` (300s then 600s, both
`hasNext:false, timedOut:true`), `list_tasks` reported **`inProgress: 2`** while
no worker could claim anything. Applying the older tests here concludes "two
peers are working, stand down" — wrong; nobody held either row.

**Discriminator: read `assignedWorkerId` and `dependsOnUnmet`, not `counts`.**
Both WORKING rows carried `assignedWorkerId: null, hasWorker: false` plus a
non-zero `dependsOnUnmet`. A WORKING row with an unmet dependency is
*dependency-refused*, not seat-held: it inflates `inProgress` and is invisible
to `wait_for_task`. `hasWorker: false` on a WORKING row is the tell.

The whole board was 7 non-terminal rows and the fan-in had a single root:

```
be80cb74 BLOCKED, blockedOnTaskIds: null      <- ROOT
  -> f42d5165 WORKING CRITICAL dependsOnUnmet:1   (be80cb74 only)
  -> c289b8fb WORKING          dependsOnUnmet:2   (be80cb74 + f42d5165;
                                                   its other 12 deps DONE)
       -> e60b874b BLOCKED, blockedOnTaskIds:[c289b8fb, ...]  (auto-unblocks)
```

**`blockedOnTaskIds: null` is the load-bearing field.** A row blocked with an
id list auto-unblocks when those go DONE; a row blocked with `null` never does,
no matter how much of the board drains around it. Cheap sweep worth running the
moment a wait goes dry twice — scan every non-terminal task JSON, collect
`dependsOn`, and print which non-terminal rows depend on each; a root with
non-empty fan-in and `blockedOnTaskIds: null` is the only thing you need to
report. Here exactly one row had non-terminal dependents.

**Re-measure the root's premise before proposing it be cleared, and expect it to
hold.** be80cb74's reason was anchored at 547c6c55, nine commits behind HEAD, so
it looked stale on age alone. Its load-bearing clause was quotable and still
true verbatim at HEAD: `budgetRef: hex64("bb")` at
`apps/control-room/src/live/live-dispatch-payloads.ts:218`. Age is not staleness
(`mem:blocked-reason-timestamp-hides-measurement-anchor`); grade the clause.

The remedy was also not "unblock it" — the reason named a prerequisite that
exists in no status. Sweep every task JSON by title keyword before claiming a
prerequisite is missing: here `task-61a2e8ad` (pre-budget-1) was DONE and
`task-e6ed8bf1` was an ARCHIVED near-duplicate of it, either of which could be
mistaken for the missing row. Neither was.

Two verbs were owed, by two seats, neither a worker's: someone with filing
authority creates the prerequisite and sets it as be80cb74's dependency (which
converts a dead `null` block into an auto-unblocking one), and an architect seat
gets spawned — `list_workers` showed 2 qa + 3 workers + 1 governor and **zero
architects** against 2 PLANNING rows. Note this passes the plannable-row test
this file established: plannable rows existed, so the architect gap was a real
incident, unlike the 14:21Z case above.

Empty routing reproduced twice more, both sends this session
(`routingTargets: []`) despite naming live agents explicitly — consistent with
the parked-on-a-receive rule. Write for the later human reader.

### AMENDMENT 03:09Z (worker-39362c3a, same HEAD b8dd739a) — the root has ZERO unmet deps, and that changes the remedy

Re-derived the whole fan-in from all 654 task files rather than from the board's
`dependsOnUnmet` field. The chain above reproduces, with one correction that
inverts what the fix verb has to be:

```
BLOCKED   task-be80cb7441d6483  unmet 0   dependsOn: [task-3b61860f...] which is DONE
WORKING   task-f42d5165b747436  unmet 1   be80cb74:BLOCKED
WORKING   task-c289b8fbcb98409  unmet 2   be80cb74:BLOCKED, f42d5165:WORKING
```

**A `blockedOnTaskIds: null` root can still carry a non-empty `dependsOn`, and
here every entry of it is DONE.** So the root is not dependency-refused at all —
it is a pure stored-status block with nothing outstanding for the daemon to
satisfy. Consequence, and it is the practically important one: **filing the
named prerequisite row does not by itself arm any auto-unblock.** The section
above says the filing verb "converts a dead `null` block into an auto-unblocking
one" — it does not, unless the new row is *also* written into the root's
`dependsOn` (`set_task_dependencies`). Filing alone leaves the board exactly
where it was. Read `dependsOn` and resolve each id's status yourself; a root's
unmet count is not implied by its BLOCKED column.

**Grade the load-bearing clause, not the quotable one.** The premise's quotable
half is the `hex64("bb")` literal — that is DoD item 4's *symptom*. The clause
that would actually go stale is the sentence before it: "daemon
HTTP/affordance/planning-run/event surfaces expose no commitment or enough
durable material". Worth checking here because 89533c6c landed a *new daemon
HTTP read route* inside the nine-commit window. It did not touch this. At HEAD:
`git grep -ln budgetCommitmentDigest HEAD` -> 9 source files, all under
`apps/daemon/src/{budget,planning,bootstrap}` plus their `.test.ts`, **zero under
`apps/daemon/src/http`**; `git grep -n budget HEAD -- apps/daemon/src/http` hits
only `.test.ts`, a `budgetAccountRef` goal field in `goal-catalog-entry.ts`, and
the word "budget" in a `static-asset-host.ts` comment; `fixtureBudgetCommitmentFor`
exists only in `.test.ts`. Premise holds on both halves. General form: when a
block premise has a cheap quotable clause and an expensive structural one, a
commit landing in the window is far likelier to retire the structural one — check
that first, and name which clause you checked.

**Governor liveness: re-sample before reporting it stale.** The section above
records the governor at "stale 343s". Thirty seconds later `list_workers` read
`isAlive: true, secondsSinceLastActivity: 45`. That is the parked-on-`chat_wait`
artifact this file already documents, recurring — a governor is a long-poller and
its presence row oscillates. The cross-team reading was correct and current
(governor on `team-e6831a9f...`, the five of us on `team-f2178c1f...`), so verb
#1 has a live, reachable, cross-team addressee. Do not write the governor off
from one sample.

Zero-architect finding, the 2 PLANNING rows (both `unmet 0`), and empty routing
all reproduce unchanged — a third `chat_send` naming live agents explicitly
returned `routingTargets: []`.

### AMENDMENT 04:08Z (worker-d9877466, HEAD b8dd739a) — the GOVERNOR row is now gone too, so BOTH owed verbs lost their addressee

The 03:09Z amendment closes by confirming "verb #1 has a live, reachable,
cross-team addressee". **That is no longer true.** `list_workers` sampled twice,
04:07:19Z and 04:08:15Z, identical both times: `total: 5, alive: 5, stale: 0` —
2 qa + 3 workers, **no governor row and no architect row**, all five
`team-f2178c1f...`, all `IDLE`, all `currentTaskId: null`. The
`team-e6831a9f...` row that carried governor-0134a004 an hour earlier is absent.

Apply this file's own discriminator and do not re-derive the parked-long-poller
artifact here: that artifact produces a row with a STALE TIMESTAMP, never an
ABSENT ROW. Two samples a minute apart both show absence, which is a departed
session. So the fleet now owes two verbs — file the prerequisite + write it into
`be80cb74.dependsOn`, and spawn an architect — and has **zero seats authorized to
perform either**. Five alive agents, every one of them structurally unable to
move the board. Escalation is human-side and singular.

**Correction to the remedy as I first sent it in-channel:** I described verb #1
as "file the missing row", which is the same under-specification the 03:09Z
amendment already warns about one screen up. Filing alone arms nothing. It is
TWO writes — `create_task` for the prerequisite, then `set_task_dependencies`
putting its id into `task-be80cb74`'s `dependsOn` — because that root's block is
a pure stored-status block (`blockedOnTaskIds: null`, `dependsOn` all-DONE,
`unmet 0`). This is the fifth-ish time this shape has been mis-stated on this
board; the memory `mem:dependson-satisfied-does-not-unblock-a-manual-block` is
the canonical statement and it is worth reading BEFORE composing the ask, not
after.

**I also tripped the file's own anti-pattern and it is worth recording as a
recurrence, not an apology.** Two peers filed materially this same census at
03:07Z and 03:09Z; I re-derived and re-sent it at 04:07Z without tailing
`.moe/messages/<channel>.jsonl` first. The rule "grep the channel jsonl tail
before composing a census, post only the provable delta" is stated twice above
and still lost — because each worker's wrapper pre-flight independently orders
`wait_for_task` first, every seat times out dry, and each correctly concludes it
should report. The structural fix is not "try harder": **make the tail-check the
literal first command after a second dry wait**, before any `list_tasks` /
`list_workers` call, since those calls are what seduce you into writing the
census you are about to duplicate.

What WAS a real delta this session, for the record: the governor's departure
above, and independent re-confirmation of the be80cb74 premise from the WORKTREE
(the 03:09Z peer used `git grep` at HEAD; I used a plain worktree grep plus the
full production import closure of `budget-commitment.js` — 7 files, all
store-side, zero HTTP handlers). Two different measurement methods, same verdict:
premise holds. Also worth pinning because it inverts on a casual read —
`grep -n budgetRef apps/daemon/src/http/affordance-read.ts` returns NOTHING,
while the same grep across `apps/daemon/src/http/` returns four hits, ALL in
`.test.ts` siblings obtaining the value via `fixtureBudgetCommitmentFor(store, …)`
(`bootstrap-test-fixtures.ts:576`, store is arg 1). A test whose payload carries
a commitment is not a route producing one. Anyone grepping the directory rather
than the route file concludes the surface exists and wrongly closes the row.

Second inversion trap in the same premise: `bootstrap-test-fixtures.ts:532` and
`approval-activation.test.ts:349` both carry prose stating the `hex64("bb")`
placeholder was retired and "became the DERIVED" value. That migration reached
the FIXTURE path only — the literal still ships at
`live-dispatch-payloads.ts:218` AND `demo-seed-payloads.ts:286` (two sites, not
the one the premise names). Read the prose first and you close the row on the
strength of a comment describing a different code path.

#### Hold evidence 04:22Z (worker-d9877466, same session, HEAD unmoved at b8dd739a)

Third dry `wait_for_task(WORKING, 600000ms)` spanning 04:11Z-04:21Z:
`hasNext:false, timedOut:true`. `list_workers` immediately after, 04:22:04Z:
`total: 5, alive: 5, stale: 0`, all `team-f2178c1f...`, all `IDLE`,
`currentTaskId: null` — **still zero governor row and zero architect row**, a
third sample 14 minutes after the two that established the absence. Board counts
unchanged from the 03:07Z census: `backlog 1, planning 2, inProgress 2,
review 0, done 601`. Total observed dry hold across the three seats tonight is
now ~75 minutes.

Nothing to add and nothing to do: the delta census was already filed by two
peers, both owed verbs still have no addressee, and a fourth wait cannot change
that. Correct terminal move for a worker arriving here is the one this file
already prescribes — tail the channel jsonl, confirm the census exists, add only
a provable delta, end the session. Do NOT open a fresh 600s wait to look busy.

One cheap falsification worth carrying, because it kills a plausible-sounding
repair of the routing rule: a `chat_send` opening with `@worker-e98a7edb` — a
REGISTERED seat reading `isAlive: true, secondsSinceLastActivity: 50` in a
`list_workers` call seconds earlier — still returned `routingTargets: []`. So
the tempting explanation "empty routing just means the mention named an
unregistered role like `@architect`" is FALSE. It is the parked-on-a-receive
behaviour that `mem:gotcha-chat-send-succeeds-while-routing-to-nobody` records,
and that memory's standing verdict holds: `routingTargets` is unreliable in both
directions, and channel-backlog reads are the delivery you can rely on.
