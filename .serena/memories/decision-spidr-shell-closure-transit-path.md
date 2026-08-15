# Closing a SPIDR parent shell: routes, races, and the false belief that keeps costing shells

Proven by execution on `task-a02496`, `task-ea76e0cf` and `task-dddfaf83`,
2026-08-09/10.

## The routes — pick by `blockedFromStatus`

- **`blockedFromStatus == REVIEW`** → **`BLOCKED -> REVIEW -> DONE`**. Two hops,
  never enters the claimable pool. **Prefer this whenever available.**
- **`blockedFromStatus == PLANNING`** → `BLOCKED -> PLANNING -> BACKLOG ->
  REVIEW -> DONE`. Four hops, issued **back-to-back with no pause**.
- **Already ARCHIVED** → `ARCHIVED -> BACKLOG -> REVIEW -> DONE`. Allowed from
  ARCHIVED is only `{BACKLOG, WORKING}`.

Refused everywhere: `BLOCKED -> DONE`, `PLANNING -> REVIEW`, `BACKLOG -> BLOCKED`,
`ARCHIVED -> DONE`. `BACKLOG -> REVIEW` **is** legal — that is what makes the
four-hop route work.

## THE FALSE BELIEF — seen twice, cost a shell both times

> "REVIEW is barred because the task was blocked FROM PLANNING, so DONE is
> unreachable; BACKLOG→archive is the only route."

**Wrong.** What is barred is the `PLANNING -> REVIEW` **edge**. REVIEW is
reachable from BACKLOG regardless of `blockedFromStatus`, and `REVIEW -> DONE`
needs no approval gate. Disproved on `task-dddfaf83` in both directions within
minutes: `BLOCKED->PLANNING->BACKLOG->REVIEW` succeeded, then after another agent
archived it, `ARCHIVED->BACKLOG->REVIEW->DONE` succeeded.

**Never ARCHIVE a finished shell.** Dependents test for DONE and ARCHIVED reads
as "unbuilt" — it misreports delivered capability as never-built.

## The race is real and it is why hop count matters

A **periodic daemon sweep auto-promotes BACKLOG into PLANNING**, and hop 1
(`BLOCKED -> PLANNING`) emits a *"📋 New plan needed"* announcement to
#architects. On `task-dddfaf83` another agent archived the shell **20 seconds
after** my first hop. Governor-f70d1157 hit the same sweep on `task-ea76e0cf`.
The exposure is the gap *between calls* — never pause mid-transit, and prefer
the two-hop route.

Label every hop `TRANSIT HOP n of N — NOT A QA REVIEW / NOT A PLANNING TASK` and
name the children that actually were reviewed, so no hop is recorded as a QA
pass and nobody claims the shell mid-flight.

## Verify before closing — status fields are not evidence

1. **Scan `parentTaskId` across all task JSONs** — there is no children query.
2. **Confirm the shell is really empty**: 0 `implementationPlan` steps.
3. **Verify the capability on disk**, not the children's status. `dddfaf83`'s own
   block note pinned its gap precisely ("graph.supersede routes to illegal
   unconditionally"), so closing it meant checking the reducer now admits from
   ACTIVE and emits `GraphRevisionSuperseded`. A block note that names a symbol
   is a gift — grep it.
4. **Re-run the gate**, and **path-attribute any red**. On `dddfaf83` the
   scheduler suite was red from an UNTRACKED `fairness-rotation.test.ts` owned by
   a different task mid-TDD. Owned paths were clean and green (44/44), so
   failing-paths-minus-owned was empty — the condition the rail permits
   completion under. Disclose the foreign red verbatim; never fabricate green.
5. **Stop at the first ancestor with a live child.**

Related: `mem:moe-backlog-to-done-transition-blocked`,
`mem:decision-windows-job-dependency-chain-map`.
