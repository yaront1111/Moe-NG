# @moe/ide-adapter-contract

The editor-neutral boundary every IDE adapter implements: discover a running daemon, start
one when absent, open the control room. It is one 234-line module, `src/index.ts`, and it
**certifies nothing** — no spawn, no socket, no browser. Each operation is a pure function
from injected port evidence to a frozen typed result, and the I/O lives in the sibling
adapter that supplies the ports. The package exists so that hostile, stale and replay cases
have a declared boundary to be scheduled against (task-05ce9b8f), and so the editor adapter
(task-9fd52b41) restates no reason code of its own.

## Seams

- `exports` is `"." → "./src/index.ts"` and nothing else. `package.json` declares **no
  dependencies at all** — not even `@moe/contracts` — and the package is deliberately not a
  root dependency, which is why outside suites reach its vocabulary through a child process.
- Three decision functions, the whole runtime surface besides the two vocabularies:
  `decideDaemonDiscovery`, `decideDaemonStart`, `decideControlRoomOpen`.
- Two frozen tuples: `IDE_ADAPTER_REASON_CODES` (14 entries) and `IDE_ADAPTER_LAYERS`
  (`IDE_ADAPTER`, `DAEMON_DISCOVERY_PORT`, `DAEMON_START_PORT`, `CONTROL_ROOM_OPEN_PORT`),
  plus the scalar `IDE_ADAPTER_LAYER`, which is itself a member of the tuple.
- The three port interfaces (`DaemonDiscoveryPort`, `DaemonStartPort`, `ControlRoomOpenPort`,
  bundled as `IdeAdapterPorts`) are declared here and **implemented nowhere in this package**.
- Real callers: `adapters/<editor>/src/index.ts` sequences the three decisions and adds only
  a distribution gate, reconnect and uninstall;
  `adapters/<editor>/src/host/<editor>-host-ports.ts` builds the evidence arms and is the
  only file in that package that touches the OS.
  `tests/security/transport-hostile-cases.ts` imports the decisions directly through the
  relative path `../../adapters/ide-contract/src/index.js`.

## The model

- **Evidence in, result out.** Every input type is a discriminated union
  (`DaemonDiscoveryEvidence.status`, `DaemonStartEvidence.status`,
  `ControlRoomOpenEvidence.assets` / `.embedded`), and every result is frozen by
  the `ok` / `refused` / `unknown` helpers. `IdeAdapterSuccess` has no `layer` field at all;
  only `IdeAdapterFailure` (`outcome: "REFUSED" | "UNKNOWN"`) carries one.
- **Who answers is a rule, not a habit.** A *recognised* status that fails is attributed to
  the declaring port (`DAEMON_DISCOVERY_REFUSED` → `DAEMON_DISCOVERY_PORT`,
  `DAEMON_START_REFUSED` → `DAEMON_START_PORT`, `CONTROL_ROOM_ASSETS_MISSING` →
  `CONTROL_ROOM_OPEN_PORT`). An *unrecognised* status is the contract's own refusal:
  `EVIDENCE_MALFORMED` at `IDE_ADAPTER`. `tests/security/transport-hostile-fixtures.ts`
  states that line explicitly and builds every fixture on it.
- **Two outcomes are surprising and both are deliberate.** `DAEMON_ABSENT` (from
  `NOT_LISTENING`) is `outcome: "OK"` — a determinate absence is what licenses a start.
  `CONTROL_ROOM_BROWSER_FALLBACK` is also `OK`: an unavailable embedded view is not a
  failure, it is the fallback, and only the fallback's own `REFUSED` / `UNDETERMINED`
  becomes `CONTROL_ROOM_BROWSER_REFUSED` / `CONTROL_ROOM_OPEN_UNKNOWN`.
- **Optimism is structurally unavailable.** `LISTENING` or `LISTENING_CONFIRMED` without a
  usable endpoint yields `DAEMON_ENDPOINT_MISSING`, `UNKNOWN`, at `IDE_ADAPTER` — the port
  said something the contract will not believe, so the contract owns the refusal.
  `LAUNCHED_UNCONFIRMED` yields `DAEMON_START_UNVERIFIED`, `UNKNOWN`: a spawned process is
  never `DAEMON_STARTED`.
