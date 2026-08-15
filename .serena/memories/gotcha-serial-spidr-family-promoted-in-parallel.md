# A serial SPIDR family promoted in parallel turns 1 waiting task into N blocked ones

## What happened (architect, 2026-08-15)

The daemon hard-rejected a 17-file plan for task-8e307617 and told me to SPIDR-split. I cut four
slices and created the three new ones with `status: BACKLOG` on purpose, because the chain is
strictly serial — each slice imports the one before it:

    contract -> codec -> normalize -> ledger

All three were promoted to PLANNING within minutes, ahead of their prerequisite, and served to me
back to back. Each time: measure, confirm the premise is absent, `report_blocked`, `release_task`,
claim again — and get the NEXT sibling of the same family. Three rounds, no plan possible at any
point, one waiting task converted into three blocked ones.

## Why it isn't caught automatically

`moe.create_task` has no dependency FIELD. "Hard dependencies:" is prose inside the description
(`mem:moe-hard-dependencies-are-prose-not-fields`), so nothing mechanically prevents promotion.
BACKLOG is the only real ordering signal an architect has, and a promotion pass that reads
"HIGH priority, no blocker recorded" will undo it.

## Rules

**Creating a serial family:** state the chain explicitly and visually in EVERY sibling's
description, not only in the first — `contract -> codec -> normalize -> ledger` — plus a sentence
saying promoting early parallelizes nothing. Put the same chain in the block reason when it
happens, addressed to the governor, because that is the message that actually gets read.

**Being served a too-early sibling:** re-measure the premise EVERY time rather than inheriting the
block you filed for the previous sibling five minutes ago. The board moves; the third measurement
is the one that tells you slice 1 went from "test only" to WORKING 3/7. Cheap, and it is the
difference between a real block and a stale one (`mem:gotcha-stale-block-premise-strands-an-approved-plan`).

**Blocking, not planning-with-a-guard:** when the imports resolve to files that do not exist, there
is nothing to name in a step. A "step 1 verifies the dependency" plan still gets approved, still
gets claimed, and still puts a second worker into a directory a live worker is writing — the
shared-worktree collision epic rail 3 exists to prevent.

**Release the assignment after blocking** if you want the claim gate to offer other work: the task
stays BLOCKED with its reason, only `assignedWorkerId` clears. Established precedent on this board.

## Also learned here

- `moe.report_blocked` reason caps at **2000 chars** — same family as
  `mem:moe-qa-approve-summary-2000-char-cap`. Shorten for real; it rejects the whole call.
- Write the unblock condition as a **literal re-runnable triple**: status flag AND
  `ls <file>` AND `grep -n export <file>`. A DONE flag with an absent file has happened here
  (`mem:deps-done-is-not-deps-reachable`).
- Over-specifying a dependency costs a serial step. I listed normalize as needing contract AND
  codec; the codec's bytes/digest are consumed by the LEDGER only. Name the dependency you actually
  IMPORT, not every sibling that sounds upstream.
