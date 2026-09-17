# @moe/runner

The layer where authority the store already committed becomes physical: a real process
inside a Windows Job object, a real Git worktree, real bytes on disk — and where the
observation of what happened comes back PROVEN or UNKNOWN. It decides nothing about goals
or plans. It owns the supervisor effect lifecycle, the Windows process boundary and its
Rust broker, Claude/Codex launch and stream recording, the content-addressed evidence and
materialization digests, and the recovery-window inventory. `apps/daemon` is effectively
its only consumer.

## Seams

- The `exports` map is exclusive — `{".": "./src/index.ts"}` — so a deep subpath like
  `@moe/runner/supervisor/effect-lifecycle.js` does not resolve for a consumer at all.
  Both root tests import through the bare specifier for that reason.
- Supervisor lifecycle: `applyEffectCommand`, `applyEffectTombstone`, `activateEffect`,
  `consumeActivationGrant`, `settleEffectFromProviderObservation`, `fenceMirroredLease`.
  Callers: `apps/daemon/src/work/work-lifecycle.ts`, `work-claim.ts`,
  `activation/activation-ingress.ts`, `work/effect-terminal-ledger.ts`.
- Process boundary: only `openWindowsProjectStackBoundary` is published; the arbitrary
  `openWindowsProcessBoundary` stays private. Caller:
  `apps/daemon/src/projects/project-manager-main.ts`.
- `createCriterionCheckExecutor` → `apps/daemon/src/criterion-evidence/criterion-runner.ts`.
- `launchClaudeWithTelemetry`, `parseClaudeResultTelemetry`, `buildProviderRunRecord`,
  `normalizeProviderUsage` → `apps/daemon/src/activation/activation-telemetry-launch.ts`
  and `telemetry/provider-run-ledger.ts`.
- Workspace and evidence: `buildInputManifest`, `proveFoundationPrelaunchTree`,
  `captureFoundationWorkspaceDelta`, `createNodeWorktreeMaterializer` → daemon
  `work/foundation-capture-lifecycle.ts`, `work/foundation-capture-producer.ts`,
  `evidence/foundation-verification-candidate.ts`.
- `observeScope`, `createNodeSourceSnapshotGitObserver` → daemon
  `evidence/foundation-verification-candidate.ts`,
  `delivery-v2/source-snapshot-publisher.ts`.
- `collectRecoveryInventory` plus the four registration factories →
  `apps/daemon/src/recovery/effect-inventory-collection.ts`.
- Six `src/surface/*.ts` modules reach the root via `export *`; each is itself an explicit
  named list, so the root surface cannot grow without a reviewer editing one of them.
- `createArtifactStore` and the whole `src/artifacts` seam have no caller outside this
  package today; `candidate-rematerialization.ts` is its only user.
- Declared deps are `@moe/contracts` and `@moe/scheduler`, but only
  `providers/telemetry/*` actually imports the scheduler.

## The model

- Nothing throws at a boundary. Each area declares frozen `*_LAYERS` and `*_ERROR_CODES`
  beside a failure constructor, and the LAYER is what separates two gates sharing a code
  (`EVIDENCE_REFUSAL_LAYERS`, `MATERIALIZATION_REFUSAL_LAYERS`, `WINDOWS_PROCESS_LAYERS`).
  Truth classes floor at UNKNOWN and no path may raise it.
- Digest records are version-pinned so a digest stays comparable only while its field set
  is: `moe-node-input-manifest/1`, `moe-evidence-receipt/1`, `moe-verification-recipe/1`,
  `moe-recovery-inventory/1`, `moe-effect-intent/1`, `moe-criterion-check-executor/1`.
  `src/canonical.ts` `canonicalJson` sorts keys and THROWS on an unsupported shape, so
  nothing unserializable can silently reach a digest.
- Windows containment is a Rust crate, `platform/windows/native` (`moe-windows-job-broker`).
  TypeScript writes bounded frames over three fds; the broker owns the Job object.
  `windows-frames.ts` duplicates the six-byte header FORMAT, never the authority, with
  per-channel caps (CONTROL 64 KiB, STATUS 4 KiB, DIAGNOSTIC 512 B). Four of the eight
  `WINDOWS_PROCESS_LAYERS` mirror the broker's `RefusalLayer`
  (`native/broker/src/refusal.rs`) so a refusal that crossed the pipe keeps its identity.
- An absent broker FAILS. `resolveBrokerBinary` returns
  `PROCESS_BOUNDARY_BROKER_UNRESOLVED` / `WINDOWS_PROCESS_RESOLUTION`; there is no
  `taskkill` or PID-enumeration fallback, because neither can prove a tree dead. It finds
  the root by searching for `pnpm-workspace.yaml` (12 ascents max), never by hop counting,
  and selects exactly one layout: `dist/windows-job-native/release/` in a checkout,
  `packages/runner/bin/` in an extracted artifact.
- `claude-launcher.ts` is an ordered gate chain: runtime re-observation, activation commit,
  the one-use grant, durable launch-lock preflight, then the OS-exclusive lock;
  `settleClaudeLaunch` owns the single exit. `%SystemRoot%` is injected there and only on
  the DEFAULT boundary port — the Bun host inside the installed Claude runtime will not
  start without it — and never enters the durable request.
