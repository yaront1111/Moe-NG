# Gotcha: a sibling's TDD RED file can hold your package gate hostage

Seen 2026-08-08 on `task-975f8d673a0c45238b117f91682fbbec` (control-room node/attempt
workspace). My plan's verification command is package-scoped:

```
pnpm --filter @moe/control-room typecheck && pnpm --filter @moe/control-room test
```

Mid-session a sibling worker created `apps/control-room/src/shell/gating-keyboard.test.tsx`
importing `./frame.js` and `./provenance-panel.js` — its RED phase, production files not
written yet. `tsc --project tsconfig.json` includes `src/**/*.tsx`, so the whole package
typecheck went to exit 1 on two `TS2307 Cannot find module` errors in a file I do not own.

## Why this is worse than a foreign test failure

`moe.complete_task` requires `verification.exitCode === 0` from a FRESH run. A red root
`pnpm test` can be argued as provably-foreign in prose (see
`mem:task-task-fd82678f720747888d1c32ef96bb5534-handoff`), but a non-zero exit cannot be
submitted at all. So a sibling's normal, correct TDD red phase can block your completion
even when 100% of your own work is green.

## What to do

1. **Commit your owned paths FIRST**, before chasing the gate. Use
   `git commit -m ... -- <explicit paths>` (path-limited commit) rather than
   `git add <paths> && git commit`: the path-limited form takes working-tree content for
   exactly those paths and ignores whatever a concurrent agent has staged, which is the
   cheapest defence against `mem:gotcha-shared-index-commit-capture`. Verify with
   `git show --stat HEAD` that the commit contains only your files.
2. Re-run the gate after a delay; a red phase usually closes within minutes.
3. If it persists, report honestly — never submit a scoped or filtered substitute as if it
   were the named command.

## Related, same session

Two sibling agents committed with a broad add and swept my in-progress owned files into
THEIR commits (`633422f` budget reservations, `ac61db2` upcaster engine both contain all ten
of my files). Attribution in history is wrong and cannot be repaired without rewriting shared
history, which the rails forbid. Do not reset/revert — commit your remaining delta under your
own task message and flag the capture in the handoff.
