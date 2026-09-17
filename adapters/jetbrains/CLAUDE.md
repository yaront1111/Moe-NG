# @moe/jetbrains-adapter

The IDE end of the product: the only code a JetBrains plugin loads. It sequences the three
decisions `@moe/ide-adapter-contract` declares — discover a daemon, start one, open the
control room — and adds the three things that contract deliberately left out: a startup
distribution compatibility gate, reconnect, and uninstall. It renders nothing and
authorizes nothing. Every product action and every pixel comes from the standalone control
room reached through the opened endpoint; this package decides only whether opening it is
allowed, and reports the contract's verdict unchanged.

## Seams

- `package.json` publishes two subpaths: `.` → `src/index.ts` (the thin adapter) and
  `./host` → `src/host/jetbrains-host.js` (the composition). The asymmetry is real — the
  root points at the `.ts`, the host at its `.js` bridge.
- `createJetBrainsSession(ports, expectation)` → `JetBrainsSession`: `openControlRoom`,
  `endpoint`, `discoveryOutcome`, `startOutcome`, `uninstall`. `admitDistribution` and
  `JETBRAINS_REQUIRED_COMPONENT_KINDS` are re-exported from `jetbrains-distribution-gate.ts`
  so the root stays the whole public surface.
- `createJetBrainsHost(config)` → exactly four keys: `start`, `reconnect`, `endpoint`,
  `uninstall`. There is no command method, and that absence is asserted elsewhere.
- `src/host/jetbrains-host-ports.ts` is the only file here that touches the OS:
  `readInstalledDistributions`, `probeDaemon`, `startDaemon`, `openControlRoom`.
  `jetbrains-host-port-detail.ts` exports the one sanitizer, `codeOf`.
- Dependencies: `@moe/contracts` (distribution vocabulary) and `@moe/ide-adapter-contract`
  (IDE vocabulary). Nothing from `apps/` is reachable, and nothing outside this folder
  imports it as production code.
- The real outside callers are the packaging inventory
  (`tools/packaging/distribution-inventory.ts`, which ships this folder as the
  `ide-adapter-jetbrains` component) and `tests/integration/portability/portability-cases.ts`,
  whose `jetBrainsProbeSource()` imports `@moe/jetbrains-adapter/host` in a child Node
  process. The root `package.json` lists `@moe/jetbrains-adapter` as a dependency purely so
  that bare specifier resolves for that probe.

## The model

- **Two vocabularies, never re-coded into each other.** `JetBrainsResult` is
  `DistributionRefusal | IdeAdapterResult`; callers discriminate on `"ok" in result`. A
  distribution refusal never acquires an IDE reason code and an IDE verdict never acquires
  a distribution reason — `jetbrains-adapter.test.ts` narrows on that and throws if a
  scenario answers in the wrong vocabulary.
- **The gate runs first, before any port touches the daemon.** In `index.ts`'s `run()`,
  `ports.distribution.discoverDistributions()` and `admitDistribution` precede
  `probeDaemon`; a mismatch must reach zero of the other three ports.
- **`admitDistribution` verifies nothing.** Signature, digest and provenance belong to
  `verifyDistributionSet` in the packager/startup authority; cloning that rule here is the
  fork the boundary exists to prevent. It answers only "can THIS adapter build talk to the
  distribution on disk", ordered most structural first: `EXPECTATION_INVALID`,
  `MANIFEST_SCHEMA_INVALID`, `MANIFEST_VERSION_UNSUPPORTED`, `COMPONENT_KIND_MISMATCH`,
  `COMPONENT_DUPLICATE`, `COMPONENT_SET_INCOMPLETE`, `API_RANGE_MISMATCH`. Every refusal is
  `{ code: "DISTRIBUTION_MISMATCH", ok: false, reason, refusedBy: "DISTRIBUTION_STARTUP" }`
  — `code` is constant, the varying field is `reason`.
- `isRange` checks all three version strings, not just the container: two empty ranges
  compare equal, so an unvalidated range would admit anything while the comparison still
  "ran".
- **`era` plus single flight.** `openControlRoom` is single-flight (an IDE fires it twice
  routinely; two runs would both see `DAEMON_ABSENT` and both start a daemon). `uninstall`
  bumps `era`; every `await` in `run()` is followed by `if (own !== era) return torn()`, so
  an uninstall landing mid-flight cannot be undone by a later `endpoint = ...`.
- **A throwing port becomes a typed failure AT THAT PORT'S LAYER**, via `attempt<T>` —
  `DAEMON_STATE_UNKNOWN`/`DAEMON_DISCOVERY_PORT`,
  `DAEMON_START_UNVERIFIED`/`DAEMON_START_PORT`,
  `CONTROL_ROOM_OPEN_UNKNOWN`/`CONTROL_ROOM_OPEN_PORT`. Nothing escapes into the IDE loop.
- **The four ports each fold a fault into an evidence arm**, and no detail carries a path
  or a secret — only a token from `codeOf`, which whitelists `/^[A-Z][A-Z0-9_]{1,39}$/u`
  and walks the `cause` chain (Node's `fetch` rejects with a bare `TypeError` whose cause
  carries `ECONNREFUSED`; reading only the top level makes the `NOT_LISTENING` arm, the one
  that licenses a start, unreachable in production while every test still passes).
