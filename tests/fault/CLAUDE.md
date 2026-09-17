# tests/fault

The hostile lane. It holds the suites that must be allowed to crash a real process, kill a
real daemon mid-write, or report "we were not on that host" — facts that would be worthless
as ordinary regression evidence and dangerous as a silent skip. Its job is to keep those
cases executable and named without letting them leak into `pnpm test`: the root config
discovers `*.test.ts` only, so the `*.fault.ts` suffix is the isolation mechanism. Nothing
here grades itself — every verdict is read off a production surface — and no file in this
tree may claim authority about a host it is not running on.

## Seams

- `vitest.config.ts` is imported as a real module by `tests/security/lane-smoke.security.ts`
  (`import faultConfig from "../fault/vitest.config.js"`), which pins `include` with
  `toStrictEqual` and asserts the serial-lane block field by field.
- `cross-host/effect-evidence-contract.ts` + `effect-evidence-verify.ts` are the protocol:
  `CROSS_HOST_ERROR_CODES` (12), `CROSS_HOST_LAYERS`, `CROSS_HOST_HOST_SLOTS`,
  `sealHostReceipt`, `verifyHostReceipt`, `aggregateHostReceipts`. Consumed by
  `cross-host/effect-evidence.fault.ts` and by `cross-host/cross-host-evidence.mjs`.
- `cross-host/effect-schedule-driver.ts` exports `CROSS_HOST_SCHEDULES`,
  `crossHostCaseUniverse`, `executingHostSlot`, `runHostSchedules`, `describeRun`,
  `writeRawSchedule` — the only seam `linux/` and `macos/effect-conformance.fault.ts` use.
- `foundation/foundation-harness.ts` is the lane's one bridge to production packages: the
  `packages/testkit/src/foundation/**` modules import `@moe/contracts` and nothing else, so
  `@moe/core`, `@moe/store` and `@moe/scheduler` arrive through `LIVE_EXPORT_SURFACES` here.
- `disaster-restore/disaster-harness.ts` and `landing-crash/landing-crash-world.ts` are
  fixture builders only; `landing-crash/landing-crash-child.ts` is an entry point executed
  by `node`, not imported by a suite.
- Bare `@moe/runner` / `@moe/daemon` / `@moe/store` resolve through the **root**
  `package.json` dependencies — `tests/` is not in `pnpm-workspace.yaml`.

## The model

- **Two collections, one lane.** `include` is `["foundation/**/*.test.ts", "**/*.fault.ts"]`
  with `**/*.security.ts` excluded. The foundation `.test.ts` files therefore run **twice**:
  here and in the root suite (`tests/**/*.test.ts`). The `.fault.ts` files run only here.
- **Deliberately boring runner.** `pool: "forks"`, `fileParallelism: false`,
  `maxConcurrency: 1`, `retry: 0`, `allowOnly: false`,
  `dangerouslyIgnoreUnhandledErrors: false`, `passWithNoTests: false`. `FaultLaneSequencer`
  sorts by UTF-16 over a separator-normalized `moduleId`; `localeCompare` is avoided on
  purpose so execution order cannot differ between machines.
- **Foundation is a ratchet, not a fixture.** `produceAbsenceOutcome` never echoes the
  declared outcome: it evaluates the entry's probe against the package's *live* export names
  and returns `passExpected()` the moment the surface exists, which reddens the row against
  its declared `PRODUCTION_BEHAVIOR_ABSENT`. `produceEvidenceOutcome` does the same for
  `HONEST_UNKNOWN` via a registered corpus. A red here usually means a capability **landed**.
- **Partitions are owned exactly.** `assertPartitionOwnership` compares each file's executor
  map with `foundationPartition("J1"|"J3"|"J4")` against `FOUNDATION_PARTITION_COUNTS`
  (`{ J1: 12, J3: 13, J4: 14 }`, in `packages/testkit/src/foundation/foundation-fault-schedule.ts`).
  A schedule cannot be dropped without a red.
- **Cross-host classifies evidence, never a platform.** Two layers refuse and are never
  spelled the same: `CROSS_HOST_COLLECTOR` refuses to *emit*, `CROSS_HOST_AGGREGATOR`
  refuses to *accept*. Every refusal assertion pins code **and** layer **and** `hostSlot`.
  The universe is 7 `PLATFORM_BOUNDARIES` × 3 schedules = `CROSS_HOST_EXPECTED_CASE_COUNT`
  21, and every generated sweep asserts its own cardinality so an empty generator cannot pass.
- **Off-host is an assertion, not a skip.** `linux/` and `macos/effect-conformance.fault.ts`
  are byte-identical apart from `SLOT`/`PLATFORM_LAYER`. Off-host they assert
  `CROSS_HOST_HOST_MISMATCH` at `CROSS_HOST_COLLECTOR`. The executing host comes from
  `collectDoctorVersionReport` plus `os.release()` — never a CI matrix variable.
- **`production-surfaces.fault.ts` polices its own bytes.** It reads
  `import.meta.url` back with `readFileSync` and asserts that no specifier is relative,
  contains `/src/`, or ends `.ts`, so a deep import cannot quietly repair a broken root edge.
