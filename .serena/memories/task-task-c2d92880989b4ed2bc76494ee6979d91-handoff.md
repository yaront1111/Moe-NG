# adapters/ IDE adapter contract — worker handoff

Implemented by worker-a87e980a, 2026-08-09. All 10 steps done, task in REVIEW.
Package `@moe/ide-adapter-contract` at `adapters/ide-contract/`. Gate: `pnpm typecheck && pnpm test`
exit 0, 214 files / 4041 tests (baseline 212 / 4002).

## Read this before reviewing or extending
The commit sha is misleading. Foreign whole-tree commit **921ff53** (task-f6c9011b) swept 8 of the
10 files in mid-session; only the later fail-closed fix is in my own commit **a266ec1**. Review by
base-ref diff: `git diff 1e3057ab..HEAD -- adapters/ vitest.config.ts pnpm-workspace.yaml
tests/runtime/package-loadability.test.ts`.

## The shape that landed
- `src/index.ts` (234 lines) IS the contract module and the package root, so root-reachability is
  direct. Value exports (required — strip-types erases `export type`): `IDE_ADAPTER_LAYER`, frozen
  `IDE_ADAPTER_LAYERS` (4), frozen `IDE_ADAPTER_REASON_CODES` (14), and three pure decision
  functions `decideDaemonDiscovery` / `decideDaemonStart` / `decideControlRoomOpen`.
- Ports (`DaemonDiscoveryPort`, `DaemonStartPort`, `ControlRoomOpenPort`, `IdeAdapterPorts`) are
  declared interfaces returning Promise<Evidence>. The decision functions take the EVIDENCE, not the
  port — functional core / imperative shell. Nothing spawns, launches or opens a socket.
- Two refusing layers by design: the PORT refused (`DAEMON_DISCOVERY_PORT` etc.) vs THE CONTRACT
  refused to trust the port's claim (`IDE_ADAPTER`). Without that split a `layer` assertion is a
  constant and proves nothing.

## For task-9fd52b41 (the thin editor adapter)
Implement the three ports and feed their evidence to the decision functions. Do NOT restate the
reason codes and do NOT reimplement `packages/control-room-client` — that is the seam you drive.
Note the contract deliberately contains **no editor identifier at all**; a guard test enforces it
over the owned paths, so keep editor names in your own package.

## For task-05ce9b8f (security fault matrix)
The boundary you schedule against is the 14-code vocabulary plus the layer label. Hostile/stale/
replay cases map cleanly onto `UNDETERMINED`, `LAUNCHED_UNCONFIRMED`, endpoint-missing, and
`EVIDENCE_MALFORMED` (null/undefined/garbage evidence).

## Two edits outside the task's named files, both forced
1. `vitest.config.ts` include had no `adapters/**` entry — `pnpm test` would have collected ZERO of
   this task's tests at exit 0. Proved both directions (scratch test RED with it; drill reverting it
   gave a green 212-file run with zero adapters tests).
2. `tests/runtime/package-loadability.test.ts` asserted `adapters/*` expands to `[]` — a test pinning
   the ABSENCE of this deliverable. Not path-excusable foreign red: my diff made it false. Re-pointed
   the absent-base tolerance at a genuinely absent base instead of deleting the property.

## Rail collision, resolved deliberately
Step 9 asked for "Thin JetBrains adapter ... owns adapters/jetbrains/**" in the module header. That
violates DoD 5 + task rail 1. The neutrality guard caught it on first run. Consumers are named by
TASK ID and the clause is machine-checked by a test that reddens if either id is removed.

See `mem:gotcha-package-root-ts-entry-needs-no-js-bridge` and
`mem:gotcha-decision-fn-throws-instead-of-failing-closed`.