- `probeDaemon` treats **any HTTP status as `LISTENING`, 401 and 403 included** — it runs
  before a session exists and carries no credential, so an authenticated refusal is proof
  something answers there. Only `ECONNREFUSED` is `NOT_LISTENING`; everything else is
  `UNDETERMINED`.
- `readInstalledDistributions` returns **empty on any fault, never partial** (a partial set
  would let the set-based gate admit on the readable parts) and deliberately does not
  validate shape — `admitDistribution` owns that.
- `startDaemon` spawns `detached`/`stdio: "ignore"`/`windowsHide`, then re-probes until the
  endpoint answers: the loop is bounded by `confirmTimeoutMs` and each inner probe is
  clamped to `min(remaining, 1000)` ms. Launch without confirmed listening is
  `LAUNCHED_UNCONFIRMED` → `DAEMON_START_UNVERIFIED`, and the sequence stops there.
- `openControlRoom` always reports `embedded: "UNAVAILABLE"` — this host renders nothing.
  A timed-out opener is `UNDETERMINED`, not `REFUSED`, because the browser may still open.
- `jetbrains-host.ts` imports the adapter through its **bare package name**, relying on
  Node's self-reference rule, so the host consumes the same exports map a plugin would.
  `start` and `reconnect` are the same function: the adapter derives which one happened
  from discovery evidence, and duplicating that choice would fork an owned decision.

## Gotchas

- `jetbrains-runtime-entrypoint.test.ts` audits the bridges in a **real child Node** with
  `--experimental-strip-types` (vitest rewrites `./x.js` back to `.ts`, so no other suite
  can see a missing bridge). It compares bridge bytes exactly — a CRLF bridge lands in
  `wrongContent` — and pins the excluded test modules **by name and reason**: adding a test
  file to this package means editing that map.
- The same file pins cross-package numbers: `reasonCodeCount: 14`, `layerCount: 4`,
  `requiredKinds: ["CONTROL_ROOM", "DAEMON"]`, `manifestVersion:
  "moe-distribution-manifest/1"`. A vocabulary change in either contract reds it here.
- Adding a module under `src/` means editing **two hand-written asset lists**, each holding
  the `.ts` *and* its `.js`: `IDE_ADAPTER_JETBRAINS_ASSETS` in
  `tools/packaging/distribution-inventory.ts` and the mirror in
  `tests/integration/distribution/distribution-packaging.test.ts`, which also asserts
  `keys.length === 12` and `INVENTORY[5].componentId === "ide-adapter-jetbrains"`.
- This package declares **no `*_LAYER` constant**, and
  `tests/security/boundary-roster.security.ts` has no `adapters/jetbrains` key (only
  `"adapters/ide-contract": 2`, `EXPECTED_ROSTER_SIZE 180`). A new column-0
  `export const X_LAYER` here reds the security lane.
- Arm counts are pinned by hand: `COVERED_ARMS.length === 22` in `jetbrains-host.test.ts`
  (compared against what actually ran), `gateLegs.length === 8` with 5 distinct reasons and
  `producedCodes.length === 8` in `jetbrains-adapter.test.ts`.
- `tests/integration/portability/portability-cases.ts` pins `JETBRAINS_ARMS` (10 names),
  `JETBRAINS_HOST_KEYS` (the four host methods, asserted not to contain `command`) and
  `JETBRAINS_MCP_TRANSLATION = "UNKNOWN"`; `transport-host-matrix.test.ts` counts the
  generated cases. Renaming a host method reds the portability lane, not this folder.
- Nothing is read from the environment. `JetBrainsHostConfig` states the install root,
  asset path, endpoint, command, opener and every timeout explicitly — an ambient install
  path is a different distribution from the one the build was compiled against.
- The portability probe points `daemonCommand` at a nonexistent file on purpose: aiming it
  at a real bin shim made the arm platform-dependent (Windows refuses to spawn a `.CMD`
  without a shell → `REFUSED`; POSIX launches fine → `LAUNCHED_UNCONFIRMED`).

## Testing

- Whole folder: `pnpm --filter @moe/jetbrains-adapter test` (its script is
  `vitest run --root ../.. adapters/jetbrains/src`, i.e. the root config with a path
  filter). The root gate covers it too: `vitest.config.ts` includes `adapters/**/*.test.ts`,
  so `pnpm test` runs this folder — unlike `apps/**`.
- One file, from the repo root:
  `pnpm vitest run adapters/jetbrains/src/host/jetbrains-host.test.ts`.
- `jetbrains-adapter.test.ts` uses fake ports only — the adapter is a decision sequencer.
  `host/jetbrains-host.test.ts` uses real `node:http` servers, real temp install roots and
  real child processes, counts requests **at the server** rather than through a spy, and
  proves out of process that importing a port module opens no `TCPSERVERWRAP`/`ChildProcess`.
- Outside coverage: `pnpm test:integration` runs
  `tests/integration/portability/transport-host-matrix.test.ts` (the
  `@moe/jetbrains-adapter/host` subpath under a live listener),
  `tests/integration/distribution/distribution-packaging.test.ts`
  (the shipped component's fail-closed drills) and
  `tests/integration/release/release-version-surfaces.test.ts` (pins this `package.json`).
- `pnpm typecheck` runs this package's own `tsc --project tsconfig.json`; it includes only
  `src/**/*.ts` and sets `types: ["node"]`.