- The Claude launch lock is a named pipe under `\\.\pipe\`, not a lock file, so a dead
  holder leaves nothing for a recycled PID to impersonate; the `.holder` sidecar under
  `%TEMP%/moe-claude-launch-locks` buys diagnosis back without being load-bearing. The
  bootstrap credential is handled only as a digest and never enters a refusal.
- Mirrors, not imports: `supervisor/effect-shape.ts`, `lease-mirror.ts` and
  `materialization/dependency-witness-mirror.ts` clone `@moe/scheduler` shapes because the
  dependency ran the other way when they were written. `fenceMirroredLease` RE-VALIDATES
  rather than casts (a fence that accepts what the authority rejects is a bypass), and no
  refusal there may name the lease token.
- `platform/linux-*` and `platform/macos/*` judge CALLER-SUPPLIED observations against a
  host the caller names. PROVEN means the observation is coherent — never that the process
  running the code is on that host.

## Gotchas

- `PROJECT_STACK_ENVIRONMENT_KEYS` in `windows-project-stack-boundary.ts` is an
  ALLOWLIST: the broker replaces the child environment with exactly these keys. A variable
  missing from that roster reaches the hosted daemon as nothing at all, silently — the
  documented way `MOE_NODE_TREES` was lost before it was listed.
- `src/index-surface.test.ts` hand-transcribes the root namespace: `EXPECTED_EXPORTS.length`
  is pinned at 276 and the key set must match exactly, so an unreviewed addition is as red
  as a deletion. It also pins `SURFACE_SOURCES.size === 7` and which surface module owns
  each of the ten `Codex*` Family B types.
- `src/runtime-entrypoint.test.ts` audits the `.js` bridges from a real child Node under
  `--experimental-strip-types`: exact bytes `export * from "./x.ts";\n` for every runtime
  module, and none for test-tier ones. Test tier is a CLOSURE, not a suffix —
  `supervisor/race-scenarios.ts` and `race-world.ts` have no bridge only because they
  import `effect-test-fixtures.js`. Add such an import to a bridged module and its bridge
  turns into an `unexpected` red.
- `tests/security/boundary-roster.security.ts` pins `"packages/runner": 23` and names all
  23 rows by constant and file. Any new column-0 `export const *_LAYER(S)|BOUNDARIES` here
  reds the security lane until both sides move.
- The broker binary is never vendored (`dist/` is git-ignored), so a fresh worktree fails
  `windows-boundary.test.ts`, the smoke, the launch and the criterion suites. Build it with
  the line quoted verbatim in `windows-broker-path.ts`. The toolchain is pinned three ways:
  `native/rust-toolchain.toml` (1.96.0), the committed `native/Cargo.lock`, and
  `windows-sys = "=0.61.2"` — the leading `=` is what forbids 0.61.3.
- `windows-frames.test.ts` regexes `PROTOCOL_VERSION`, `FRAME_HEADER_BYTES` and
  `MAX_*_PAYLOAD` out of the Rust sources and compares them. Moving a constant on one side
  only reds there, by design.
- `platform/platform-contract.ts` sits at the 250-line cap AGENTS.md sets; the Windows
  codes live in their own `windows-process-contract.ts` because of it, not by accident.
- `MOE_TEST_APPROVED_BROKER` is not production configuration — it exists only inside
  `criterion-check-executor.test.ts`'s mock of `resolveBrokerBinary`.

## Testing

- One file, from the repo root:
  `pnpm vitest run packages/runner/src/supervisor/effect-lifecycle.test.ts`. The root
  config covers `packages/**` with `environment: "node"`, the forks pool and 2–8 workers.
- Whole folder: `pnpm --filter @moe/runner test`, which is
  `vitest run --root ../.. packages/runner/src` — the same root config, not a local one.
  81 test files. Typecheck alone: `pnpm --filter @moe/runner typecheck`.
- The Rust tests (`native/tests/*.rs`, `native/broker/tests/*.rs`) are run by no pnpm
  script; CI only `cargo build --locked --release`s the broker.
- Outside coverage: `pnpm test:security` (`boundary-roster`, `runtime-provider-launch`,
  `runtime-provider-evidence`, `runtime-provider-supervision-cases`,
  `recent-core-contract-hostile-cases`); `pnpm test:fault`, whose lane runs `*.fault.ts`
  one file at a time and which the root gate never discovers
  (`tests/fault/{linux,macos}/effect-conformance.fault.ts`, `tests/fault/cross-host/*`);
  `pnpm test:e2e` (`tests/e2e/foundation/j3-crash-recovery.e2e.test.ts`);
  `tests/integration/portability/provider-shadow-matrix.test.ts`; and the whole daemon
  suite for every seam listed above.
- The cross-host Windows CI lane builds the broker, then runs `pnpm test` with
  `VITEST_MAX_WORKERS: 1` and asserts a positive "Test Files N passed" line, because
  `vitest run` exits 0 when it matches no file.
