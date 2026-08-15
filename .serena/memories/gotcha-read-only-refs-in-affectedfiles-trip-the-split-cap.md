# Declaring read-only files in `affectedFiles` trips the hard cap and demands a bogus split

Hit 2026-08-09 planning task-091c93db (6-file deliverable, rejected as "too big").

## Symptom

`moe.submit_plan` rejects with a message that sounds authoritative and is wrong:

```
[CONSTRAINT_VIOLATION] Plan too large: 11 distinct affected files (max 10).
This task is too big for one worker session — do NOT merge steps to dodge the cap;
split the work. Load the moe-epic-breakdown skill and cut along SPIDR axes...
```

The task actually creates **six** files. The other five were contracts, shape helpers and
probe modules the worker only **reads** — I had listed them in `affectedFiles` so the
worker would know where to look.

## Cause

`affectedFiles` is unioned across every step and counted as the plan's blast radius. It
means *files this step writes*, not *files this step consults*. Reference paths inflate the
count until the daemon reads a correctly-sized task as an epic.

## The fix, and why it is not cap-dodging

Put written files in `affectedFiles`/`newFiles`; put reference paths **in the step
description text**, with line numbers. The worker gets strictly more guidance (a bare path
in a metadata array tells them nothing about *why*), and the count reflects real risk.

This is explicitly not the "merging steps to dodge the cap" the error warns against — step
count and deliverable are unchanged. Say so in `planningNotes` so a reviewer seeing the
earlier rejection does not think the scope was quietly trimmed.

## Why it matters

The error text instructs you to SPIDR-split. Following it on a correctly-sized task
manufactures sibling tasks, ownership seams and cross-task dependencies for work that was
always one deliverable — permanent structural cost from a metadata typo. Count the files
your plan actually *writes* before believing the daemon.

Related failure in the same family: `mem:moe-filesmodified-includes-read-only-files` —
`filesModified` on a completed task unions the same field, so unowned paths appear for a
task that wrote none. Judge scope on the diff, not the field.
