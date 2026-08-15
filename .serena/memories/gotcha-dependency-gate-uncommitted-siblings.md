# Gotcha: file existence != dependency landed (parallel workers, shared tree)

Workers run in parallel in the SAME tree (D:/projexts/moe-next, no sibling worktrees). A sibling
task's files therefore appear on disk long before they are real. Seen 2026-08-07: packages/mcp had
package.json + src/stdio/*.ts present and `pnpm --filter @moe/mcp test` exit 0, while
`git log --oneline -- packages/mcp | wc -l` was `0` and `git status --porcelain -- packages/mcp` was
`?? packages/mcp/` — the whole package untracked, its owner mid-write (Moe emitted a
"file collision" chat warning on the exact file seconds earlier).

## Reliable landed-ness test for a SOFT-DEP gate
1. `git log --oneline -- <dep path> | wc -l` — 0 means nothing landed, full stop.
2. `git status --porcelain -- <dep path>` — `??` means untracked, `M` means a live edit in flight.
3. Compare file mtimes against now; a dep file touched minutes ago is being written right now.
4. grep for the SPECIFIC symbol the plan gates on (e.g. `AbortSignal`), not just the file name —
   the file can exist with the required member absent.
5. A green focused test run is NOT evidence the dep landed; it can be green and thin (schemas only)
   while the module you must integrate with does not exist yet.
6. **Attribute symbol hits to FILES, not counts.** A symbol-keyed probe run as
   `grep -rn <symbol> <pkg>/src | wc -l` can return double-digit hits sourced entirely from the
   dependency's own uncommitted TDD RED test file. Seen 2026-08-07 on task-84e875f9 (admission)
   gating on task-eef1e7f2 (dependency kernel): `validateDependencyContract` = 14 hits, all in
   `packages/scheduler/src/dependencies/dependency-contract.test.ts`, zero production modules on
   disk. Always follow with `grep -rln <symbol> <path>` and reject hits whose only file is a
   `*.test.ts` — a test naming a symbol is a promise, not an implementation.

## Why it matters
Building on an uncommitted sibling reproduces the "orphaned on main" failure the governor rails call
out: the sibling can rewrite or revert the file under you, and your commit lands referencing paths
that never got committed. Prefer moe.report_blocked needsFrom <dep task> over re-scaffolding or
editing files owned by another task.
