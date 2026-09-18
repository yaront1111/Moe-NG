# @moe/daemon

The bounded ingress: the only place the workspace packages are composed into a running
process. It owns the six shipped bins, the control-room HTTP seam, the MCP stdio/HTTP
seams, the command registry every write passes through, and the orchestrator that spawns
real provider seats. Nothing above it — control room, adapters, `tests/e2e`, the packer —
reaches durable state except through a seam published here. It constructs no authority of
its own: a caller that injects no dependency provider is refused, never served a default.

## Seams

- `exports` is `"." → src/index.ts` only, a pure barrel with packed name lists (293 lines,
  43 source modules re-exported). There is no subpath, so a deep import from outside is
  not a supported seam.
- Six bins: `moe` (`cli/moe-cli-main.ts`), `moe-daemon` (`daemon-main.ts`), `moe-mcp-http`,
  `moe-mcp-stdio` (`mcp-main.ts`), `moe-up` (`orchestrator/moe-up-main.ts`), `moe-wrapper`
  (`orchestrator/agent-wrapper-main.ts`). Root `pnpm start` is `moe-up-main.ts`, `pnpm seed`
  is `orchestrator/demo-seed-main.ts`.
- `startDaemon` / `refuseEntry` / `isDependencyProvider` (`daemon-entry.ts`) — argv and
  signals stay in `daemon-main.ts` so the lifecycle is testable in process.
  `DaemonDependencyProvider.provide()` / `provideV2()` is the one seam authority reaches the
  transport through.
- `createDaemonCommandPorts` (`daemon-command-registry.ts`) and `createMcpDispatchPort`
  (`mcp-dispatch-port.ts`) are the two dispatch fronts over the same durable pipeline.
  A dispatch that THROWS behind either MCP transport is `UNKNOWN_ERROR` to the seat and
  `MCP_DISPATCH_THREW` on the diagnostics plane (`mcp-dispatch-fault-report.ts`), wired by
  all three MCP entries; grep that name before blaming a seat for a tool it "misused".
- `createStoreDependencies` / `readStoreDependencyEnv` (`daemon-store-dependencies.ts`) is
  the shipped provider `--dependencies=` points at; it re-exports `agentCapabilitiesFor`
  because the agent wrapper has always imported it from that path.
- Real external callers of the bare specifier: `tests/e2e/foundation/codex-journey-harness.ts`,
  `j1-ledger-view.ts` and `j4-replan-handoff.e2e.test.ts` (all for `readReviewLedger`),
  `tests/integration/portability/**`, `tests/fault/**`, `tools/packaging/pack-windows.ts`.

## The model

- **A command is added in the vocabulary, not at the boundary.** `daemon-command-vocabulary.ts`
  holds the only mapping: a family map for the capability, a `PAYLOAD_KEYS` row for the exact
  admitted keys, `OPERATOR_PRINCIPAL_KINDS` for the human fence. `daemon-command-registry.ts`
  only composes; `daemon-command-families.ts` classifies; `daemon-command-edges.ts` and
  `daemon-command-async-entries.ts` hold assembled edges; `daemon-command-graph-edges.ts`
  delegates the five graph mutations. `http-contract.ts` reads four fields off an entry.
- **Refusal shape.** `DomainRefusal(code, layer, detail, httpStatus = 422)` in
  `daemon-command-dispatch.ts`; `domainRefusalOf` keeps the refusing authority's own `detail`
  and uses the code only as the floor. The wire vocabulary is six codes
  (`HTTP_BOUNDARY_ERROR_CODES`), and the type `BoundaryCodesAreRuntimeCodes` breaks
  `tsc`, not a test, if one drifts out of the `@moe/contracts` registry.
  `HTTP_REFUSAL_STAGES` names the seven stages in ingress order.
- **Two authority planes.** `createCommandAuthorityGate(store, projectId, plane)` snapshots
  V1/V2 once per port set. `provideV2()` is a distinct plane that never falls back: it serves
  `Object.keys(PAYLOAD_KEYS)` minus `planning.submit_decomposition` and answers every dispatch
  `CUTOVER_V2_NOT_ACTIVE@DAEMON_CUTOVER_V2_AUTHORITY` until activated.
- **Absent wiring refuses; it does not unregister.** An unconfigured `CutoverActivationWiring`
  still registers `cutover.activate` and refuses each dispatch, because dropping the kind would
  make the advertised roster depend on host configuration.
- **MCP advertises what it serves.** `mcp-tool-allowlist.ts` derives the command half from
  `PAYLOAD_KEYS`, but `MCP_SERVED_QUERY_KINDS` stays hand-written on purpose as an independent
  oracle against `servedMcpQueryKinds()`; importing one into the other would make the parity
  assertion tautological. `approval.decide` and `graph.approve` are excluded: the `humanReview`
  witness is minted on operator principal identity alone, which an MCP caller presents
  identically.
- **The work family owns a closed reason vocabulary.** Every refusal under `work/` is built by
  `workFailure` in `work-kernel.ts`; `work-ingress.ts` is bytes→envelope only (bounded JSON,
  then exact own-key check against `moe-work-request/1`) and may never learn routing, auth or
  persistence.
