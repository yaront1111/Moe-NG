# task-6cbff010 handoff — Durable Claude attempt dispatch (round 3, REVIEW)

Round 2 was rejected on DoD 2's persistence half only ("zero executed evidence"). That is now closed.
Round-1's five fixes were verified untouched. Do not redo either.

## The fix, in one line
`capture()` was dead because it needs an OBSERVED launcher result no consumer can produce. The
compose+commit moved OUT of the service INTO the store as production, so the PROVEN branch is now
driven from the durable side with **no launcher and no withheld runner authority**.

## New production surface (apps/daemon/src/work/foundation-attempt-store.ts)
- `settleFoundationAttempt(store, bound, record, input, parts, refusal)` — the ONE writer of the
  RECORDED event. Byte-identical move of the old `settle`: `expectedVersion` 1, event id
  `${record.grant.grantId}:RECORDED` COPIED not minted, EFFECTS_COMMITTED check, read-back through
  `readStoredFoundationAttempt`.
- `recordProvenFoundationAttempt(store, bound, record, input, {answer, observation, registration})`
  — capture-answer fence + input-manifest fence + `buildResultManifest` + settle. The service now
  only CONTAINS the `deps.captureResult` call and hands the raw answer on.
- `sealedInputManifest()` — STRUCTURAL only (manifestVersion/baseIdentity/sha256/entries) using the
  runner's own `WORKSPACE_INPUT_MANIFEST_VERSION`. Digest recomputation stays the RUNNER's question.
  That split is what makes the two layers distinguishable; do not widen it.

## The test drive point (service.test.ts)
`provenGround(label)` = `durableObservedFixture` (production `createFoundationLauncherAuthority`
builds GRANT_CONSUMED -> PREFLIGHT_REGISTERED -> PROCESS_OBSERVED) -> `readDurableFoundationObservation`
VALIDATES and returns the pair -> `reserveDispatch` commits the exact service reservation body via
production `commitFoundationPhase` at expectedVersion 0 so the aggregate reaches version 1.
Without that reservation the record commit's `expectedVersion` 1 cannot be exercised.

## Refusal-code decisions (step 5)
- `FOUNDATION_ATTEMPT_INPUT_MANIFEST_INVALID` — PRODUCED here, 2 tests pinning code+layer.
- `FOUNDATION_ATTEMPT_RESULT_MANIFEST_INVALID` — **DROPPED** from the closed list. Repo-wide grep 0.
  The runner's own code at `RUNNER_WORKSPACE_LAYER` already answers that condition.
- `FOUNDATION_ATTEMPT_DISPATCH_SUSPECT` — KEPT. The plan called it orphan; that was STALE. Peer
  task-48c0c0db produces it at `in-flight-attempts.ts:158` and pins it at `in-flight-attempts.test.ts:180`.
- Bonus: `FOUNDATION_ATTEMPT_NODE_UNKNOWN` had a producer and no test; now pinned.
- STILL UNPINNED, disclosed: `FOUNDATION_ATTEMPT_ACTIVATION_UNREADABLE` (needs a store that throws
  only on the read-back AFTER the ingress already read it) and `FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN`
  (needs the launcher to answer with a non-record — only reachable via the seam round 1 removed).

## Gates, fresh at 15:51 local
`@moe/runner test` 66 files / 2216 passed +1 skipped, EXIT 0. `@moe/daemon test` **102 files / 2101
passed, EXIT 0**. `@moe/daemon typecheck` and repo `pnpm typecheck` EXIT 0. Focused
`vitest run --root . --config package.json src/work/foundation-attempt` = 2 files / **33 tests**
(QA's baseline was 28). Chained verification command CHAIN_EXIT=0.
**Every foreign red QA named has CLEARED** — activation-ledger-reader + foundation-launch-authority
fixed by 3e52753, activation-run-commit.test.ts gone, approval-policy-settings fixed by e4af0e6e.
Do not quote a stale foreign red from an older note.

## Line counts
service 249 -> **213**, store 155 -> **235**, contracts 215 -> 218, codec 194 unchanged. Bridges 1 line.

## Drills (all restored, `git status` clean, no DRILL markers)
1 registration<-observation -> RED on the field toStrictEqual (test:961), NOT on RECORD_DRIFT.
2 resultManifest<-null -> RED on `not.toBeNull()` (test:949) — the exact pre-fix behaviour.
3 remove the input-manifest fence -> RED on exact code AND layer; the runner-layer sibling stayed GREEN.
4a expectedVersion 1->0 -> 11 named tests RED. 4b event id minted from `bound.target` -> RED on the
explicit `events[1].eventId` assertion (test:985). Without 4b's assertion the mint is an equivalent mutant.

## Commits / hazard
Mine: `ee9ed16`, `4b4ad80` — explicit pathspec, owned paths only, `git show --stat` verified.
Foreign whole-tree hook commit `0efcf12` (task-e4af0e6e) SWEPT my in-progress
`foundation-attempt-store.ts` and `foundation-attempt-service.ts`. Not amended, not reset.
**QA: judge by base-ref diff over owned paths, not commit authorship.**
See `mem:gotcha-observed-launch-arm-unreachable-from-apps`, `mem:gotcha-seam-removal-orphans-the-success-path`.

## Appended by a SECOND, concurrent CLI session (same workerId worker-5678886b)
The wrapper dispatched a duplicate session against this same claim. It resumed at step-2, read the
four production files at 215/249/194/155, and its first `Edit` failed "File has been modified since
read" — the peer above was mid-rewrite of the same owned paths. It wrote ZERO bytes and stood down
per `mem:gotcha-a-parallel-session-can-write-your-owned-files` (stand down once the peer reaches the
commit step). Everything in this note is the peer's work, not a second implementation.

INDEPENDENT re-verification at HEAD 11b78f2 AFTER the peer called complete_task:
- focused suite `cd apps/daemon && pnpm exec vitest run --root . --config package.json
  src/work/foundation-attempt --maxWorkers=1 --no-file-parallelism` -> "Test Files 2 passed (2) /
  Tests 33 passed (33)", EXIT=0. Confirms the +5 over QA's 28.
- `grep -c ''`: contracts 218, service 213, store 235, codec 194. All under 250.
- `git status --porcelain -- apps/daemon/src/work/` EMPTY — no drill left on disk.
- All four owned files resolve at HEAD (`git rev-parse HEAD:<path>`).
- Orphan codes confirmed on disk: INPUT_MANIFEST_INVALID produced at store.ts:220 + pinned at
  service.test.ts:1019; RESULT_MANIFEST_INVALID zero hits repo-wide; DISPATCH_SUSPECT produced at
  work/in-flight-attempts.ts:158 + pinned at in-flight-attempts.test.ts:180.
- COMMIT ATTRIBUTION: `11b78f2` is the completion hook's whole-tree commit and carries
  `packages/benchmark/**` + .moe board files, NOT the production bytes. contracts.ts -> ee9ed16,
  service.test.ts -> 4b4ad80, store.ts + service.ts -> foreign sweep 0efcf12.
Disclosure also posted to #general as msg-7061495940ff4f618ded6e16566e8d01.
