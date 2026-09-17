# tests/e2e

The two end-to-end lanes, and the only place in the repo allowed to kill a real process on
purpose. `foundation/` certifies the Foundation Preview journeys (J1, J3, J4, hostile-client,
release-handoff) by spawning the SHIPPED entrypoints — `daemon-main.ts`, `demo-seed-main.ts`,
`agent-wrapper-main.ts` — as real OS children. `control-room/` drives a Chromium browser, either
against a statically built bundle with no daemon or against a real daemon plus a real Vite dev
server. Nothing here is part of the system under certification, and nothing here may be imported
by it.

## Seams

- **Outward: none, by assertion.** `foundation/e2e-harness.test.ts` ("is imported by no package,
  app, or adapter source") walks `packages/`, `apps/` and `adapters/`, tokenizes each file with
  the TypeScript scanner so a doc comment is not a dependency (`mentionsHarnessDependency`), and
  fails on any surviving mention of `e2e-harness` or `tests/e2e/foundation`. Production files
  name this folder only in comments — `apps/daemon/src/preview/preview-process.ts`,
  `deployment/deploy-candidate-environment.ts`, `v2/ops/activation-port.ts`.
- **Foundation run scaffolding:** `withE2eRun` / `createE2eRun` / `finishE2eRun`
  (`e2e-harness.ts`); `spawnHarnessProcess`, `adoptHarnessProcess`, `killAtDeclaredBoundary`
  (`e2e-process.ts`); the real-process fixtures `createJ1Scratch`, `prepareDaemonLaunch`,
  `startDaemon`, `runSeed`, `runRealAgentWrapper`, `readyDaemonOrigin` (`j1-loop-harness.ts`);
  `resolveAgentCredential` / `credentialProvenance` (`agent-credential.ts`).
- **Browser lanes:** `withStaticControlRoom(createStaticControlRoomPorts(), body)` (`harness.ts`
  is pure ports, `static-ports.ts` is the effects) and `withDaemonBackedControlRoom(options,
  body)` plus `mintLaneOperatorSeat`, `lanePids`, `readWireProtocolVersion` (`daemon-ports.ts`,
  process mechanics in `daemon-children.ts`). `wrapper-lane.ts` adds a real
  `agent-wrapper-main.ts` on top of a lane; `lane-landing.ts` drives a real landing receipt.
- **Pinned from outside:** `tests/integration/release/release-version-surfaces.test.ts` reads the
  scope-freeze version out of `control-room/journey-coverage.ts`;
  `tests/security/lane-smoke.security.ts` pins `test:e2e` and `test:e2e:browser` in the root
  script roster; `tests/integration/release/release-workflow-contract.test.ts` pins the two CI
  gate steps verbatim (`.github/workflows/reusable-windows-candidate-build.yml`).

## The model

- **Two lanes, disjoint BY FILENAME.** The root `vitest.config.ts` includes
  `tests/**/*.test.ts`; `control-room/playwright.config.ts` sets `testMatch: "*.spec.ts"`. So
  every `*.test.ts` in BOTH directories runs in the Node lane (`pnpm test:e2e`, and also plain
  `pnpm test`), and the browser never collects one. That is why the ledger guards are
  `journey-coverage.test.ts`, not `.spec.ts`: their arithmetic should fail in milliseconds.
- **Not a workspace package**, so `pnpm typecheck` never sees it. `test:e2e` runs
  `tsc -p tests/e2e/foundation/tsconfig.json` first, `test:e2e:browser` runs the control-room
  one; each `include` is `./*.ts` only, so the two directories are typechecked separately and
  only by their own lane.
- **Foundation determinism is enforced by text scan.** `E2E_SEED` is frozen literals,
  `deterministicId` pads an ordinal, `createLogicalClock` counts ticks from
  `2026-01-01T00:00:00.000Z` and throws once a logical day is exhausted. `e2e-harness.test.ts`
  substring-scans every non-`*.test.ts` module in `foundation/` for four wall-clock/random
  needles; spelling one out even inside a comment reds it (see the headers of
  `agent-credential.ts` and `j1-loop-harness.ts`, which refuse to name them). Waits are bounded
  by POLL COUNTS instead — `ORPHAN_REAP_POLLS = 200` in `orphan-reap.ts`.
- **Kills are declared, once, and typed.** `DECLARED_BOUNDARIES` (AFTER_PROCESS_READY,
  AFTER_PLAN_APPROVED, AFTER_EFFECT_ACTIVATED, AFTER_RECEIPT_COMMITTED, BEFORE_FINAL_ACCEPTANCE)
  and `KILL_TARGETS` (agent, runner, daemon) are frozen; `killAtDeclaredBoundary` returns
  `E2E_UNDECLARED_BOUNDARY` or `E2E_PROCESS_ALREADY_KILLED`, and THROWS on a handle
  `spawnHarnessProcess`/`adoptHarnessProcess` did not produce. `withE2eRun` runs cleanups newest
  first, never stops at a failure, and raises `E2E_CLEANUP_FAILED` with the body error as
  `cause`.
- **Every spawned daemon gets its own `MOE_PROJECT_ROOT`**, a git-initialised scratch with its
  own HEAD. Sharing the checkout sends every daemon's backups to one `.moe-next/backups` and
  refuses `ACTIVATION_BACKUP_FAILED`; a non-repository root trades that for
  `ACTIVATION_REPOSITORY_UNMEASURED`. `e2e-harness.test.ts` asserts the root per scratch AND
  against `REPOSITORY_ROOT`.
- **Static browser lane:** `harness.ts` holds only injected ports, so
  `E2E_BUNDLE_BUILD_FAILED` / `E2E_SERVER_BIND_FAILED` / `E2E_READINESS_TIMEOUT` /
  `E2E_CLEANUP_FAILED` and the 30 s `READINESS_BUDGET_MS` are provable without a browser
  (`harness.test.ts`). `static-ports.ts` runs the real `pnpm --filter @moe/control-room build`
  and serves `apps/control-room/dist` from an ephemeral port with an explicit content-type map
  and deliberately NO SPA fallback. It attaches no daemon; green here certifies presentation
  only.
- **Daemon-backed lane:** `daemon-ports.ts` starts `daemon-main.ts --port=0`, optionally the
  shipped `demo-seed-main.ts`, then the real Vite dev server, each with its own budget
  (`DAEMON_READY_BUDGET_MS` 60 s, `SEED_BUDGET_MS` 90 s, `SERVER_READY_BUDGET_MS` 60 s) and its
  own code: `E2E_REPO_ROOT_UNRESOLVED`, `E2E_DAEMON_SPAWN_FAILED`, `E2E_DAEMON_READY_TIMEOUT`,
  `E2E_SEED_REFUSED`, `E2E_SERVER_READY_TIMEOUT`, `E2E_TEARDOWN_ORPHAN`. A body failure
  re-throws; only a SUCCESSFUL outcome is overwritten by a surviving child.
- **Lane identities are minted per run** from the scratch directory's own suffix (`nodeRef`,
  `projectId`), so an assertion can tell real daemon data from the committed fixture corpus — a
  fixed id would make the positive arm pass against fixtures. `seed: "NONE"` is the only mode in
  which the browser's own clicks commit the chain; `operatorChannel: true` adds `--operator-stdin`
  and exposes `approvePairing`.