- **The landing crash is a real SIGKILL.** `landing-crash-child.ts` runs one production
  landing pass; the development-only knob in
  `apps/daemon/src/orchestrator/landing-fault-injection.ts` kills it at `after-commit`.
  The control pass executes byte-identical code — only `MOE_FAULT_INJECT_LANDING` and
  `MOE_DEVELOPMENT_ONLY` differ. `landing-crash-world.ts` counts rows in
  `command_decisions` with raw SQL through `node:sqlite`'s `DatabaseSync`, because a store
  reader that returns the latest decision is structurally unable to see a duplicate.
- **Disaster-restore hand-writes its boundary tables** and set-compares them against
  `RECOVERY_ANCHOR_FAULT_POINTS` in both directions; a table derived from the enum cannot
  police the enum. Refusals pin the layer, because five can answer there
  (`RECOVERY_ANCHOR`, `RECOVERY_SUCCESSION`, `RECOVERY_INVENTORY`,
  `RECOVERY_INVENTORY_LEDGER`, `RECOVERY_COMPLETION`).

## Gotchas

- **`pnpm typecheck` never reaches this folder.** It is `pnpm --recursive typecheck`, and
  `tests/` is not a workspace package. The only typecheck is the `tsc -p tests/fault/tsconfig.json`
  leg of `test:fault` (and `foundation/tsconfig.json`, whose `include` is `./*.ts` — *not*
  recursive, so a new subdirectory under `foundation/` is typechecked by nothing).
- `pnpm --filter <pkg>` cannot reach anything here; run the lane from the repo root.
- `tsconfig.base.json` sets `allowImportingTsExtensions: false`, so relative imports are
  written `./x.js`. Only two real `.js` bridges exist —
  `cross-host/effect-evidence-contract.js` and `effect-evidence-verify.js` — and they exist
  for `cross-host-evidence.mjs`, which runs under plain `node`. That CLI is kept outside the
  TypeScript graph on purpose: it imports the untyped `scripts/release/release-subject.mjs`,
  which raises TS7016 from a `.ts` under this tsconfig.
- **Two outside censuses pin this folder.** `tests/security/lane-smoke.security.ts` pins the
  `test:fault` script string byte-for-byte and `vitest.config.ts`'s `include`/`exclude`
  arrays; `packages/testkit/src/foundation/foundation-gate-coverage.test.ts` pins the owned
  directories, the gate filters, the two tsconfig projects, and the literal
  `"tests/**/*.test.ts"` in the root `vitest.config.ts`. Both live in *other* lanes.
- A foundation ratchet red is fixed by updating the manifest entry in
  `foundation-fault-schedule.ts`, never by loosening the test — and it shows up in the root
  `pnpm test` run as well, so it reads as a "foreign red" to whoever is running that.
- `cleanupDisasterRoots()` must run in `afterAll`. A SQLite handle that outlives its file
  kills the vitest worker outright, and with `fileParallelism: false` that stalls every file
  queued behind it.
- `writeRawSchedule` prints `executedCaseCount=<n>` and writes under `$MOE_CROSS_HOST_RAW`.
  `.github/workflows/cross-host.yml` greps the literal `executedCaseCount=21` out of the log
  and reads the real vitest status from `PIPESTATUS[0]`, so renaming that line reds CI with
  a green vitest.
- Windows has no signals: the SIGKILLed landing child is observed as a nonzero status with a
  **null** signal. The cross-platform discriminator is the absence of
  `LANDING_PASS_RESULT_PREFIX` on stdout plus the knob's note on fd 2.
- `landing-crash/**` deliberately deep-imports `apps/daemon/src/**` by relative path;
  `disaster-restore/**` and `cross-host/**` forbid that for themselves. Do not copy one
  convention into the other.

## Testing

- Whole lane: `pnpm test:fault` (typechecks first, then the lane config). The Windows
  candidate build runs exactly this — `.github/workflows/reusable-windows-candidate-build.yml`.
- One file — the filter is relative to the **lane root**, not the repo root:
  `pnpm exec vitest run --config tests/fault/vitest.config.ts landing-crash/landing-crash.fault.ts`
- Typecheck only: `pnpm exec tsc -p tests/fault/tsconfig.json`
- A foundation file can also be run through the root config:
  `pnpm vitest run tests/fault/foundation/j1-linear.test.ts` (this is how the root suite
  sees it, and how to tell a lane-config problem from a real red).
- `git` on PATH and a Node with `node:sqlite` are required by `landing-crash/**`; the
  disaster and landing suites spawn children and write under `os.tmpdir()`.
- Outside coverage: `packages/testkit/src/foundation/foundation-gate-coverage.test.ts`
  (the gate-coverage ratchet), `tests/security/lane-smoke.security.ts` (the config and
  script pins), and `.github/workflows/cross-host.yml`, which runs only
  `linux|macos/effect-conformance.fault.ts` on real hosts plus
  `cross-host/effect-evidence.fault.ts` and `cross-host/production-surfaces.fault.ts` in the
  aggregate job. `node tests/fault/cross-host/exact-sha-evidence-gate.mjs <sha>` asks GitHub
  whether real Linux + macOS evidence exists for one exact commit; it ignores
  `run.conclusion` and requires the three named jobs and three artifacts in a single run.
