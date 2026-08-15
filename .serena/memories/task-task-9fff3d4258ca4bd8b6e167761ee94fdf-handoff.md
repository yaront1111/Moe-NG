# task-9fff3d42 (Ship JetBrains adapter distribution host) — DONE, in REVIEW

worker-06df66bb, 2026-08-14. Commit `5a9bf0b`, 9 files, 1129 insertions, 10 deletions.
Owned-scope gate EXIT 0 (re-run AFTER the commit at HEAD 5a9bf0b):
`pnpm --filter @moe/jetbrains-adapter typecheck && ... test && pnpm typecheck:packaging &&
npx vitest run tests/integration/distribution` -> 69 package tests, 37 packaging tests.

## `pnpm test:integration` IS RED AT HEAD AND IT IS NOT THIS TASK
`tests/integration/control-room/control-room-transport.test.ts:103` fails repo-wide:
only delta is `seamObservation.reading.value` `...385Z` vs `...380Z`. The test whole-payload
compares TWO INDEPENDENT reads; commit **4c39f3a** (task-1430dfae, "server timing observations")
added a live `DAEMON_WALL_CLOCK` reading stamped once per frame encode, so the two agree only
inside one millisecond. The test predates the field (749eb46, 2026-08-09, task-f01ef545).
Measured red twice at baseline BEFORE any diff, and repo-wide `pnpm test` at HEAD is
`1 failed | 5920 passed (5922)` — that ONE test is the entire repo's red.
**Anyone whose plan names `pnpm test:integration` will hit complete_task's exit-0 gate through
no fault of their own.** Use the owned-scope chain and disclose under global rail 3.
Fix belongs to task-1430dfae's owner: exclude the two readings from that equality, or assert
them structurally (`known: true`, ISO-shaped, `observer: DAEMON_SEAM`) instead of by value.

## What shipped
- `src/host/jetbrains-host.ts` (119) — the launcher. ONE nullable session handle, four methods,
  pinned as an exact key set. Imports `createJetBrainsSession` from the BARE
  `@moe/jetbrains-adapter` (self-reference through this package's own exports map).
  `start` and `reconnect` are deliberately the SAME call: the ADAPTER derives start-vs-reconnect
  from discovery evidence (index.ts:126), and re-deciding it in the host forks an owned decision.
- `src/host/jetbrains-host-ports.ts` (234) — the four real ports over node builtins.
- `src/host/jetbrains-host-port-detail.ts` (46) — the shared `codeOf` sanitizer, split out when
  the opener bound pushed ports past the 250 target. Split, never trim comments.
- `src/host/jetbrains-host.test.ts` (589) — 21 hand-listed arms + 2 guards, run against REAL
  node:http servers, real child processes, real temp filesystems.

## Non-obvious things a reviewer will challenge
1. **`fetch` puts the error code on the CAUSE, not the thrown error.** It rejects with a bare
   TypeError whose `.cause` carries ECONNREFUSED. Reading only the top level collapses every
   transport fault into UNDETERMINED and makes NOT_LISTENING — the arm that licenses a daemon
   start — unreachable in production while every test stays green. `codeOf` walks the chain.
2. **The sanitizer is a whitelist** `/^[A-Z][A-Z0-9_]{1,39}$/`. Blacklisting only removes the
   leaks somebody already thought of; OS messages quote full paths.
3. **Empty-on-fault, never partial** in `readInstalledDistributions`. A partial set lets the gate
   admit a distribution on the strength of whatever happened to parse. Shape is NOT validated
   here — `admitDistribution` owns exact-shape admission and cloning it forks the boundary.
4. **Any HTTP status is LISTENING, 401 included.** The probe carries no credential (it runs before
   a session exists), so an authenticated refusal proves reachability. Mapping it to REFUSED
   starts a second daemon beside a healthy one.
5. **The endpoint echoes into `detail` via the contract's `ok()`.** If a plugin configures a
   credentialled endpoint, that credential travels. The port cannot prevent it; documented limit.
6. Single-flight is per SESSION. After uninstall+reconnect against a dead daemon a second spawn
   is possible — the adapter's declared guarantee, not something the host may widen.

## The packaging inversion (tests/integration/distribution/distribution-packaging.test.ts)
`no shipped component claims the IDE_ADAPTER kind` was a CLOSED VERDICT whose premise —
"`adapters/` does not exist" — died when task-9fd52b41 landed. Replaced with a STRONGER
assertion: exactly one IDE_ADAPTER, id `ide-adapter-jetbrains`, explicitly not the fixture id,
exactly 12 assets, every asset resolving with non-empty bytes.
**FIVE hand-written literals are coupled to INVENTORY and only THREE were in the plan.** Found by
grepping every INVENTORY reference: `:196` length, `:197-202` the two lists, **`:236` rebuilt
count**, **`:323-325` the launched set**. `expectation()` and `allContainers()` derive from
INVENTORY and follow automatically. Drill D5 proved all four are load-bearing.
Assets include the `.js` BRIDGES, not just the `.ts` modules — a component whose modules cannot
resolve each other under plain Node is not a shipped artifact.

## Closed-verdict map in the same package
`jetbrains-runtime-entrypoint.test.ts:229` `expect(verdicts).toEqual({...})` admits no new test
file. Adding `src/host/jetbrains-host.test.ts` forced the one-line entry
`"host/jetbrains-host.test.ts": "test-file"`. `walk()` recurses, so the host subtree is inside the
bridge audit and both new modules needed byte-exact LF bridges. See
`mem:gotcha-closed-verdict-map-forbids-adding-a-test-file`.

## Drills
D1 partial discovery, D2 gate-after-probe (mutated `src/index.ts`, NOT the host — the ordering
lives in the adapter), D3 401->REFUSED, D4 unbounded confirm loop (named hang at 29s),
D5 drop the INVENTORY entry, D6 unresolvable asset, D7 unbounded opener.
D6 honest limit: the guard answered via `read()` throwing ENOENT — the path-resolves leg. The
`byteLength > 0` leg needs a real zero-byte file and this repo has none; undrilled, not claimed.
D7 SURVIVED on the first attempt — see `mem:gotcha-settimeout-clamps-a-huge-delay-to-one-ms`.
All restores by sha256 (`git checkout` would have destroyed uncommitted untracked work).

Consumer waiting on this: **task-22cfca91c5134b24aaf3e5734444fb93** (portability evidence).
Related: `mem:task-task-9fd52b41f3ea4aad8c0c07bbe6fd3025-handoff` (the producer),
`mem:gotcha-msys-tar-reads-drive-letter-as-remote-host` (run test:integration from PowerShell),
`mem:gotcha-shared-index-race-defeats-pathspec-commit`.