- **Doubles are named, minimal, and injected at the daemon's `--dependencies=` seam**, never by
  patching a module: `fake-gh-dependencies.ts` replaces only the `gh pr create` spawn,
  `fake-docker-dependencies.ts` only the deploy spawns, `fixed-demo-goal-dependencies.ts` the
  demo authority identity. The one other double is the SEAT (`wrapper-lane.ts`,
  `lane-landing.ts`, and the launcher in `live-proof-seat.ts`) — everything downstream of its
  exit is the shipped wrapper.
- **The honesty ledgers are the gate.** `journey-coverage.ts` enumerates spec section 12's
  twenty scenarios, each COVERED (with a bar and on-disk production files) or UNKNOWN with a
  distinct cause — `SURFACE_ABSENT`, `SURFACE_NOT_COMPOSED`, `NO_DAEMON_BACKED_BROWSER_LANE`,
  `REFERENCE_MACHINE_UNDEFINED` — a missing input and an owner. `journey-invariants.ts` is the
  second axis (the seven DoD-2 invariants). `daemon-lane-ledger.ts` records what the lane
  `proves` and `doesNotProve`, and its `journeyTitle` is checked against the spec's own `test()`
  opener. `foundation/journey-spec.ts` transcribes design quotes and line numbers BY HAND.

