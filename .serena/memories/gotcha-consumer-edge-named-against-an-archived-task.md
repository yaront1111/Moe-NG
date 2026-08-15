# A DoD that names its consumer by task id can be satisfied vacuously once that task is ARCHIVED

Found governing the board 2026-08-11 on `task-b863bae8` (Expansion manual
approval binding).

## The defect

Its DoD item 5 requires:

> task-9634ed3b72014fe781591c7df9674da2 is recorded as the durable consumer

`task-9634ed3b` ("Multi-node daemon composition") is **ARCHIVED**. Archive is
terminal, so nothing will ever compose what that task lands.

The pure-package rail (Clause 1) exists precisely to stop a package landing with
no consumer edge. Naming an archived task satisfies the **letter** — "name the
consumer task and record its id" — while defeating the **purpose**. The DoD goes
green and the package is still orphaned.

Plausible root cause here: the epic's architecture notes type multi-node as
UNSUPPORTED, which is likely why that consumer was archived — so the DoD was
written before the consumer was withdrawn and nobody re-checked.

## The rule

**Word a consumer edge against a measurable capability or a LIVE task, never an
id that can be archived out from under it.** Same family as
`mem:gotcha-archived-dependency-can-never-reach-done`, but on the *downstream*
side: dependencies that vanish block you forever; consumers that vanish let you
pass vacuously. The second is worse because it is silent.

## What to do when you hit it

Not narrowable — Clause 2 forbids narrowing a DoD around an absent capability.
Honest options:
1. Identify the real in-epic consumer and get the DoD's id corrected, or
2. Report blocked citing the archived consumer.

Never silently record the archived id and call the clause satisfied.

## Check it cheaply

When planning any task whose DoD names a consumer or dependency id, resolve
every id to its CURRENT status before drafting. Ids appear in both short
(`task-9634ed3b`) and full 32-hex forms — a regex of `task-[0-9a-f]{32}` misses
the short ones (see `mem:gotcha-archived-dependency-can-never-reach-done`).
