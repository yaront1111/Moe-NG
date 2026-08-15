# QA approval handoff: daemon restore controller

Task `task-2ff368fe2de44028b4a7d6ca89687933` was re-reviewed after reopen fixes at task commits `da5f24c`, `fcf2cfb`, `24a3fea`, and `759cdc5`. Later commits do not change the owned paths.

Verified all three prior rejection issues:
- A real restore through `createRestorePort` now commits a canonical EFFECTS_COMMITTED command decision/event plus ACTIVE binding with `commitExpectedVersionDecisionWithApply`; reopen/refold reports lifecycle QUIESCED, recoveryRequired=true, version 4.
- Request intake uses exact own data descriptors, rejects accessors/custom arrays, and passes only the frozen snapshot into scoped resume/discard.
- `readInstalledRestore` cross-checks payload incarnation/key-epoch against the verified ACTIVE envelope and returns exact RESTORE_RECORD_UNREADABLE/DAEMON_RESTORE_CONTROLLER on mismatch.

Fresh foreground evidence:
- Required `pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test`: exit 0, 63 files / 946 tests.
- Store scope gate `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test`: exit 0, 39 files / 444 tests.
- Plain Node from apps/daemon loaded restore-controller plus bare `@moe/core` and `@moe/store`, and confirmed the atomic store method: BARE_CHAIN_OK.
- Manifest and lock importer contain workspace dependencies on both packages.
- Design hash remains 1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191; bridges are one-line LF; diff-check and owned working paths are clean; every touched production file is below the hard 400-line split bar.

Independent QA mutation drills:
1. Disabled the new store apply call. All three command-decision-apply tests reddened, including exact `expected 0 to be 1`; restored SHA-256 CCA3512F...62A0C and 3/3 green.
2. Replaced descriptor snapshotting with direct property reads. The named stateful-accessor regression reddened because the restore incorrectly succeeded; restored SHA-256 F336067D...7FD1 and 6/6 green.

DoD mapping checked: real core reducer and production entry caller; atomic canonical lifecycle+binding commit and rollback; deterministic resume/inspect/discard fences; exact refusal code/layer sweeps with positive counts; recorded mutation evidence; focused gates green. Approved.