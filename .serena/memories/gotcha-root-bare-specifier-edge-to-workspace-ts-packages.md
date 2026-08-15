# Gotcha: making the repository ROOT a real consumer of a workspace package

Landed by `task-c690a7a0c5a14daaa088acbc32e26815` (root -> `@moe/runner`, `@moe/daemon`).

## The edge is three things, and only one of them is the manifest
1. root `package.json` gains a `dependencies` block with `"@moe/x": "workspace:*"`;
2. `pnpm-lock.yaml`'s `.` importer gains `version: link:<dir>`;
3. `pnpm install` materializes `node_modules/@moe/x -> ../../<dir>`.

A lock-only edit does **not** create (3), and without (3) a bare import from the repo root still
fails `ERR_MODULE_NOT_FOUND`. Hand-editing the lock is therefore never sufficient.

Cost is genuinely minimal and reviewable: adding two workspace deps produced **+4 lines in
package.json and +7 in pnpm-lock.yaml, in a single hunk confined to the `.` importer**. Every other
importer and every root script stayed byte-identical, and registry deps reported "Already up to
date". If your lock diff is bigger than that, something else drifted — inspect before staging.

## Node 24 CAN import a workspace package whose exports map points at `./src/index.ts`
`node tests/.../probe.ts` and `node --input-type=module -e 'await import("@moe/daemon")'` both work
from the repo root. This surprises people because Node refuses type-stripping for files under
`node_modules` — but pnpm's workspace link is a **symlink**, and Node resolves to the realpath
(`apps/daemon/src/index.ts`), which is outside `node_modules`. So stripping applies and it loads.
Corollary: `preserveSymlinks` would break this.

## A bare-import gate must be run OUTSIDE Vitest too
Vitest/Vite resolves workspace sources through its own resolver and will happily go green while the
real Node edge is broken. Prove the edge with BOTH a compiled probe (`tsc -p <lane tsconfig>`) and a
plain-`node` run from the repository root. Also beware cwd: running the probe from inside the
package's own directory proves nothing about the root.

## The fault-lane typecheck does NOT inherit a package's test-file errors
`tsc -p tests/fault/tsconfig.json` adds the reachable production graph behind a bare import, but a
package's own `*.test.ts` files are not imported by its `index.ts`, so they never enter the program.
Confirmed 2026-08-16: repo-wide `pnpm typecheck` was red on
`apps/daemon/src/work/foundation-attempt-service.test.ts` (TS2339) while the fault-lane typecheck
that imports `@moe/daemon` exited 0. Do not assume a red repo-wide typecheck blocks your lane gate —
measure it.

## Naming a probe so it compiles but does not run
Put it under the lane dir as `*.probe.ts`: `tests/fault/tsconfig.json` includes `./**/*.ts` (so tsc
checks it) while the Vitest lane includes only `**/*.fault.ts` and `foundation/**/*.test.ts` (so the
suite ignores it). Install `trap 'rm -f "$PROBE"' EXIT HUP INT TERM` before creating it.
