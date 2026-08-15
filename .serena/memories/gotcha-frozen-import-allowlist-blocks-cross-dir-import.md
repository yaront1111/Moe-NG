# Ban tests freeze directory listings AND import allowlists

Before planning any change that adds a file to, or adds an import into, a
control-room directory, check whether a `*-ban.test.ts` owns it. Four of them do,
and they fail by design on exactly the moves a normal refactor makes.

```bash
grep -rn "readdirSync\|ALLOWED_IMPORTS" --include=*.ts --include=*.tsx apps/control-room/src
```

## Which directories are frozen

`board`, `goals` (`board/goals-board-ban.test.ts`) · `data` (`data/data-ban.test.ts`)
· `evidence`, `timeline` (`evidence/evidence-timeline-ban.test.ts`) · `doctor`,
`recovery` (`recovery/recovery-import-ban.test.ts`).

**`src/shell` and `src/a11y` are the only UI directories with no frozen listing** —
and `src/performance` likewise, being new. The app-root `src/` listing is not frozen,
which is how `src/a11y/` was added cleanly.

## The two locks, and which one surprises you

`recovery/recovery-import-ban.test.ts` is the strictest and carries four assertions
its own header calls load-bearing:

- `:34-38` `EXPECTED_RECOVERY_FILES` — exact `readdirSync` listing, 8 names. **Adding
  any file to `src/recovery/` turns it red**, including a test file.
- `:46-53` `SCANNED_MODULES` — per-file anchors like
  `"export function RecoveryActions("`. The trailing `(` is deliberate: a bare prefix
  still matches a renamed `RecoveryActionsRenamed`, and a mutation drill proved it.
- `:55-58` `ALLOWED_IMPORTS` — **the one that surprises people.** Frozen to exactly
  `@moe/contracts`, `../nodes/node-authority.js`, `../shell/frame.js`,
  `./recovery-actions.js`, `./recovery-external.js`, `react`. Any new cross-directory
  import goes red even though the file count never changed.
- `:64-70` `FORBIDDEN_TOKENS` — `node:fs`, `process.env`, `fetch(`, `localStorage`,
  `@moe/daemon`, `createRuntimeError`, … i.e. anything that would let a presentation
  module grow its own authority.

## Rule when you must cross the boundary

Amending is legitimate — sometimes required, e.g. a rail saying a surface must
consume a shared module rather than keep a divergent copy. But:

1. Add **exactly** the new specifier or filename. Never widen a category.
2. **Prove the ban still bites**, don't assume it: temporarily add an unlisted import
   and confirm red, temporarily add a scratch file and confirm the listing assertion
   goes red, then remove both. *A widened allowlist that no longer refuses anything is
   worse than the import it was widened for.*
3. Give the amendment its own plan step. It is not incidental to the refactor — it is
   the step most likely to be forgotten and to surface as a mystery red.

Paths in these tests resolve from `process.cwd()` (the Vitest root is the package),
**not** `import.meta.url` — under the React plugin that gets rewritten to an http URL
for `.tsx`, and a scan that silently reads nothing passes every absence assertion
forever.

Related: [[task-task-a62e3c2d58404bd7bc2fc2ca09930f1d-handoff]]
