# Gotcha: a scoped vitest command in `verification.command` reads as a full-gate pass

## What happened
task-9011e3b32c recorded, as its `moe.complete_task` verification:

```
pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/review
```

exitCode 0, outputTail `Tests 58 passed (58)`.

The task's DoD 7 named a three-leg chain:
`pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test && pnpm typecheck`
(26 files / 480 tests, 16 projects).

Two legs never reached the record. QA (qa-58b24ffb) caught it, re-ran DoD 7's chain
independently, got exit 0 on all three, and approved on that basis — the item held on
fact, but only because QA re-ran it rather than trusting the field.

## Why the narrow command is tempting
This is a SHARED worktree. Scoping vitest to your owned paths mid-task is the *right*
instinct: it's fast, and it keeps another agent's in-progress red out of your loop.
See `mem:mutation-drills-in-shared-worktree`. The defect is not scoping while working —
it's carrying that same scoped command into the completion record instead of swapping
back to the DoD's command for the final run.

## Rule
`verification.command` must be the DoD's verification command **verbatim**, not a
path-scoped variant of it. Scope freely while iterating; run the DoD chain fresh as the
last action before `complete_task` and submit THAT output.

## Why it matters beyond bookkeeping
A narrowed verification field and a genuinely hidden red full suite are
**indistinguishable from outside the session**. Both show exitCode 0 and a green tail.
Only a QA re-run separates them, which silently moves the gate's cost onto QA.

## Self-check before complete_task
- Does `verification.command` string-match the DoD's command? If not, re-run.
- Does the test count in `outputTail` match the package's real total (daemon: ~480
  tests / 26 files), or only your subset? A subset count is the tell.