## Gotchas

- **`pnpm test` runs this folder.** Every real-process foundation journey is inside the root
  gate, which is why the expensive arms are opt-in env flags and why an opt-in that IS set never
  skips: `MOE_CANARY_LIVE_AGENT=1` (real `claude -p`, fails if no credential resolves),
  `MOE_PLATFORM_PIPELINE=1` (real docker; fails with `DEPLOY_DOCKER_UNAVAILABLE:` if absent),
  `MOE_E2E_RELEASE_REMOTE_TEST=1` + `MOE_E2E_RELEASE_REMOTE_URL`, `MOE_LIVE_RELEASE_PR=1`.
- **One `.js` bridge exists here and only one:** `control-room/fake-gh-contract.js`. It is needed
  because a REAL spawned daemon child loads `fake-gh-dependencies.ts` and resolves its `./x.js`
  specifier on disk. A module only vitest/Playwright imports needs no bridge.
- `fake-gh-dependencies.ts` reads `MOE_STORE_PATH` **at module load** and throws
  `STORE_DEPENDENCIES_ENV_MISSING` the moment Playwright merely collects a spec that imports it.
  Import values from `fake-gh-contract.ts`; `daemon-ports.ts` imports the docker double's mode as
  a TYPE for the same reason.
- **This directory's tsconfig cannot reach `packages/` (TS6059)**, so
  `readWireProtocolVersion` dynamic-imports the generated pin by URL instead of importing
  `@moe/control-room-client`. The mirror image also holds: `apps/daemon` cannot import these
  helpers, which is why `preview-supervisor.test.ts` re-implements `awaitPidGone`.
- **Windows process facts.** `killTree` uses `taskkill /t /f` and then confirms through the
  handle's own exit plus `tasklist`; a killed pid stays visible for 68–100 ms (measured in
  `orphan-reap.ts`), so an orphan assertion must wait on `pidReaped` rather than probe liveness
  straight after the kill. Vite wraps the port DIGITS in SGR escapes, hence `stripAnsi`.
- A literal `"a".repeat(40)` sha names no git object and makes publish/integration readers refuse
  for the wrong reason — use `lane.workspaceSha`, which is the sha the lane really committed.
- `release-approval.spec.ts`'s default case proves only `PUBLISH_APPROVAL_REQUIRED`; passing it
  is explicitly NOT evidence for the positive browser release journey
  (`control-room/release-approval.md`).
- Playwright: `forbidOnly`, `workers: 1`, `retries: 0`, 180 s timeout, and no `webServer` block —
  the lifecycle is owned by `static-ports.ts` / `daemon-ports.ts` so refusals carry this lane's
  own codes. Run artifacts land in `control-room/test-results/` (gitignored there, not at root).

## Testing

- Whole Node lane: `pnpm test:e2e` (typechecks `foundation/`, then `vitest run tests/e2e` — this
  also runs the `control-room/*.test.ts` ledger guards).
- One Node file, from the repo root: `pnpm vitest run
  tests/e2e/foundation/j3-crash-recovery.e2e.test.ts`.
- Whole browser lane: `pnpm test:e2e:browser` (typechecks `control-room/`, then Playwright).
- One spec: `pnpm exec playwright test -c tests/e2e/control-room/playwright.config.ts
  daemon-board.spec.ts`, narrowed further with `-g "<test title>"`.
- Outside coverage: both lanes are CI gate steps in
  `.github/workflows/reusable-windows-candidate-build.yml`, and the censuses named under
  **Seams** red when a script, a workflow step or the coverage ledger's version moves.
