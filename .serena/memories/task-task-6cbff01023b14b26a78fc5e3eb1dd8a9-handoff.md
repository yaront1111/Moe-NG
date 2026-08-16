# task-6cbff01023b14b26a78fc5e3eb1dd8a9 handoff (2026-08-16, REVIEW)

Status: REVIEW, assigned qa-c7cedba3. All 7 steps COMPLETED. Committed at `66ae6ef`
(`fix(task-6cbff...): Durable Claude attempt dispatch (retry after qa_reject #1)`), which is a
whole-tree hook commit — it also carries .moe json and other tasks' files. Earlier foreign sweeps
`4d0a49f` (task-c690a7a0) and `b55b9f0` (task-9aca4b05) captured earlier states of the same files.
Never amend/reset them; review by `git diff cf272f67..HEAD -- apps/daemon/src/work/foundation-attempt-*`.

## What the reopen demanded and what landed
`FoundationAttemptDeps.runtimePorts` is GONE. `dispatch()` now calls bare-root
`createClaudeRuntimePinRequest(request.launchTemplate.runtime)` BEFORE any durable write and returns
`foundationAttemptRefusal(runtime.code, runtime.layer)` on failure (runner's own code, layer `RUNTIME`).
`launchRequestBody(record, bound, template, runtime)` takes the hydrated pin request.

Owned paths (10): foundation-attempt-{contracts,codec,store,service}.ts + their one-line .js bridges,
foundation-attempt-service.test.ts, foundation-attempt-windows.test.ts.
Line counts: contracts 215, codec 194, store 155, service 249 (cap 250 — NO margin left).

## Gate, fresh at 14:51 local on committed bytes
- focused daemon: `pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/work/foundation-attempt-service.test.ts src/work/foundation-attempt-windows.test.ts --maxWorkers=1 --no-file-parallelism` -> 2 files / 28 tests passed, exit 0.
- `pnpm --filter @moe/runner test` 66 files / 2216 passed. `pnpm typecheck` exit 0.
- FOREIGN reds, owned-path intersection empty: untracked peer `apps/daemon/src/activation/activation-run-commit.test.ts` (task-d3239529) breaks `pnpm --filter @moe/daemon typecheck` with TS2307 since ~14:50 (same leg was exit 0 at 14:48); `pnpm test` fails 3 in packages/store recovery-anchor + tests/integration/release-archive-cleanup; daemon suite fails 4 in src/activation/{activation-ledger-reader,foundation-launch-authority}.test.ts (`expected 6501 to be less than or equal to 8`). Nothing outside src/work/foundation-attempt* imports these modules.

## The open gap — filed as task-99cb56a74d1141c7a9ec31c604e25e77
No public @moe/runner API can mint a `quotedObservation` production accepts: `observeInstalledClaudeRuntime`,
`probeClaudeRuntime`, `createNodeClaudeRuntimeFs`, `ClaudeRuntimeFactsPort` are withheld
(claude-surface.ts:85-92) and `capabilitySchemaDigestOf` / `canonicalDigest` are internal.
`prepareClaudeRuntimePin` compares reportedVersion + adapterCapabilitySchemaDigest + platformIdentity
(claude-runtime-pin.ts:130-141). So the physical PROVEN dispatch journey is unreachable for any consumer;
do NOT fake it. See `mem:gotcha-a-caller-cannot-mint-a-runtime-quote`.

## Windows conformance suite (real Windows 10.0.26200, real broker, zero test capability)
1. stand-in `where.exe` renamed claude.exe -> `CLAUDE_RUNTIME_OBSERVATION_INVALID@RUNTIME`, SUSPECT advisory persisted, replay adopts, cwd drift -> REPLAY_MISMATCH.
2. real installed `claude.exe` 2.1.233 with a self-assembled quote -> `CLAUDE_RUNTIME_OBSERVATION_CHANGED@RUNTIME`.
3. reservation abort -> pinRoot never created, zero dispatch rows.
`REAL_CLAUDE` is discovered from `%USERPROFILE%\.local\bin\claude.exe` then PATH. argv MUST name the model
and effort (`--version --model claude-opus-5 --effort high`) or the launch-selection gate answers first with
`CLAUDE_LAUNCH_MODEL_UNPROVEN@TELEMETRY_CONFIGURATION`. `claude.exe --version ...` exits 0 in ~0.5s, no network.

## Drills run (all byte-restored, hashes re-verified)
hydrator bypass -> 5 red on exact RUNTIME codes; `bearing.length > 1` -> `> 99` -> multi-node red;
`reserved.disposition === "REPLAYED"` -> false -> 4 red incl. a real physical relaunch (3.1s);
dispatch identity narrowed to activation bytes -> 3 red on REPLAY_MISMATCH.

## Hazard
A SECOND CLI session wrote these owned files and called complete_task under my claim. See
`mem:gotcha-a-parallel-session-can-write-your-owned-files`.