- **Wrapper knobs are refused by name.** `wrapper-knobs.ts` rejects a non-integer
  `MOE_WRAPPER_INTERVAL_MS` / `MOE_WRAPPER_MAX_AGENTS` / `MOE_AGENT_TIMEOUT_MS` with
  `WRAPPER_ENV_INVALID`, because `setTimeout(fn, NaN)` becomes a tight loop against SQLite and
  `active < NaN` staffs nothing while the log says idle. `sessionTtlMs` is *derived*
  (`max(claimTtl, agentTimeout) + 60 s`) so the bearer outlives the child's own release.
  `MOE_NODE_TREES=1` and `MOE_WRAPPER_ONCE=1` are the two `=== "1"` flags.
- **`moe up` supervises, it does not modify.** It reads one canonical line,
  `listening on http://127.0.0.1:<port>`, suppresses any daemon line matching its
  `SENSITIVE_DAEMON_LINE` pattern, and on Windows relies on Ctrl-C or a child exit because an
  external SIGTERM never reaches a Node handler; it asks the wrapper to stop over stdin
  (`WRAPPER_STDIN_STOP_TOKEN`) before terminating it, since only the wrapper's own exit path
  `taskkill /T`s the seat trees.

## Gotchas

- **927 `.js` bridges beside 1733 `.ts` modules.** `runtime-entrypoint.test.ts` and
  `orchestrator/wrapper-entrypoint.test.ts` spawn a real child Node with
  `--experimental-strip-types`, cwd at the package root so `@moe/daemon` resolves through this
  package's own export map; `orchestrator/orchestrator-bridge-census.test.ts` walks every
  `./x.js` specifier in that directory without spawning and freezes no count. vitest and `tsc`
  both rewrite `./x.js` back to `x.ts`, so no other suite can see a missing bridge.
- `index-surface.test.ts` pins **`EXPECTED_EXPORTS.length === 156`** and
  **`FORBIDDEN_FIXTURES.length === 37`** — the second is a deny-list of fixture helper names
  (`streamPort`, `approveNodes`, `exactKeys`, …) that must *not* reach the package root. One
  new export in `index.ts` reds the count arm and the exact-namespace arm together.
- `daemon-command-vocabulary.test.ts` pins **65 kinds** plus per-family sizes (BOOTSTRAP 18,
  GRAPH 5, REVIEW 4, SESSION 3, STEP 3, WORK 3, COMPILER 4, …). By contrast
  `gates-roster-coherence.test.ts` deliberately freezes nothing: it enumerates served kinds off
  a real composed registry, asserts served ⊆ advertised (equality is false by design — some
  kinds are advertised and deliberately unserved) and exact set equality against
  `packages/control-room-client/src/generated/generated-client.ts`.
- `tests/security/boundary-roster.security.ts` names **90 rows under `apps/daemon/src/`** by
  constant and file. A new `export const *_LAYER`, or a bare `layer: "X"` literal at a refusal
  site, reds the security lane.
- **The daemon's vitest config is `package.json`, which has no `vitest` key** — a deliberately
  empty config, so the root `vitest.config.ts` (whose include list omits `apps/**`) never
  applies. `--root . --config package.json src` is the whole selection; drop either flag and
  you get a different file set.
- `bootstrap/bootstrap-test-fixtures.ts` sets `APPROVAL_MODE_ENV_KEY` and
  `SPEED_MODE_DELAY_ENV_KEY` with `??=` **at import time**: importing it puts the whole file
  under SPEED approval at zero delay unless the test states its own settings first.
- `work/foundation-attempt-windows.test.ts` names its live arm `LIVE_PROVIDER: …`; the default
  `test` script excludes it by negative `--testNamePattern` and `test:live:foundation-attempt`
  is the only way to run it.
- `cli/moe-cli-entry.ts` falls back from `import.meta.main` to an argv[1] realpath compare
  (case-insensitive on win32): on Node 23.6–23.11 and 24.0–24.1 the flag is `undefined`, and
  `moe --help` / `moe start` exited 0 in silence with the `MOE_CLI_NODE_UNSUPPORTED` check
  never reached.
- AGENTS.md's 250/400-line source rail bites here: `index.ts` packs export names several per
  line for that reason, and `daemon-entry.ts` re-exports the listener surface rather than
  adding another line to `index.ts`.

## Testing

- Whole folder: `pnpm --filter @moe/daemon test` (its own root/config, `--maxWorkers=4`,
  `--testTimeout=30000`). The root `pnpm test` does **not** discover `apps/**`.
- One file: `pnpm --filter @moe/daemon exec vitest run --root . --config package.json
  src/review/foo.test.ts`.
- Live provider arm: `pnpm --filter @moe/daemon test:live:foundation-attempt`.
  Typecheck alone: `pnpm --filter @moe/daemon typecheck`.
- Outside coverage: `pnpm test:security` (`boundary-roster`,
  `import-shadow-boundary-scenarios`), `pnpm test:fault`
  (`cross-host/production-surfaces.fault.ts`, `disaster-restore/**`, the per-OS effect
  conformance arms), `pnpm test:integration` (`portability/projection-shadow-matrix`,
  `portability/goal-brief-mcp-readback`), `pnpm test:e2e` (`tests/e2e/foundation` spawns real
  daemon and wrapper processes and folds this folder's `readReviewLedger`), and
  `tools/packaging/pack-windows.ts` for the shipped artifact.
