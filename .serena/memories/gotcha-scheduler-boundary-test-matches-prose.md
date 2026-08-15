# Gotcha: `package-boundary.test.ts` flags a COMMENT the same as a deep import

Found 2026-08-08 while running the baseline for `task-8ee125d0f05f4966abfcc49db37bbbf5`.
`pnpm --filter @moe/scheduler test` was **already red at HEAD**, before any edit.

```
FAIL packages/scheduler/src/package-boundary.test.ts >
     keeps scheduler registrars behind the package-root import boundary
AssertionError: expected [ Array(1) ] to deeply equal []
+ [ "packages\\runner\\src\\supervisor\\effect-test-fixtures.ts" ]
```

## Why

`packages/scheduler/src/package-boundary.test.ts:10` scans **raw file contents** of every
source file under `adapters/`, `apps/`, `packages/`:

```ts
const forbiddenInternalPath = /(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u;
```

`packages/runner/src/supervisor/effect-test-fixtures.ts:17` is a **doc comment**:

```
 * `packages/scheduler/src/authority/test-fixtures.ts`).
```

That is prose, not an import, and it trips the check identically. Committed in `72545bb`
(task-2580a578). The boundary itself was never actually violated.

## Consequences

- **Any task whose gate includes `pnpm --filter @moe/scheduler test` inherits this red**, and
  cannot fix it: neither file is normally an owned path. It cost `task-8ee125d0f05f4966abfcc49db37bbbf5`
  a `report_blocked` on otherwise-finished, committed work.
- **QA: attribute the red BY PATH.** A violation naming a file outside the task's owned paths
  is not that task's regression. Prove it with the count: baseline 519 (518 pass + 1 fail) vs
  final 567 (566 pass + the same 1 fail) — the delta is exactly the new cases.

## Writing a scheduler test that mentions a deep path

Safe **only inside `packages/scheduler/`**: `sourceFiles()` skips the scheduler package root
(`package-boundary.test.ts:26`), so a negative-control comment naming
`@moe/scheduler/authority/lease-resource.js` there cannot self-trip. Write the same string in
a runner/daemon/adapter file and the suite goes red.

## Fixes (one line, whoever owns the path)

1. Runner owner rewords the comment so it carries no `scheduler/src/` segment.
2. Scheduler owner anchors the regex to import/require/from positions so prose stops counting.

Related: `mem:gotcha-workspace-exports-map-is-exclusive`,
`mem:gotcha-completion-hook-commits-whole-tree`.
