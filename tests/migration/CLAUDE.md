# tests/migration

The lane that proves the one-way moves: quiescing the legacy system before a cutover, and
importing its bytes exactly once. Two unrelated subjects share the tree because both are
migration evidence. `cutover/` is a **simulation-only** rehearsal of the quiesce drill
(task-4e1fe696, DONE at harness scope); `cutover-live/` is the **built-but-never-run**
machinery for the real one (task-e60b874b, gated on a human GO_QUIESCE); `import/` drives
the production importer against a real SQLite store.

## Seams

- **Nothing outside this folder imports it.** The coupling runs outward: the live-quiesce
  evidence *shape*, its layer name and its seven-code roster live in
  `packages/core/src/cutover/cutover-quiesce-evidence.ts` and are re-exported by
  `cutover-live/live-quiesce-evidence.ts` **by identity** (`toBe`, not a copy that agrees).
  `apps/daemon/src/cutover/cutover-generation-snapshot.ts` reads the artifact this lane
  writes — `LIVE_QUIESCE_EVIDENCE_FILENAME = "live-quiesce-evidence.json"` under the daemon
  store root — and refuses ACTIVATE with `missing: "quiesceRecordSha256"` when it is absent.
- `cutover-live/live-quiesce-main.ts` is the hand-run entry: `runLiveQuiesce(config)`,
  `WINDOWS_PORTS` (taskkill / schtasks / tasklist), `RECORDED_AUTHORITY`. **No test file
  imports it**, it is inert on import, and a bare `node` invocation throws by design.
- `import/import-determinism.test.ts` reaches production by **relative path**
  (`../../../packages/import/src/index.js`, `../../../packages/store/src/index.js`). That is
  deliberate and documented in its header as the same arrangement
  `tests/fault/foundation/foundation-harness.ts` uses; `@moe/core` is the one bare specifier
  used here, in the evidence module.

## The model

- **Refusals are returned, never thrown**, so a case can assert *which* layer refused: a
  thrown error is indistinguishable from a crash. Four layer constants live here —
  `cutover-manifest`, `cutover-inventory`, `live-quiesce-actor`, `live-quiesce-inventory` —
  and the fifth, `live-quiesce-evidence`, is `@moe/core`'s.
- **Nothing is silently skipped.** `captureCutoverManifest` (`cutover/cutover-manifest.ts`)
  hashes files, records a symlink as a distinct `LINK` entry with its target, records every
  directory it declined to descend in `excludedDirectories`, and hard-refuses anything else
  (`CUTOVER_MANIFEST_UNSUPPORTED_ENTRY`). A link is classified *before* a directory, because a
  Windows junction answers `isDirectory()` true and following one walks another package tree.
- Order is the spec: entries sort by **UTF-8 bytes** (`Buffer.compare`), never by readdir
  order, never `localeCompare`. `MAX_WALK_DEPTH = 32`, `MAX_WALK_ENTRIES = 10_000`,
  `DEFAULT_EXCLUDED_DIRECTORY_NAMES = [.git, .serena, dist, node_modules, target]`,
  `DEFAULT_EXCLUDED_DIRECTORY_PATHS = [".claude/worktrees"]`. Exclusion matches a directory
  **name**, so `node_modules.md` is an ordinary file.
- `CutoverWalkPorts` (`readDirectory` / `readFile` / `readLinkTarget`) exists so the drill can
  drive the UNREADABLE, UNSUPPORTED and LINK branches of the *real* walk on any host.
- `compareCutoverManifests` (`cutover/cutover-compare.ts`) never answers a bare boolean and
  never answers over nothing: empty or count-inconsistent manifests refuse
  (`CUTOVER_MANIFEST_EMPTY`, `_COUNT_INCONSISTENT`), and two captures with different
  exclusion sets refuse `CUTOVER_MANIFEST_EXCLUSION_MISMATCH` — a widened exclusion would
  otherwise report a clean match over exactly the files that moved. Difference kinds go
  most-specific-first: `KIND_CHANGED` over `LENGTH_CHANGED` over `CONTENT_CHANGED`.
- `cutover/cutover-inventory.ts` and `cutover-fixture.ts` simulate the access surface and
  **contain no real-process code path at all** — its absence is stated in both headers,
  because the daemon serving this board is one of the paths DoD 1 enumerates. The fixture's
  `legacy-archive-mount` starts `DENIED` on purpose, so "restore to everything open" fails.
  `createDefectiveAccessTable("inert-writes")` models the write that reports success and
  never lands.
- `cutover-live/live-quiesce-actor.ts`: a result comes from an **observation taken after the
  stop**, never from the stop's exit code — `StopAttempt.exitCode` is recorded for the
  transcript and read by no branch. `OBSERVATION_POLL_BUDGET = 200` counts polls, not ms,
  because `taskkill` returns ~78 ms before the pid leaves `tasklist` (measured, 8/8 samples).
