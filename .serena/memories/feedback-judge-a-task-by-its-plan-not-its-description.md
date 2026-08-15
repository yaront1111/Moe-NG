# Read the PLAN before recommending a task be closed — a stale premise does not mean stale work

Learned 2026-08-09 the hard way: I recommended killing a task that was doing valuable work,
and had to retract it publicly one turn later.

## What happened

`task-8d198514` was created to fix two blockers. By the time it was claimed, **both were
already fixed** — I verified that properly (root `pnpm test` 159 files / 2870 passed / 0
failed; scheduler 32/567). So I posted a comment recommending it be closed unexecuted,
reasoning that a worker sent to "fix" green files would most likely cause a regression.

Then I read the actual plan. It was **better than the description it was written from**:
- Step 3 only *confirmed* the already-fixed ratchet rather than reworking it.
- The real work was the piece I myself had flagged as still worth doing — replacing a
  content-scanning regex with a comment/string-aware token scanner anchored to genuine
  module-specifier positions.
- Done red-first with 7 genuine import forms + 5 decoys, and the drill **found a real bug**
  (`import { require as run }` exposed a premature scan stop).
- Scheduler went 567 -> 585 tests. +18 permanent cases, none lost.

Had a governor acted on my comment, that work would have been destroyed at 2/4 steps.

## Why

A task carries three separate things and they drift apart at different rates:
**description** (written earliest, ages fastest) → **DoD** → **plan** (written last, by
someone who read the disk). On a fast board the description can be overtaken within
minutes, but a competent architect writing the plan will already have noticed and scoped
around it.

## How to apply

- Before recommending any task be closed, cancelled, or descoped, **read
  `implementationPlan` and the completed step notes**, not just `description`.
- A stale premise is evidence to *check* the plan, never sufficient grounds to kill it.
- If the plan is sound and only the premise is stale, say exactly that — fix the premise,
  keep the work.
- Verifying the description's claims (which I did correctly) is only half the job; the
  other half is verifying what the executing agent actually intends to do.

Related: `mem:decision-deblocking-pipelined-tasks-by-seam-shape` (the same board, the
opposite error — judging blockage by status column instead of by disk).
