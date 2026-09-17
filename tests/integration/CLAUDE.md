# tests/integration

The only lane that joins `apps/**` to `packages/**` and `tools/**` in one process. The root
`pnpm test` gate does not discover `apps/**` and the daemon's own suite does not discover the
control room, so a claim of the form "the browser's reading of the daemon's answer agrees with
the daemon", "the INSTALLED bin commits the same decision as the in-process handler", or "what
`pack:windows` would stage still resolves" is provable only here. Nothing in this folder
implements a predicate: every verdict is produced by a production function and these suites
compare bytes.

## Seams

- No `package.json` and no vitest config of its own — `tests/` is not a pnpm workspace member
  (`pnpm-workspace.yaml` globs `apps/*`, `adapters/*`, `packages/*`).
- The lane is root `package.json` → `test:integration`: `typecheck:packaging`,
  `typecheck:import`, `vitest run tests/integration`, then one `node --test` naming all four
  `.test.mjs` harnesses. `verify:release` wraps it with `typecheck:release` and
  `release:evidence`.
- `.github/workflows/cross-host.yml` job `portability-evidence` runs those same legs on three
  hosts, then a separate **Per-matrix executed counts** step reruns `portability/` with
  `--reporter=json` and refuses unless each of seven named files reports a positive passed
  count — an aggregate total cannot show that each matrix executed.
- The `.test.ts` half is ALSO in the root gate: `vitest.config.ts` includes `tests/**/*.test.ts`,
  so `pnpm test` runs all of it, 900 s matrices included. The `.test.mjs` files are not.
- Nothing imports this folder. It imports everything: bare `@moe/{contracts,core,daemon,import,
  jetbrains-adapter,mcp,runner,store}`, and deep relative paths for the rest.

## The model

- **Bare specifiers resolve at the repo root for exactly eight packages.** pnpm links workspace
  deps into each *consuming* package's `node_modules`, never the root; the root `dependencies`
  block is the only reason `@moe/store` imports here. `@moe/scheduler`, `@moe/skills`,
  `@moe/control-room-client`, `@moe/review`, `@moe/context` and `@moe/coordination` are absent
  from it, which is why `expansion-protocol.test.ts` reaches core and scheduler by relative path
  and then polices that choice with a guard at the bottom of the file: the only two non-stdlib
  specifiers permitted are the two package ROOT entries, so a symbol the barrels do not export
  is unreachable here exactly as it is for a real consumer.
- **Sibling helpers are imported with a `.js` specifier and there are no `.js` bridges here.**
  Vitest rewrites `./portability-harness.js` back to the `.ts`; nothing in this folder sits in
  the daemon's runtime module graph, so the repo-wide bridge rule does not apply. Deep reaches
  into `apps/**` use both spellings (`bootstrap-test-fixtures.ts`, `http-contract.js`).
- **Refusal vocabulary is pinned, never spelled.** `portability/portability-cases.ts` exports
  `pin(name, owner, where)`, which throws at MODULE LOAD when the owning package stopped
  publishing the code — a rename reddens the import instead of leaving an assertion against a
  string nothing emits. Owners: `HTTP_BOUNDARY_ERROR_CODES`, `PREREQUISITE_REFUSAL_CODES`,
  `HTTP_REFUSAL_STAGES`, `SERVICE_REFUSED_BY` (`@moe/daemon`), `DISTRIBUTION_REFUSAL_REASONS`
  (`@moe/contracts`), and `IdempotencyConflictError().code` lifted off the class that raises it.
- **Checkout identity is captured once per process.** `portability-source-commit.ts` runs real
  `git` at import time with every `GIT_*` stripped and `GIT_CONFIG_GLOBAL=NUL`, then exports the
  frozen `PORTABILITY_SOURCE_COMMIT`; an unproven checkout throws `<CODE>@PORTABILITY_EVIDENCE`.
  Codes live in `portability-source-contract.ts` (`..._ABSENT`, `..._MALFORMED`,
  `..._CHECKOUT_DIRTY`, `..._CHECKOUT_MISMATCH`, `..._REPOSITORY_MISMATCH`, `..._PIN_UNREADABLE`,
  `..._OBSERVATION_FAILED`). Under `MOE_PORTABILITY_EVIDENCE_MODE=1` it additionally demands
  `MOE_PORTABILITY_SOURCE_COMMIT` and an absolute `MOE_PORTABILITY_GIT_EXECUTABLE`, and proves
  cleanliness by building a scratch bare repo outside the checkout and comparing `write-tree`
  against `HEAD^{tree}` — `git status` alone is not trusted. Declared vs observed disagreement
  is a refusal, never a pick.
- **`portability-evidence-pin.json` is a sealed historical receipt** read only through the
  Git-independent `portability-historical-receipt.ts`. Its `truthClass` is `UNKNOWN` even when
  `claimState` is `SEALED`, and a null `externalRun` means UNKNOWN external evidence, never a
  pass. Its `$comment` array carries the provenance argument (a pin cannot name its own commit)
  and records the open macOS per-matrix attribution gap.
- **`portability-harness.ts` owns process lifecycle and nothing semantic** — no assertion, no
  expected code, no case table. Subjects are reached through `node_modules/.bin` (the `.CMD`
  shim on Windows, quoted because `cmd.exe` splits on spaces); `splitFrames` is the same
  CR-tolerant function the live stdio client feeds; `killTree` closes stdin first and only then
  `taskkill /PID … /T /F`, because killing the shim first re-parents node beyond any PID held;
  `removeWorkspace` THROWS, so a leaked child is a measured failure rather than residue.
  Workspace directories are named `moe portability-…` with a deliberate space.
