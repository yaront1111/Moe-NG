# QA verdict: Durable Claude attempt dispatch — APPROVED (round 3)

APPROVED 2026-08-16 ~16:10Z by qa-c7cedba3 at HEAD 11b78f2 (+ my own restore commit). reopenCount 2.
Rounds 1 and 2 rejections are both closed. This supersedes the round-2 REJECT note.

## What closed the round-2 gap
Round 2 failed DoD 2's persistence half ("zero executed evidence": `capture()` and the PROVEN branch of
`attemptRecordBody` were dead in every test, `captureResult` asserted `toHaveLength(0)` everywhere).

The fix took the path round-2 QA named, and needed NO withheld runner authority:
- `settle` MOVED out of `foundation-attempt-service.ts` into `foundation-attempt-store.ts` as exported
  `settleFoundationAttempt` — the one writer of the RECORDED event.
- New `recordProvenFoundationAttempt(store, bound, record, input, {answer, observation, registration})`
  is production the service calls, and is directly callable from a test with NO launcher.
- Test drive point `provenGround(label)` = `durableObservedFixture` (production
  `createFoundationLauncherAuthority` builds GRANT_CONSUMED -> PREFLIGHT_REGISTERED -> PROCESS_OBSERVED)
  -> `readDurableFoundationObservation` validates -> `reserveDispatch` advances the aggregate to
  version 1 so the record commit's `expectedVersion` 1 is genuinely exercised.

The MOVE preserved all four load-bearing properties: `expectedVersion` 1, event id COPIED from the grant
(`${record.grant.grantId}:RECORDED`, never minted), the `EFFECTS_COMMITTED` check, and the read-back
through `readStoredFoundationAttempt` (re-decode + byte-compare).

## Gates I re-ran myself (Windows, this host)
- `pnpm --filter @moe/runner test` -> "Test Files 66 passed (66)" / "Tests 2216 passed | 1 skipped". EXIT 0.
- `pnpm --filter @moe/daemon typecheck` -> EXIT 0.
- `pnpm --filter @moe/daemon test` -> "Test Files 102 passed (102)" / "Tests 2101 passed". EXIT 0.
- Focused `cd apps/daemon && pnpm exec vitest run --root . --config package.json src/work/foundation-attempt`
  -> 2 files / **33 tests**. EXIT 0. (Round-2 baseline was 28.)
- `pnpm typecheck` -> EXIT 1, foreign only: untracked peer
  `packages/benchmark/src/benchmark-run-projection.test.ts` TS2307 (its `.ts` impl does not exist yet —
  a peer mid-TDD-RED). Whole `packages/benchmark` is ABSENT at merge-base cf272f6.
- `pnpm test:security` -> 2 failed / 46 passed, both naming only
  `BENCHMARK_PROJECTION_LAYERS@packages/benchmark/src/benchmark-projection-vocabulary.ts`
  (roster scan 88 vs expected 87). `grep -c foundation-attempt` on that log = **0**.
- Path-attributed baseline: HEAD failing paths minus merge-base, intersected with owned paths = EMPTY.

**Every foreign red from the round-2 note has CLEARED** (activation-ledger-reader,
foundation-launch-authority, activation-run-commit). Do not quote them again.

## My 4 mutation drills — all load-bearing
Each applied alone via a python replace with `assert count==1`, confirmed by `git diff --numstat`,
restored with `git checkout --`:
1. `resultManifest: built.manifest` -> `null` on the PROVEN branch -> RED on
   `AssertionError: expected null not to be null` (test:949). That IS the pre-fix behaviour.
2. `registration: capture.registration` -> `capture.observation` -> RED on the field `toStrictEqual`
   (test:961), NOT on `FOUNDATION_ATTEMPT_RECORD_DRIFT`. The byte guard did not mask the field assertion.
3. Delete the `sealedInputManifest(input)` fence -> RED on **exactly ONE** test (the daemon
   code+layer one) while the RUNNER-layer sibling stayed GREEN. The two-layer split is real, not decorative.
4. Event id `${record.grant.grantId}` -> `${bound.target}` -> RED on the explicit
   `events[1]?.eventId` assertion (test:985). Without that assertion the mint is an equivalent mutant.

## Closed vocabulary — every member now has a producer
- `FOUNDATION_ATTEMPT_INPUT_MANIFEST_INVALID` PRODUCED at store.ts:220, pinned code+layer test:1019/1022.
- `FOUNDATION_ATTEMPT_RESULT_MANIFEST_INVALID` DROPPED from `FOUNDATION_ATTEMPT_CODES`; repo grep 0.
  Correct call — `buildResultManifest`'s own code at `RUNNER_WORKSPACE_LAYER` already answers that condition.
- `FOUNDATION_ATTEMPT_DISPATCH_SUSPECT` KEPT: peer task-48c0c0db produces it at
  `in-flight-attempts.ts:158`, pinned at `in-flight-attempts.test.ts:180`. The plan's "orphan" claim was STALE.
- `FOUNDATION_ATTEMPT_NODE_UNKNOWN` producer contracts.ts:163, now pinned test:533.
- Honestly disclosed still-unpinned: `_ACTIVATION_UNREADABLE`, `_LAUNCH_UNKNOWN` (the latter only
  reachable through the seam round 1 removed).

## Line counts (grep -c '')
contracts 218 / service **213** (down from 249) / store **235** (up from 155) / codec 194. All < 250.
Four 1-line `.js` bridges present.

## Accepted residual, stated openly
The service's `capture()` wrapper (service.ts:105-115) is still not executed: it needs an OBSERVED
launcher result no consumer can mint (`@moe/runner` withholds `observeInstalledClaudeRuntime` etc.).
It is now a 6-line adapter with all judgment moved into the store where it IS exercised. Round-2 QA
explicitly prescribed this shape and accepted the disclosure. Not a reject — graded against the
written requirement, not an additional wish.

## Incident I caused and repaired
A whole-tree completion-hook commit `86d2326` (stamped with THIS task's id) fired mid-drill and
captured my drill 4 into HEAD. `git status` then read CLEAN and `git diff HEAD` empty while the drill
was live on disk. Detected because the FULL daemon suite went red on the eventId assertion while the
focused run had passed. Restored with `git checkout 11b78f2 -- <the one file>` and committed by
explicit pathspec. Owned paths are byte-identical to 11b78f2. That same commit also swept a peer's
`packages/benchmark/src/benchmark-projection-vocabulary.ts` — left untouched, and it is the cause of
the security-lane and repo-typecheck reds.
See `mem:gotcha-hook-commit-swallows-a-drill-and-git-reads-clean`.

## Other context
A SECOND CLI session was dispatched against this same claim (worker-5678886b). It stood down having
written ZERO bytes; governor filed task-05b0a693 for the double-dispatch seam. No contamination from it.
