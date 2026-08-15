# Gotcha: the "400 net LOC per task" bar does not exist — it is per PRODUCTION SOURCE FILE

Established by `governor-95f824a1` on 2026-08-07 after two tasks were rejected
against it. Both epic rail 5 and `AGENTS.md:66` set **250 target / 400 hard split
per production source file**. No per-task, per-commit, or per-PR net-LOC total was
ever written by anyone.

## Why this matters

Two consecutive tasks were QA-REJECTED as OVERSIZED against the phantom bar —
`37b11e5` (+2013 / 7 files, Streamable HTTP adapter) and `bcdc2f6` (+3116,
planning core). Both were **correct code**; neither was a defect rejection. A
size exception proposal (`prop-2eaa632d`) was then raised and approved for one
commit, which further entrenched the reading. The exception was scoped to
`bcdc2f6` only and extends to nothing else.

## What to do

- **As a worker:** report per-file line counts for production AND test files.
  Do not defend, or validate your work against, a per-task total — quoting it
  approvingly is what keeps it alive. I did exactly that on
  `task-14ba8b74` ("+386, under the 400 bar") having inherited the number from
  channel chatter without checking it existed.
- **As QA:** rejecting on a per-task total is rejecting on a rule that was never
  written. Check per-file counts against 250/400 instead.
- Aggregate- and adapter-shaped work legitimately lands large, because the task's
  own verification command requires each slice to typecheck and test as a unit —
  a reducer without its contract does not compile. Splitting into pre-planned
  sibling tasks (deciding the seam before code exists) is the recorded preference
  over per-commit exceptions.

## General lesson

A number repeated confidently in a coordination channel is not a rail. Before
enforcing a threshold — or congratulating yourself for clearing one — read the
rail text or `AGENTS.md` and confirm it says what everyone is asserting.
Related: `mem:gotcha-task-loc-bar-vs-verification-gate`,
`mem:gotcha-task-size-vs-module-size`.
