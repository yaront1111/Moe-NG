# tests/security

The hostile-caller lane. It is the only place that answers "does every production module
that names a refusal layer actually refuse forged, stale, replayed and racing input at that
layer?" — and the only place keeping the *enumeration* of those layers honest. Three legs:
`boundary-roster.security.ts` proves the hand-written roster equals a live source scan both
ways, the five axis slices drive real production surfaces with hostile input, and
`completeness.security.ts` proves every roster entry resolved to an executed BEFORE, AFTER and
RACE case. Collecting this lane confers no security PASS of any kind.

## Seams

- It is **not a workspace package** — no `package.json`, so `pnpm --recursive typecheck` never
  reaches it. `pnpm test:security` is the only gate: `tsc -p tests/security/tsconfig.json`
  (include `./**/*.ts`, so it typechecks the production modules the lane imports too) and then
  `vitest run --config tests/security/vitest.config.ts`.
- Dependencies run one way: the lane imports production (217 specifiers into `apps/daemon`, 64
  into `packages/runner`, 47 `packages/core`, 23 `apps/control-room`, plus store, scheduler,
  benchmark, contracts, mcp, import, coordination, ide-contract, one `tools/import`). Nothing
  under `packages/**` imports this folder.
- The daemon consumes the lane as **paths and bytes, not modules**:
  `apps/daemon/src/cutover/v2-readiness-evidence-producers.ts` declares
  `SECURITY_ROSTER_PATH = "tests/security/boundary-roster.security.ts"` and re-implements the
  roster-row regex and the receipt shape; `v2-readiness-evidence-collector-main.ts` takes
  `--security-out=<dir>`, which is what `MOE_SECURITY_EVIDENCE_OUT` makes teardown populate with
  the receipts and a `security-run.json` naming the run id (the lane credits nothing from it).
- `tests/integration/release/release-version-surfaces.test.ts` pins a version string inside
  `integrity-hostile-cases.ts` (`integrity-hostile-activation-claim`).
- `lane-smoke.security.ts` imports the real `../fault/vitest.config.js`, `../../vitest.config.js`
  and the root `package.json`, and pins `test:security`, `test:fault` and `test:integration`
  byte-for-byte — editing those scripts reds this lane.
- Dozens of production modules cite `boundary-roster.security.ts` in their own doc comments to
  explain why a layer constant is deliberately module-private or spelled `_LAYER_NAMES`
  (`apps/daemon/src/planning/approval-intent.ts` is the clearest one).

## The model

- **The suffix is the collection rule.** The lane includes `**/*.security.ts` and explicitly
  excludes `*.fault.ts`, `*.test.ts`, `*.spec.ts`, with `passWithNoTests: false`. Shared
  machinery therefore must *not* carry the suffix: `hostile-harness.ts`,
  `runtime-provider-ledger.ts`, `runtime-provider-invariants.ts`, `layer-visibility-cases.ts`
  and every `*-hostile-cases.ts` table would otherwise register as an empty suite and fail.
- **Serial, forked, unshuffled.** `pool: "forks"`, `isolate: true`, `fileParallelism: false`,
  `maxConcurrency: 1`, `retry: 0`, `allowOnly: false`. `SecurityLaneSequencer` orders by
  UTF-16 code unit on a separator-normalised module id (never `localeCompare`) and forces
  `completeness.security.ts` last so it can read every earlier slice's receipt.
- **The roster is hand-written and source-compared.** `BOUNDARY_ROSTER` is 180 entries;
  `EXPECTED_ROSTER_SIZE = 180`, `EXPECTED_DISTRIBUTION` splits them per area
  (`apps/daemon: 90`, `packages/runner: 23`, …). The scan is `DECLARATION_PATTERN`
  `/^export const ([A-Z0-9_]+(?:LAYERS|LAYER|BOUNDARIES))\s*(?::[^=]+)?=/u` over `SCAN_ROOTS`
  `["apps", "packages", "adapters"]`, filtered by `isProductionModule` (drops `.test.ts`,
  `.spec.ts`, `.test-fixtures.ts`, `-fixtures.ts`, `packages/testkit/`), rooted by searching
  upward for `pnpm-workspace.yaml`. Cardinality and distribution are asserted *separately* from
  set equality, because equality passes vacuously against a silently narrowed scan.
- **Each entry is tagged with one of five axes by SUBJECT, not directory**: `transport`,
  `integrity`, `durable-store`, `runtime-provider`, `scheduler-activation`. Where the two
  disagree the subject wins (four `apps/daemon/src/recovery/` constants are `integrity`).
- **`layer-visibility-cases.ts` measures what the roster cannot see**: `EXPECTED_PRIVATE_COUNT =
  82` column-0 `const *_LAYER` declarations no `^export const` anchor reaches,
  `EXPECTED_LITERAL_COUNT = 106` bare literals at refusal sites of which
  `EXPECTED_UNRESOLVED_LITERAL_COUNT = 37` resolve to no declaration, and the invisible share
  pinned as 82/262 = 313 per mille. Its arms are named `TASK-LV …` and live in the roster file.
- **The ratchet enumerates tables, never constants.** `completeness.security.ts` imports the
  sibling case tables, normalises four different shapes (`arm` on transport/integrity/scheduler
  rows, `phase` on durable-store, no field at all on the scheduler race tables), reads the
  roster **as text** with `ROSTER_ROW`, and asserts: every roster entry has all three arms,
  roster-minus-union and union-minus-roster are empty, no constant is claimed by two axes, and
  the axis subset sizes sum to the roster size. A literal list of covered constants is banned
  by design.