- **`isEvidence` runs before every discriminant read.** `null` / `undefined` are the only
  inputs that would throw a `TypeError` instead of falling through, and a thrown
  `TypeError` is not a stable reason code. `endpointOf` and `detailOf` treat a
  whitespace-only string as absent: `"   "` as an endpoint is `DAEMON_ENDPOINT_MISSING`,
  and a blank detail becomes `"no detail was provided"`. `readBrowser` re-validates the
  nested `browser` record for the same reason.
- **The module header is load-bearing prose.** `ide-adapter-contract.test.ts` asserts
  `src/index.ts` contains the literals `task-9fd52b41`, `task-05ce9b8f` and
  `CERTIFIES NOTHING`. Consumers are named by task id and never by editor: naming the editor
  would make this file that editor's adapter, which is what the boundary exists to prevent.

## Gotchas

- **No editor identifier may appear anywhere under `adapters/ide-contract/`.** A test walks
  the *whole package root* — this file included — lowercases every byte and fails on any of
  the three editor brand names in `EDITOR_IDENTIFIERS` (spelled only inside
  `ide-adapter-contract.test.ts`; do not copy them out). That is why the callers above are
  written as `adapters/<editor>/…`: naming the real directory here reds the suite. The
  scanner excludes only itself by basename and asserts that the exclusion happened, so
  renaming the test file does not quietly turn the guard into a tautology.
- **`src/index.js` must stay byte-exact**: `export * from "./index.ts";` with a trailing LF.
  The bridge audit compares bytes through UTF-8, so a CRLF bridge lands in `wrongContent`
  where `git diff --stat` would show nothing. Any new non-test `.ts` module needs its
  sibling bridge, and the exclusion map pins `ide-adapter-contract.test.ts` and
  `ide-adapter-runtime-entrypoint.test.ts` **by name and reason** — adding a test file here
  means editing that map.
- **Adding or removing an export reds three places at once**:
  `ide-adapter-runtime-entrypoint.test.ts` pins `reasonCodeCount: 14` and
  `decisionExports: 3`; `ide-adapter-contract.test.ts` pins `MINIMUM_CASES = 17` and asserts
  the swept cases produce *every* declared code exactly once over the set;
  `tests/security/boundary-roster.security.ts` pins `"adapters/ide-contract": 2` exported
  `*_LAYER(S)` constants (both rostered on the `transport` axis).
- **Only `src/index.js` and `src/index.ts` are shipped from this folder**, hand-transcribed
  twice: in `tools/packaging/distribution-inventory.ts` (component `ide-adapter-<editor>`,
  kind `IDE_ADAPTER`) and again as literal text in
  `tests/integration/distribution/distribution-packaging.test.ts`. There is no walk — the
  inventory is canonical and both copies must be edited by hand.
- `tests/integration/release/release-version-surfaces.test.ts` pins this `package.json` in
  its manifest roster, and `tests/runtime/package-loadability.test.ts` asserts the
  `adapters/*` workspace glob expands to `adapters/ide-contract`.
- The entrypoint probes spawn **real child Node** with `--experimental-strip-types` from the
  package root, resolving `@moe/ide-adapter-contract` through Node's self-reference rule.
  Vitest rewrites `./x.js` back to `.ts`, so no other suite in the repo can see a missing
  bridge. Children are killed at 20 s with a 30 s test timeout; a slow host shows up here.

## Testing

- One file, from the repo root:
  `pnpm vitest run adapters/ide-contract/src/ide-adapter-contract.test.ts` — the root vitest
  `include` covers `adapters/**/*.test.ts`, `environment: "node"`.
- Whole folder: `pnpm --filter @moe/ide-adapter-contract test`, which is
  `vitest run --root ../.. adapters/ide-contract/src` — it borrows the root config and the
  root's vitest, since this package declares no devDependencies.
- Typecheck: `pnpm --filter @moe/ide-adapter-contract typecheck`. `tsconfig.json` includes
  `src/**/*.ts`, so the test files are typechecked too, with `types: ["node"]`.
- Outside coverage: `pnpm test:security` runs the six IDE arms in
  `tests/security/transport-hostile-cases.ts` (BEFORE / AFTER / RACE against the real
  decisions); `pnpm test:integration` runs the distribution packaging pins and the
  portability matrix, whose `beforeAll` spawns a child with cwd `adapters/ide-contract` to
  read `IDE_ADAPTER_LAYERS` / `IDE_ADAPTER_REASON_CODES` out of the bare specifier and pin
  the per-arm code, layer and outcome in `tests/integration/portability/portability-cases.ts`.