- `cutover-live/live-quiesce-inventory.ts` refuses a record a later reader could not trust: a
  roster kind must be populated **or** declared undiscoverable with the method that failed
  (`HANDLE` and `WATCHER` are, on this host), `runMode` must be `"LIVE"`, and a path under
  the current process's `tmpdir()` refuses `LIVE_QUIESCE_SANDBOX_PATH_IN_LIVE_RUN`.
- Every roster in this lane is asserted three ways: frozen, set-equal in **both** directions,
  and "every code was OBSERVED firing above, not merely listed".
- The importer arms prove determinism by **two full runs over separate trees created in
  opposite order with separate ephemeral databases**, plus an explicit expected claim order
  (NTFS hands back roughly sorted entries, so a two-run comparison alone passes with the
  comparator neutered). Atomicity is proven by an `ImportStorePort` whose `commit` throws:
  `IMPORT_COMMIT_FAILED` / layer `APPLY`, zero readable rows, source mtimes unchanged. The
  replay arm pins `dispositions` to exactly `["COMMITTED", "REPLAYED"]`.

## Gotchas

- **`pnpm typecheck` never reaches this tree.** `tests/` is not in `pnpm-workspace.yaml`, so
  the only typechecker is `tsc -p tests/migration/tsconfig.json`, which runs as the first leg
  of `pnpm test:migration`. A type error here is invisible to every other gate.
- **No `.js` bridges here, and none are wanted.** The repo-wide bridge rule applies to
  `apps/daemon` and `packages/*`; nothing loads this tree through a runtime module graph, and
  the `./cutover-manifest.js` specifiers resolve to the `.ts` files under vitest.
- **Every file in this lane also runs under the root suite** — the root config includes
  `tests/**/*.test.ts` — so each case executes twice in CI. The lane sets no `testTimeout`
  precisely so cases carry their own: the DoD-2 arm's real 10.2 s monotonic wait declares
  `60_000`, ARM E declares `300_000`, ARM E2 `600_000`.
- **ARM E walks the REAL repo root.** It has refused twice in production — once on a pnpm
  junction, once on `CUTOVER_MANIFEST_ENTRY_LIMIT_EXCEEDED`. Its failure branch prints a
  per-top-segment census; read it before touching `MAX_WALK_ENTRIES`. The answer to a full
  walk is a declared directory exclusion, not a bigger bound — `.serena` grows a file per
  agent session and was 41% of the walk. The margin is *reported* in the assertion message,
  never pinned as a number.
- **ARM E2 compares `packages/`, not the root, on purpose**: CI runs the root suite as
  `pnpm test | tee vitest-root-posix.log` (cross-host.yml:97, :309), so a root log file grows
  between the two captures and lands as a meaningless `LENGTH_CHANGED`.
- `cutover-live/` is a **sibling of** `cutover/`, never an edit to it: the older tree is DONE
  and simulation-only by construction, and cannot discharge a clause about the real host.
- Editing `packages/core/src/cutover/cutover-quiesce-evidence.ts` moves this lane's roster in
  the same edit; the seven-code arm in `live-quiesce-evidence.test.ts` reds if the two stop
  being identical objects.
- `tests/integration/release/release-workflow-contract.test.ts` pins the literal strings
  `pnpm test:migration` and `Gate - migration:… gate-migration.log` (lines 629, 706).
  Renaming the script or the CI log file reds the integration lane.
- CI does not trust the exit code alone: every leg greps the log for `Test Files N passed`
  **and** `Tests N passed`, and the lane config sets `passWithNoTests: false` and
  `allowOnly: false`. A focused `it.only` fails the lane rather than narrowing it.
- `createCutoverFixture` holds a real descriptor open to model the `handle` path; teardown
  closes every handle **before** `rmSync`, or Windows leaves the whole temp tree behind.

## Testing

- Whole lane: `pnpm test:migration` (typecheck first, then
  `vitest run --config tests/migration/vitest.config.ts`). Expect ≥10 s: the DoD-2 arm really
  waits, and the two real-tree arms hash thousands of files.
- One file: `pnpm vitest run --config tests/migration/vitest.config.ts cutover-refusals` —
  the lane config sets `root` to this directory, so a filter is matched lane-relative, not
  repo-relative. From the root config instead:
  `pnpm vitest run tests/migration/import/import-determinism.test.ts`.
- The lane is serial by design (`fileParallelism: false`, `maxConcurrency: 1`, `retry: 0`,
  `dangerouslyIgnoreUnhandledErrors: false`) and orders files by module id through
  `MigrationLaneSequencer`, so a red is reproducible in the order it happened.
- Outside coverage: `pnpm --filter @moe/daemon test` for the consumer of the evidence
  artifact (`apps/daemon/src/cutover/cutover-generation-snapshot.test.ts`,
  `cutover-activate-service.test.ts`), `pnpm test` for
  `packages/core/src/cutover/cutover-quiesce-evidence.test.ts`, and the `gate`,
  `portability-evidence` and `reusable-windows-candidate-build` CI jobs, each of which runs
  `pnpm test:migration` whole.
