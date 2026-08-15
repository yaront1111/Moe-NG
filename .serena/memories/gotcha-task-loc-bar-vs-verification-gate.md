# Gotcha: the 400-net-LOC task bar conflicts with the per-task verification gate

Observed twice on 2026-08-07, both rejected by QA as OVERSIZED, neither a defect:

- `bcdc2f6` planning graph lifecycle core — +3116 net LOC / 13 files
- `37b11e5` Streamable HTTP adapter — +2013 net LOC / 7 files

## Root cause

Each task names a verification command that must exit 0 for the task alone
(`pnpm --filter @moe/core test`, `pnpm --filter @moe/mcp test`). That forces every
slice to typecheck and test as a self-contained unit. A reducer without its contract
does not compile; an adapter without its transport wiring has nothing to test.
So the smallest *shippable* slice for aggregate- and adapter-shaped work is already
well over 400 net LOC. The bar and the gate disagree; the code is not the problem.

Confirmed not rescuable by finer slicing: on `37b11e5` the natural seams are real and
documented in-code (`http-session.ts` "depends on @moe/contracts and nothing else",
`http-resume.ts` "deliberately self-contained"), yet a 4-way carve still leaves most
buckets over 400. Same finding was reported on the core side in the
`task-1ade51c0…-handoff` prior-attempt note.

## What this costs

The remedy is never worker-side. Reverting destroys verified work and breaches the
preserve-work rail; a landed commit's LOC cannot be un-counted. So it escalates to
architect re-scope or human governance every time — `prop-2eaa632d` was approved as a
ONE-TIME historical exception for `bcdc2f6` only, explicitly not extensible.

## How to avoid it

Choose the seam **before** code exists. Plan aggregate/adapter work as pre-split
sibling tasks from the start, each with its own gate. Splitting after the fact is
the expensive path, because by then the commit has landed and only governance can
clear it.

Watch for the early signal: the runtime warns at plan submission
("Plan touches N distinct files (target <=5)"). Both oversized tasks shipped past
that warning — 13 files and 7 files respectively. Treat that warning as a
size-planning trigger, not noise.

## QA note

Per-file rails (<=250 target, split before 400) are separate from the task-level LOC
bar and are NOT waived by any exception. On `37b11e5` the production files were
compliant but `http-server.test.ts` was 505 lines — worker size reports covered
production files only. Check test file sizes too.

Also: audit any claimed size exception at the source. Read
`.moe/proposals/<id>.json` and confirm `status: APPROVED` and `resolvedBy: "human"`.
An agent asserting an approval in a reopenReason is not an approval.
