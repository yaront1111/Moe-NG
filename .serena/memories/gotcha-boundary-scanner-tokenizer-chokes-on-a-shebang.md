# The scheduler boundary scan fails on a clean file, from committed bytes

`packages/scheduler/src/package-boundary.test.ts` walks the whole repo and tokenizes each source
to find forbidden imports. As of 2026-08-09 (HEAD ffa39d6) it fails repo-wide:

```
FAIL packages/scheduler/src/package-boundary.test.ts > keeps scheduler registrars behind the package-root import boundary
Error: boundary scan failed for apps\daemon\src\daemon-main.ts: Error: unterminated regular expression source token
```

## Why this one is a trap

Every instinct says "foreign uncommitted WIP" (`mem:gotcha-clean-package-reddened-by-foreign-uncommitted-contract`).
It is not. **Both files are clean vs HEAD** — `git status --porcelain` is empty for each and
`git diff --stat HEAD -- apps/daemon/src/daemon-main.ts` is empty. The red reproduces from
committed bytes with no working-tree state involved, so no one can clear it by landing or
reverting anything.

Cause: `daemon-main.ts` line 1 is `#!/usr/bin/env node`. The scanner's tokenizer sees the `/`
after `#!` as opening a regex literal, `/usr/` closes and reopens, and the line ends unterminated.
The scanner has no shebang skip. `daemon-main.ts` last changed in 749eb46 (task-f01ef545, Linux
platform observation boundary); the scanner last changed in de1298a (task-8d198514, "close
boundary parser gaps").

## How to act on it

- Do **not** spend a context load re-attributing it, and do **not** block your task on it.
- It is outside every package gate except a repo-wide `pnpm test`, so an owned-package leg of
  `pnpm --filter <pkg> test` is unaffected — path-attributed baseline applies cleanly.
- If you own the scanner: skip a leading `#!` line before tokenizing. Related failure family in
  `mem:gotcha-scheduler-boundary-test-matches-prose` and
  `mem:gotcha-boundary-test-greps-prose-not-imports` — this scanner keeps mis-reading source it
  only meant to scan for import specifiers.

Attribution recipe that settled it, reusable: grep the received error for the file it names, then
`git status --porcelain` **and** `git diff --stat HEAD` on that named file. Empty output on both
means committed bytes, which rules out every "sibling WIP" explanation in one step.
