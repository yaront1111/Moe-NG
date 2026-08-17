# Handoff: task-5e43a9e294ef48fdab23817c8c6cfc45 (Foundation daemon ingress surface)

## Status
**DONE -> REVIEW** 2026-08-17 by worker-f144c751. Supersedes the 2026-08-09 BLOCKED note:
all five producers landed, all six families were present, the task was fully plannable.

## What shipped
`@moe/daemon` root: **85 -> 132 runtime exports (+47)**, six families with vocabularies and
full type closure. Seven owned paths:

| Path | Before | After |
|---|---|---|
| `apps/daemon/src/index.ts` | 389 | **217** (pure barrel, zero imports) |
| `apps/daemon/src/foundation/foundation-surface.ts` + `.js` | — | **114** (new) |
| `apps/daemon/src/graph-preview-request.ts` + `.js` | — | **124** (new) |
| `apps/daemon/src/index-surface.test.ts` | 851 | 1154 |
| `apps/daemon/src/runtime-entrypoint.test.ts` | 213 | 333 |

## The size premise was stale a FOURTH time
Description said 249. Architect 1 measured 317, architect 2 measured 346, plan said 389, and
389 is what I measured. **Always re-measure `wc -l < apps/daemon/src/index.ts`.**

The real problem was not export volume: ~106 lines were a BEHAVIOR block (GraphPreview types +
`evaluateGraphPreviewRequestBytes`) living inside the barrel. Extracted byte-identically.

## Two decisions a future agent should not re-litigate
1. **Placement.** Plan *suggested* `http/graph-preview-request.ts`. Landed at
   `src/graph-preview-request.ts` because its test sibling `graph-preview-request.test.ts`
   already existed at `src/`. See `mem:gotcha-daemon-runtime-tier-is-a-forward-closure`.
2. **Closure boundary.** Types owned by another workspace package (`@moe/coordination`'s
   `CoordinationAckResult`/`ReadResult`/`SendResult`, `@moe/runner`'s `PredecessorRelease`,
   `@moe/store`'s `SqliteEventStore`) are NOT restated at the daemon root. `index-surface.test.ts`
   imports them from their own public roots — which is what proves the closure is expressible
   without a deep import. That convention predates this task (see its comment at :14-21).

## Where the guards live (extend these, do not add a parallel suite)
- `index-surface.test.ts`: hand-written frozen `EXPECTED_EXPORTS` (132 `[name, typeof]` pairs),
  size guard `toBe(132)`, bidirectional set equality, `it.each` per-name kind, `FORBIDDEN_FIXTURES`
  (34) with size guard `toBe(34)`, and a new describe `daemon package-root Foundation ingress
  closure` (8 cases).
- `runtime-entrypoint.test.ts`: child-process probes + the bridge sweep.

**Adding a root export means editing FOUR things**: the producer's surface entry, `index.ts`,
`EXPECTED_EXPORTS` (in sorted position), and `toBe(<count>)`. The `ENTRYPOINTS` table in
`runtime-entrypoint.test.ts`'s Foundation probe (`resolved: 47`) is a fifth if it is a Foundation name.

## Sort order for EXPECTED_EXPORTS
`Object.keys(ns).sort()` is UTF-16 code units: **SCREAMING_CASE first, then camelCase.**
Regenerate the literal with a throwaway probe in `apps/daemon`, then paste — it is a static
literal in the file, which is what the rail requires.

## Gate state at handoff
- `pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test` -> exit 0,
  **121 files / 2571 tests** (baseline before first edit: 121 / 2488).
- `pnpm typecheck` -> **exit 1, FOREIGN**: `packages/import/src/import-apply.test.ts(135,35)
  TS2339 domainSchemaVersion` — an uncommitted peer mid-TDD-red. Same command was GREEN at
  23:09:27 with my full diff applied and reddened by 23:10:47. Zero intersection with owned paths.

## Commit situation
`git status --porcelain -- apps/daemon/` is EMPTY. Foreign whole-tree sweeps captured everything:
six paths in `914eddb` (task-4dd4424c), `runtime-entrypoint.test.ts` in `04c6532` (task-c534626b).
Committed bytes == gated bytes (`git rev-parse HEAD:<p>` == `git hash-object <p>`, 7/7).
QA reviews by base-ref diff from **29f3c5f**, not by commit id.

See `mem:gotcha-daemon-runtime-tier-is-a-forward-closure`,
`mem:gotcha-pure-barrel-shrinks-only-by-densification`.
