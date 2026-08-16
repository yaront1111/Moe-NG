# QA verdict: Durable Claude attempt dispatch (round 2)

REJECTED 2026-08-16 11:55Z by qa-c7cedba3. Same DoD item failed twice -> runtime flipped the task to
PLANNING (reopenCount 2 / max 3). Architect must re-plan, not the worker.

## Round-1 issues: ALL FIXED, do not redo
Verified on committed bytes at HEAD 66ae6ef (base-ref `git diff 0f19e06..HEAD -- apps/daemon/src/work/foundation-attempt-*`):
1. Whole-launch deps seam GONE. `FoundationAttemptDeps` = `{captureResult, launchOptions?, store}` only.
   service.ts:233 builds the real `createFoundationClaudeLauncher`; test:569 passes a `launch` key anyway and
   asserts `forgedCalls === 0` while the real launcher refuses `CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED@LAUNCHER`.
   test:593 proves `narrowLaunchOptions` drops a nested `deps` override (platform/signal only).
2. Replay identity FULL: `identifyFoundationDispatch` (codec:178) hashes activationRequestDigest + binding +
   graphSnapshot + inputManifest + launchTemplate. Changed `cwd` -> `FOUNDATION_ATTEMPT_REPLAY_MISMATCH`, no
   overwrite, same stored digest (test:703). Also proven on real Windows (windows.test.ts).
3. Binding fence is PRE-write: `preActivationBindingMatches` at service.ts:188 runs before
   `runEffectActivateCommand` (:199). Zero events on BOTH aggregates asserted (test:518/536).
4. Hostile reflection contained: revoked proxy + ownKeys-throwing proxy -> exact
   `FOUNDATION_ATTEMPT_REQUEST_MALFORMED@DAEMON_FOUNDATION_ATTEMPT`, explicit case count 2 (test:424).
   `exactKeys`/`copyValue`/`isRecord`/`textOf` all try/catch. Getter never invoked (test:408).
5. Line counts PASS: contracts 215, service 249, codec 194, store 155; four 1-line `.js` bridges.

## The one surviving gap (DoD 2, second half)
"persists immutable process registration, raw evidence digests, and result-manifest identity" has ZERO
executed evidence. `deps.captureResult` is asserted `toHaveLength(0)` in every case (test 512/647/679/696/
715/786) and throws in the Windows case. Consequence: `capture()` (service.ts:121-151), its
`buildResultManifest({inputManifest: input as never})` call, and the PROVEN branch of `attemptRecordBody`
(observation/registration `pick`, stdout/stderrSha256) are dead code in tests. A shape mismatch there would
silently persist `truthClass:"UNKNOWN"` on every real PROVEN launch and no gate would catch it.

Why it happened: removing the launch seam (round-1 QA directive) made PROVEN unreachable end-to-end, because
@moe/runner withholds `observeInstalledClaudeRuntime`/`probeClaudeRuntime`/`capabilitySchemaDigestOf`, so no
consumer can mint an acceptable quote. That part is honest and correctly disclosed in windows.test.ts.
The fix does NOT need that authority: `durableObservedFixture` already builds the
GRANT_CONSUMED/PREFLIGHT/PROCESS_OBSERVED tail through production `createFoundationLauncherAuthority`, and
`readDurableFoundationObservation` already validates the (observation, registration) pair against it with a
19-case substitution sweep. Move the record compose+commit step into foundation-attempt-store.ts as
production the service calls, drive it from that fixture + the real `captureAnswer()`, assert read-back bytes.

Secondary: `FOUNDATION_ATTEMPT_RESULT_MANIFEST_INVALID`, `_DISPATCH_SUSPECT`, `_INPUT_MANIFEST_INVALID` are in
the closed vocabulary with ZERO producers in production and zero test occurrences.

## Gates re-run by QA (Windows, this host)
- `pnpm --filter @moe/runner test` -> 66 files / 2216 passed, 1 skipped. EXIT 0.
- Focused: `cd apps/daemon && pnpm exec vitest run --root . --config package.json src/work/foundation-attempt`
  -> 2 files / 28 tests passed. EXIT 0. (`--root .` WITHOUT `--config package.json` finds ZERO tests.)
- `pnpm --filter @moe/daemon test` -> 2 failed files / 98 passed, 4 failed / 2063 passed. Both failing files are
  the peer O(n)-bounded-scan repros: activation-ledger-reader.test.ts (2), foundation-launch-authority.test.ts (2).
  Neither is an owned path. Foreign red, disclosed not attributed.
- `pnpm --filter @moe/daemon typecheck` and `pnpm typecheck` fail ONLY on untracked peer file
  `apps/daemon/src/activation/activation-run-commit.test.ts` (TS2307, module absent). Untracked, absent at
  merge-base 0f19e06 -> foreign.

## Commit state
The task's own commit 66ae6ef carries only .moe board files + windows.test.ts. The production bytes were swept
by foreign whole-tree commits b55b9f0 and 4d0a49f. Per epic rail, absence of a commit bearing the task id is
NOT a rejection reason; judged by base-ref diff over owned paths.
