# Handoff: cross-host bare-root consumer edge (DONE, commit 5839518)

Task `task-c690a7a0c5a14daaa088acbc32e26815` implemented at base `6ca5da0`; committed as `5839518`
by explicit pathspec (`git commit --only -m ... -- <3 paths>`), 3 files, +177/-0.

## What landed
- root `package.json`: new `dependencies` block, `@moe/daemon` and `@moe/runner` at `workspace:*` (+4).
- `pnpm-lock.yaml`: one hunk, `.` importer gains `link:apps/daemon` / `link:packages/runner` (+7).
- `tests/fault/cross-host/production-surfaces.fault.ts` (166 lines, 4 tests, 1 file).

## For the consumer, task-01c5f96ec1e247dc846fd628c929974a
The edge is live and proven at runtime, not just at the type level. You can now write
`import { PLATFORM_BOUNDARIES, observeLinuxPlatform, observeMacosPlatform } from "@moe/runner"` and
`import { collectDoctorVersionReport } from "@moe/daemon"` from anywhere under the repo root.
Do NOT add deep relative imports — the durable test polices its own bytes for them and will go red.
The frozen boundary tuple, in order: PROVIDER_LAUNCH, GIT_WORKSPACE, PATH_SYMLINK, LOCK,
SIGNAL_CANCELLATION, RUNTIME_CLOSURE, CRASH_RECOVERY. `collectDoctorVersionReport` is a zero-arg
AsyncFunction. Publication/loadability grants NO host-evidence authority — this file deliberately
never invokes the OS classifiers as executing-host probes, and neither should yours.

## Gate (exit 0 at HEAD 5839518, rerun fresh post-commit)
`pnpm install --frozen-lockfile && pnpm exec tsc -p tests/fault/tsconfig.json && pnpm exec vitest run --config tests/fault/vitest.config.ts cross-host/production-surfaces.fault.ts`
-> `Test Files 1 passed (1)`, `Tests 4 passed (4)`. Deterministic count is 4; a change in that count
is a real signal, not noise. Toolchain: `export PATH="/tmp/moe-node24-bin:$PATH"` (node v24.16.0,
pnpm 11.0.8) — the default shell node is v18 and cannot run this.

## Path-attributed baseline (for QA)
Baseline captured BEFORE any byte changed; HEAD legs after. Owned-path delta EMPTY.
- `pnpm typecheck`: 1 -> 0. Baseline red was foreign (`apps/daemon/src/work/foundation-attempt-service.test.ts` TS2339); its owner fixed it mid-session.
- `pnpm test`: 1 -> 1, but HEAD failing FILE SET {mcp-root-surface, review/runtime-entrypoint} is a strict SUBSET of baseline {+ mcp-runtime-entrypoint, store/projection-crash-drill}. New-failure set empty.
- `pnpm test:meta` 0 -> 1 and `pnpm verify:store` 1 are both the documented slow-fs flake class, on foreign paths, and both pass isolated: `foundation-incident-probe-precision.test.ts` (Test timed out in 20000ms) -> 6/6 pass at `--testTimeout=180000`; `recovery-initial-install.test.ts` (ENOENT realpath on a `/tmp/moe-initial-install-race-*` dir) -> 16/16 pass. See `mem:gotcha-slow-fs-makes-5s-vitest-timeouts-look-like-failures`.

## Non-obvious mechanics
See `mem:gotcha-root-bare-specifier-edge-to-workspace-ts-packages` — why a lock-only edit is not the
edge, why Node 24 can import a workspace package whose exports map points at `./src/index.ts`, why a
Vitest-only green can hide a broken root edge, and why the fault-lane typecheck does not inherit a
package's own `*.test.ts` errors.

## Anti-vacuity evidence
Rail 6 was satisfied by mutation, not by assertion-reading: swapping PATH_SYMLINK/LOCK in the
hand-written tuple turned the production comparison red (1 failed | 3 passed) and the file was
restored byte-identically. Production sources were deliberately NOT mutated — they are foreign-owned
in this shared tree and a foreign whole-tree commit could have captured the mutation.
