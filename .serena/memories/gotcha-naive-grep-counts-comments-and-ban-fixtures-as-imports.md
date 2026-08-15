# A naive dependency grep counts comments and ban-test fixtures as imports

Found 2026-08-09 while planning `task-4d22630791994ed1b0906632a75b349b` (workspace manifest
hygiene). It produced a task description with a **falsified** claim that survived to the DoD.

## The failure
`grep -rhoE '@moe/[a-z-]+' <dir>` reports a package as imported when it is not. In this repo there
are two systematic sources of false positives, and both are *more* common in exactly the
well-documented, well-tested packages you are most likely to audit:

1. **Prose comments about dependency policy.** `packages/scheduler/src/budget-measurement.ts:15`
   reads "No @moe/core or @moe/contracts import — …" and `budget-reservation.ts:13` reads
   "@moe/core is not imported by design". A naive grep counts both as evidence that @moe/core IS
   imported — the exact inverse of what the file says.
2. **Ban tests that plant fake import strings as fixtures.**
   `apps/control-room/src/evidence/evidence-timeline-ban.test.ts` holds a `BANNED_PACKAGES` list,
   plants `` `import { CURSOR_GAP } from "@moe/store/subscriptions";` `` to prove its detector
   fires, and asserts the catch. `scaffold.test.tsx` checks specifiers inside a `heldOutImport`
   regex. Naive grep reads a banned package as a dependency to declare.

Both failure modes point the same direction: **toward adding a dependency the codebase
deliberately forbids.**

## The measurement that works
```
grep -rnoE "(from|import|mock|require)\s*\(?\s*[\"']@moe/[a-z-]+" <dir> \
  --include=*.ts --include=*.tsx --include=*.js | sed -E "s/.*[\"']//" | sort | uniq -c
```
Then cross-check with an unfiltered grep of the whole directory and **read every hit the two
disagree on** — that delta is exactly where the comments and fixtures live.

## Reusable rule
Before adding a dependency to a manifest, confirm the import is a real *specifier*, not a mention.
When a raw grep and a specifier grep disagree, the raw grep is wrong. Treat any hit inside a file
named `*-ban.test.*`, or near the words "banned", "held out", "by design", or "not imported", as
evidence **against** the dependency.

## Second-order lesson
A declared-but-unimported dependency and an imported-but-undeclared one are the same audit,
run in opposite directions. A task that fixes the first while adding instances of the second is
self-contradictory — check the task's own objective sentence against each proposed edit.

See `mem:task-task-4d22630791994ed1b0906632a75b349b-handoff`.
