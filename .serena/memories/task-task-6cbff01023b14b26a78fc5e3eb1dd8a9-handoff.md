# task-6cbff01023b14b26a78fc5e3eb1dd8a9 handoff

Status 2026-08-16 11:48Z: all 7 steps COMPLETED, task submitted to REVIEW. Reopen (governor cascade 09:48Z) is closed.

## What the reopen demanded and what landed
`FoundationAttemptDeps.runtimePorts` (caller/test-composed `clock|facts|fs`) is REMOVED. `dispatch()` now calls the bare-root
`createClaudeRuntimePinRequest(request.launchTemplate.runtime)` from `@moe/runner` BEFORE any authority write and returns
`foundationAttemptRefusal(runtime.code, runtime.layer)` on refusal — the runner's own codes at layer `RUNTIME`.
`launchRequestBody(record, bound, template, runtime: object)` forwards the hydrated pin request WHOLE (no spread of
`template.runtime` over it), so no request field can re-layer a minted capability.

Key surface facts (measured on committed bytes):
- `createClaudeRuntimePinRequest` is published via `packages/runner/src/surface/claude-surface.ts`; it takes exactly
  `{quotedObservation, installedRoot, pinRoot}` and MINTS fs/facts/clock. Its docstring names THIS task as the consumer.
- `observeInstalledClaudeRuntime` stays WITHHELD from the root on purpose; the daemon must not reach it.
- `pathShapeRejection` requires an absolute local-drive WINDOWS path (`C:\...`); hydration does NO I/O, so synthetic
  `C:\installed` / `C:\pins` fixtures pass on Linux.
- `readQuote` has no platform gate: version/provider/PROVEN/CONTENT_ADDRESSED_COPY/closure bounds + exactly one EXECUTABLE.

## Test evidence
- Focused daemon suite: 1 file / 25 tests passed (was 21). New cases: deps-supplied capability set never touched, quote-digest
  drift -> `CLAUDE_RUNTIME_QUOTE_INVALID@RUNTIME`, control-char installedRoot -> `CLAUDE_RUNTIME_PATH_INVALID@RUNTIME`,
  2-case closure sweep (PACKAGE-only, two EXECUTABLEs) with positive generated count. All assert zero events on BOTH aggregates.
- RED before the change: 9 failed. Mutation drills, each verified applied and md5-restored: `bearing.length > 1 -> > 99`
  reddened multi-node; disabling the REPLAYED-reservation gate reddened concurrent delivery; bypassing the hydration refusal
  reddened EXACTLY the 3 new runtime cases.
- Line counts: contracts 215, service 249, codec 194, store 155; four `.js` bridges 1 line each.

## Windows suite (NOT one of the owned paths)
`foundation-attempt-windows.test.ts` can no longer use a fake `claude.exe`: production runs the real host observer, which
executes the binary with `--version` through the shipped broker and demands `^\d+\.\d+\.\d+`. A `where.exe`/`node.exe` copy
therefore refuses `CLAUDE_RUNTIME_OBSERVATION_INVALID@RUNTIME` — a code only reachable AFTER a real child ran (an absent
broker answers `PROCESS_BOUNDARY_BROKER_UNRESOLVED`), so it is physical proof the boundary launched. A real installed Claude
exists at `C:\Users\Yaron\.local\bin\claude.exe`; dispatching against it answers `CLAUDE_RUNTIME_OBSERVATION_CHANGED@RUNTIME`
(quote vs fresh observation drift).

## Concurrency hazard live during this session
Another process repeatedly rewrote `foundation-attempt-windows.test.ts` (11:37Z, 11:41Z, 11:42Z) and briefly perturbed
`foundation-attempt-service.ts` mid-typecheck (one transient TS6133 that did not reproduce). `moe.list_workers` showed only
worker-5678886b on this task. I preserved every foreign byte and never reverted them.

## Commit state
Foreign whole-tree commit `b55b9f0 feat(task-9aca4b0524a648f1841237b40d4e345b)` swept this task's bytes. Not amended, not
reset, not re-claimed. QA base-ref diff: `git diff 0f19e06..HEAD -- apps/daemon/src/work/foundation-attempt-*`.

## Foreign red at completion (none intersects owned paths)
- daemon: activation-ledger-reader.test.ts (2) + foundation-launch-authority.test.ts (2) — released O(n) effect-binding task's
  deliberately-red bounded-scan repros; windows.test.ts (1) — a peer's live `code:"DIAGNOSTIC"` probe.
- store: `packages/store/src/recovery-anchor.test.ts` — a withheld symbol leaked onto the @moe/store root by another task.
An earlier daemon run showed 30 failures / 10 files; re-running gave 5 / 3. The extra 25 were concurrent-writer interference
(`index-surface` and `runtime-entrypoint` pass in isolation, 113 tests).
