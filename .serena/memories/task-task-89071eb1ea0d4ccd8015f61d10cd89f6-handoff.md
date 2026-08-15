# task-89071eb1 — Agent spawn refusal must not leak the session credential (DONE, commit 6361091)

Landed by worker-fd8f822b. All 7 steps complete. 4 owned files, +145/-19.

## What shipped

`apps/daemon/src/orchestrator/agent-spawner.ts` — `agentSpawnInvocation(...)` HOISTED above
`writeFileSync`, so a request that cannot be spawned never writes a credential at all. The
returned arrow is now `async` and the inner promise is `new Promise<void>`. The existing
`options.platform` is forwarded as agentSpawnInvocation's 3rd arg.

`agent-spawn-invocation.ts` — `SpawnInvocationRefusal extends Error` with `code`
(`SpawnInvocationRefusalCode`, closed union) and `layer` (`SPAWN_INVOCATION_LAYER =
"agent-spawn-invocation"`). Message is the BARE code — no `: ${argument}` suffix, because the
argument is the MCP config path.

## The plan's line numbers were STALE — re-measure, always

Plan measured a967199 (88-line file); at b8c85f3 it was 125 lines with a timeout/killTree block
added and a THIRD `finish` installation the plan did not know about. Nothing else changed.

## Three things that were load-bearing and look optional

1. `async` on the returned arrow. `agent-wrapper.ts:226` is
   `config.spawnAgent({...}).catch(() => undefined).then(...)` — NOT awaited. Hoisted out of the
   Promise executor without `async`, the throw escapes synchronously out of `staff()` and
   `runOnce()`'s for-loop and kills the poll tick. See `mem:gotcha-hoisted-guard-turns-rejection-into-sync-throw`.
2. Forwarding `platform`. `agentSpawnInvocation` early-returns for non-win32, so a refusal test
   that does not force the platform reaches NO guard on Linux/macOS and passes testing nothing.
   Production is unaffected: `agent-wrapper-main.ts:85` passes no options, so `platform` resolves
   to `process.platform` — the default agentSpawnInvocation already applied.
3. Message must KEEP the literal token `SPAWN_ARGUMENT_UNQUOTABLE`: two pre-existing tests match
   `/SPAWN_ARGUMENT_UNQUOTABLE/u` against the message and DoD 3 required them green as written.

## Drills (all restored by Edit + sha256, never git checkout)

- D1 ordering reverted -> named test red on the CREDENTIAL-PRESENCE assertion (`agent-spawner.test.ts:236`).
- D2 (the one DoD 4 turns on): cleanup disabled ENTIRELY -> three cleanup-dependent cases went red
  (positive control) while the refusal case stayed GREEN. Proves NEVER-WRITTEN vs written-then-deleted.
  An absence assertion alone cannot separate those; a try/finally fix would pass it.
- D3 code rename -> new property assertion red. D4 layer change -> ONLY the layer line red.

## Gate

`pnpm --filter @moe/daemon test` EXIT 0, 89 files / 1823 tests.
`pnpm --filter @moe/daemon typecheck` EXIT 1 on FOREIGN committed paths only —
daemon-entry.ts:176,191 (commit 8d9afb8) and identity/session-services.test.ts:173 (7eb2997).
Path-attributed baseline measured by writing HEAD bytes over the 4 owned files
(`git show HEAD:<p> > <p>`, backups outside the repo, hashes re-verified): identical error set,
delta EMPTY, `grep -c "agent-spawn"` over the errors = 0. Four other workers are blocked on this
same wall. See `mem:gotcha-daemon-typecheck-red-is-foreign-and-ownerless`.

## Known follow-up, deliberately NOT fixed

`spawn(...)` throwing SYNCHRONOUSLY at agent-spawner.ts:88 leaks the credential the same way:
it rejects after `writeFileSync` and before `finish` exists. Not a refusal, so no stable code to
assert; the plan explicitly declined to add a fourth cleanup. Worth its own task.
