# task-f6c9011b — CLOSED, DONE 2026-08-10

Git ref + artifact object enumeration. Approved round 3 by qa-f3560083 after two
DoD-3 rejections. Verdict evidence: `mem:task-task-f6c9011b24634de7b22ad10a26579883-qa-verdict`
and `comment-34d3ad427f9f45c091fd45f2ddf04879`.

## What shipped (for the consumer task)
- `GitObserver.listRefs()` — bounded ref enumeration via the hermetic `runGit`
  (`shell:false`, `maxBuffer: MAX_SCOPE_OBSERVATION_BYTES`, `timeout`,
  `windowsHide`). Grammar in `packages/runner/src/scope/scope-refs.ts`;
  spawn-failure classification in `packages/runner/src/scope/scope-git-classify.ts`
  (`classifyRefFailure`, exported, layer always `GIT_OBSERVER`, ENOBUFS promoted
  to `RUNNER_SCOPE_OBSERVATION_OVERFLOW`).
- `ArtifactFsPort.listDirectory()` + `ArtifactStore.enumerateArtifacts()` over
  `<root>/objects/<sha256>` — `packages/runner/src/artifacts/artifact-enumeration.ts`.
  Refusals: `RUNNER_ARTIFACT_ADDRESS_CORRUPT` @ `ARTIFACT_STORE` for a bad name,
  non-FILE entry, or digest mismatch; `RUNNER_ARTIFACT_VERIFY_FAILED` @
  `ARTIFACT_FS_PORT` for an unreadable entry or an unreadable listing.
  **Grammar runs BEFORE `readAll`** — an entry name that is not valid lowercase
  64-hex (or a staging temp) never reaches the read.

Consumer per global rail clause 1: task-0325dcf7ee744123b40cf583230c7b6a's
Git/integration and artifact/staging adapter child. Nothing imports these yet.

## Gate at approval
`pnpm --filter @moe/runner typecheck && test` = 0/0, 46 files / 1421 tests.
Repo-wide typecheck 0. scope-git.ts 232 lines, scope-git-classify.ts 35,
artifact-enumeration.ts 165 — all under the per-file cap.

## Live foreign red someone else owns
Repo-wide `pnpm test` exits 1 on `tests/fault/foundation/j1-linear.test.ts:225`:
`probe:scheduler-hot-claim-admission` expected `PRODUCTION_BEHAVIOR_ABSENT`, got
`PASS_EXPECTED`. Caused by `2c93542` (task-e8e27f76) publishing scheduler root
exports; the expectation row in
`packages/testkit/src/foundation/foundation-incident-schedules.ts:107-114`
needs updating. Zero @moe/runner in that test's import closure — do not attribute
it to a runner task.

## Convention this package enforces
Every non-test module in `packages/runner/src/scope` needs a one-line `.js`
bridge (`export * from "./x.ts";`); `runtime-entrypoint.test.ts` asserts the
bridge set and reddens without it.