- **The shadow matrices decide nothing.** `shadow-matrix-cases.ts` fences the row shape and the
  closed `provenance` classes — `CONSTRUCTION` is not a launch, `REQUEST_REFUSAL` is not
  `CONSTRUCTION`, `NOT_EXERCISED` is not `ABSENT_CALL_SITE`; `shadow-matrix-arms.ts` lifts every
  reason code off the shipped surface's own answer and imports no `node:child_process`.
  EXECUTION portability is `UNKNOWN` for both providers by design. `shadow-corpus-harness.ts`
  captures digest, size AND mtime for every corpus entry, because mtime is the only signal of
  an accidental write-mode open.
- **Stores open `openForProject` / `openEphemeralForProjectTest`.** A handle opened with plain
  `open` refuses every commit with `PROJECT_SCOPE_REQUIRED`, which a shadow or import suite
  would misread as a verdict.

## Gotchas

- **`portability/tsconfig.json` and `import/tsconfig.json` are invoked by nothing.** `pnpm
  typecheck` is recursive over workspace members and `tests/` is not one. A type error in
  `shadow-matrix-arms.ts` stays green on every gate. Run `npx tsc -p
  tests/integration/portability/tsconfig.json --noEmit` by hand.
- **Two harnesses share a basename one path segment apart**: `release-supply-chain.test.mjs`
  (2193 lines, at the folder root) and `release/release-supply-chain.test.mjs` (153 lines, the
  forged-pnpm harness). The nested one went unrun from the day it was written. Three places now
  pin the set: `release/mjs-lane-coverage.test.ts` (set equality in BOTH directions plus
  `discovered.length === 4`), and `release/release-workflow-contract.test.ts` against both
  cross-host legs and the package lane. A new `.test.mjs` here reds all three until it is listed
  in `package.json` *and* in both workflow gates.
- **`release/release-version-surfaces.test.ts` is the heaviest hand-mirrored census.** It pins
  `EXPECTED_JS_MANIFESTS.length === 20`, two Cargo manifests, `RELEASE_VERSION_SURFACES.length
  === 13` over nine reviewed files, and exclusion counts 17/25. It shells `git ls-files -z`,
  subtracts `--deleted`, and scans every tracked UTF-8 text file for the current version literal,
  refusing an unclassified occurrence *and* a stale exclusion. Adding a workspace package, or
  writing the version string into any tracked file, reds it.
- **Non-Windows is predictably red at the end of the lane.** `scripts/release/supply-chain.mjs`
  refuses `SUPPORTED_OS_EVIDENCE_MISSING@RELEASE_SUPPLY_CHAIN` when `platform !== "win32"`, and
  `release/release-supply-chain.test.mjs` hardcodes `C:\Program Files\Git\cmd\git.exe`,
  `powershell.exe`, `tar.exe` and `where.exe`. Disclose it; do not report raw green.
- **`control-room/control-room-transport.test.ts` passes only because of one line**:
  `vi.useFakeTimers({ toFake: ["Date"] })`. The daemon and the in-process handler each take
  their own `DEFAULT_SEAM_OBSERVER.now()` reading, so the whole-payload `toEqual` can only
  agree inside a millisecond. `toFake: ["Date"]` is load-bearing — a bare `useFakeTimers()`
  also fakes `setTimeout` and HANGS the real loopback round trip instead of failing it.
- **Timeouts are per case, not config**: `transport-host-matrix` 900 s,
  `portability-source-commit` 300 s, `goal-brief-mcp-readback` 180 s, the three control-room
  journeys 120 s. Only `release-archive-cleanup.test.ts` raises a whole file
  (`vi.setConfig({ testTimeout: 30_000 })`), and its header explains why it is not larger: a
  spawn-latency cliff must fail loudly as the host problem it is, not become a slow green.
- **`release-supply-chain.test.mjs` imports `.ts` modules directly** — e.g.
  `tools/packaging/pack-tool-identity.ts` — under `node --test`, relying on Node 24 type
  stripping; there is no build step.
- `distribution/pack-artifact-sweep.test.ts` judges the prune rules against the REAL workspace
  tree with a `TEST_VOCABULARY` matcher deliberately broader than, and not derived from, the
  production suffix list — the first release shipped 25 test artifacts past a gate whose
  single case passed.

## Testing

- One file: `pnpm vitest run tests/integration/release/mjs-lane-coverage.test.ts` (root config,
  `environment: "node"`; measured 237 ms).
- The `.ts` half: `pnpm vitest run tests/integration`. One node:test harness:
  `node --test tests/integration/release-supply-chain.test.mjs`.
- Whole lane, as CI runs it: `pnpm test:integration` (adds both typechecks and the four
  `node --test` harnesses). `pnpm verify:release` is that plus `typecheck:release` and
  `release:evidence`.
- Outside coverage: `pnpm test` executes every `.test.ts` here, and
  `.github/workflows/cross-host.yml` runs the lane on ubuntu/macos/windows plus the per-matrix
  count step.
- Typecheck the two orphaned projects by hand:
  `npx tsc -p tests/integration/portability/tsconfig.json --noEmit` and the same for `import/`.
