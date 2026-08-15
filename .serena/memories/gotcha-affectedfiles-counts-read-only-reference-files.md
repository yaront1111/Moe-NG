# A plan is rejected on files it only READS, if you list them in affectedFiles

Hit 2026-08-09 on `task-304aa63417e448a897e83a4fd08cccaa`. First `moe.submit_plan` was hard-rejected:

> `[CONSTRAINT_VIOLATION] Plan too large: 11 distinct affected files (max 10).`

The task genuinely owned **8** files. The other three came from a read-only "read these before you
name a symbol" first step, where I had helpfully listed the reference files in `affectedFiles`.
`affectedFiles` is **unioned across every step** and the union is what the cap measures — the daemon
cannot tell "I will edit this" from "I will read this".

## Fix
Give a read-only step **no `affectedFiles` at all** (the schema only requires `description`), and
name the reference paths in the step text instead. Resubmitting with the same nine steps and
accurate accounting passed at 8 files.

## Why this matters beyond the cap
The daemon's rejection message tells you to **split the task**. That advice is wrong when the
overflow is phantom — splitting a correctly-sized task because of a bookkeeping artifact creates
real coordination cost and a parent shell to close. Count the *owned* paths before believing it.

Same root cause as `mem:moe-filesmodified-includes-read-only-files`: `filesModified` on a completed
task also unions every step's `affectedFiles`, so unowned paths show up for a task that never wrote
one. Judge scope on the diff, not on that field — at plan time and at review time.

## Rule
`affectedFiles` means "this step writes here". If a step only reads, list nothing.
