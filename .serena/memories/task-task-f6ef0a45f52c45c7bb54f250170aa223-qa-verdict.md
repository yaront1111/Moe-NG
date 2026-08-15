# QA verdict — task f6ef0a doctor host-version root export

Approved DONE on 2026-08-16.

Commit `e391175` changes exactly `apps/daemon/src/index.ts` and `apps/daemon/src/index-surface.test.ts`. Verified the bare root directly publishes the sole existing zero-argument async collector plus exact `DoctorVersionReport` type; no wrapper or second authority. Runtime catalogue pins the exact name/kind, literal 79 cardinality, and exact namespace; compile-time proof pins `Promise<DoctorVersionReport>`. Plain-Node bare-root proof awaits the call and compares the live child platform/Node values. Root is 375 lines, no scratch residue, diff-check clean.

Independent clean-commit gate: materialized `e391175` into a non-git ext4 snapshot, installed the frozen lockfile offline, and ran `pnpm --filter @moe/daemon test && pnpm --filter @moe/daemon typecheck` with the repository-pinned Linux Node v24.16.0 and pnpm 11.0.8. Exit 0; 89 files / 1,825 tests passed; tsc passed. The moving live tree had unrelated uncommitted daemon failures and was not attributed.

Consumer `task-01c5f96ec1e247dc846fd628c929974a` is recorded.