- **The runtime-provider axis crosses forks with run-scoped receipts.** `lane-global-setup.ts`
  mints a `securityRunId` and a `securityReceiptsDir` under `tmpdir()` and deletes it at
  teardown; `createLedger()` (`runtime-provider-ledger.ts`) writes one receipt per slice file in
  `afterAll`; `resolveExecutedCoverage` reports seven stable `SECURITY_COVERAGE_*` diagnostics
  (missing slice receipt, duplicate boundary claim, foreign run, missing arm, …). Only a case
  Vitest actually executed earns credit.
- **Every refusal is asserted by code AND layer.** `assertRefusedWith(actual, {code, layer})`
  makes the layer non-optional at the type *and* at runtime; `readRefusal` accepts
  `code`/`reasonCode` and `layer`/`reasonLayer`/`refusedBy` and interprets none of them. The
  expected layer is read off the boundary's own exported constant via `layerOf(declared, name)`.
- **Slice-wide invariants, not per-case spot checks.** `describeSliceInvariants` asserts the
  slice sweeps exactly its `RUNTIME_PROVIDER_PARTITION` group both ways, a positive count per
  boundary *and* arm, `assertAdmittedNothing` (nothing admitted, no `truthClass === "PROVEN"`,
  and a pinned count of truth-bearing outcomes so the sweep cannot go vacuous), and
  `assertMessagesEchoNothing` (no drive path, posix path, hex digest, base64 blob or hostile
  input value in any refusal message). `admitted` and `truthClass` are *derived* from the value
  production returned — an earlier revision hard-coded `admitted: false` and the invariant could
  not fail for any mutation.
- **Every wait is bounded.** `probeBefore` / `probeAfter` / `probeRacing` take a
  `{timeoutMs, label}`; `MAX_BOUND_MS` is 2147483647 and a wider bound is *refused*, not clamped
  (`setTimeout` would turn it into 1 ms). `RUNTIME_BOUND` is 2 s. `probeRacing` reports both legs
  and which settled first rather than propagating a rejection.

## Gotchas

- **`durable-store-boundaries.security.ts` imports `BOUNDARY_ROSTER` directly**, so the roster
  module's suites re-register inside that fork: the roster alone reports 55 tests, the
  durable-store slice reports 206 and 55 of them are the roster's. Every other slice parses the
  roster's committed bytes with a regex precisely to avoid this — and several of their headers
  still claim "`BOUNDARY_ROSTER` is not exported", which stopped being true.
- **Prose counts in this folder rot, and the roster header says so itself.** The roster tags 33
  `runtime-provider` entries and `RUNTIME_PROVIDER_PARTITION` has five groups summing to 33, but
  the runtime slice headers still say "thirty-one entries" and "the four runtime-provider
  slices". Trust the assertion that owns a number, never a comment quoting it.
- **`completeness.security.ts` cannot be run alone.** It reads the receipts directory at module
  scope and expects one receipt per `runtime-provider-*.security.ts` file found on disk; with no
  sibling slices executed it reds on `SECURITY_COVERAGE_MISSING_SLICE_RECEIPT`.
- **`lane-receipts.test.ts` is not in this lane.** The `.test.ts` suffix is excluded here and
  matched by the root config's `tests/**/*.test.ts`, so a `lane-receipts.ts` change is re-run
  under `pnpm test`, not `pnpm test:security`.
- **`boundary-roster.security.ts` and `layer-visibility-cases.ts` import each other.** The cycle
  is only safe because every scan stays inside a function body; a module-scope
  `const X = scanPrivateLayerDeclarations()` hits the temporal dead zone on `findRepoRoot`.
- **Adding or renaming a production layer constant reds this folder.** A new column-0
  `export const *_LAYER(S|BOUNDARIES)` needs a roster row, a bump to `EXPECTED_ROSTER_SIZE`, its
  `EXPECTED_DISTRIBUTION` key, an axis tag and three hostile arms; keeping it module-private
  instead moves `EXPECTED_PRIVATE_COUNT` and the invisible-share pin.
- **A gate renamed out of the `.security.ts` suffix keeps typechecking and stops running.** The
  roster's last describe exists only to assert `completeness.security.ts` exists, ends in
  `.security.ts`, resolves every axis and names the roster file.
- **Windows and macOS quirks are load-bearing.** `cleanupHostileRoots` retries `rmSync` five
  times at 100 ms because a post-`close()` SQLite handle fails EPERM (52 abandoned roots across
  13 runs, measured 2026-08-20); `hostileRoot` realpaths `tmpdir()` because macOS `/var` is a
  symlink and a containment check reads the unresolved form as an escape;
  `openWindowsProcessBoundary`'s `DEFAULT_TIMEOUT_MS` is 30 minutes, so the one case opening a
  session passes an explicit bound. With `fileParallelism: false`, one unbounded wait stalls
  every file after it and reports no verdict at all.

## Testing

- Whole lane, from the repo root: `pnpm test:security`; CI runs it on both the posix and the
  windows leg of `.github/workflows/cross-host.yml`.
- One file: `pnpm vitest run --config tests/security/vitest.config.ts boundary-roster` — a
  substring filter, since the config's `root` is `tests/security`. Add `-t "<case name>"` for one
  case; the global setup still runs either way, so receipts work.
- Expect slow imports, not slow tests: `durable-store-boundaries` alone takes ~33 s, ~23 s of it
  module import and transform.
- Outside coverage: `pnpm test` runs `lane-receipts.test.ts`;
  `tests/integration/release/release-version-surfaces.test.ts` pins `integrity-hostile-cases.ts`;
  `tests/integration/release/mjs-lane-coverage.test.ts` explains what belongs there rather than
  in `lane-smoke.security.ts`; the daemon's V2 readiness evidence folds this lane's receipts.
