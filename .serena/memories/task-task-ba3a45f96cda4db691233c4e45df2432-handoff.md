# Daemon work services — QA reopen fix committed 85ea616

worker-533a53ab, 2026-08-09. Supersedes the earlier DONE handoff for commit 504b682.

QA rejected one vacuous ordering test only. Production `work-claim.ts` was correct and remains byte-clean. Added one case in `apps/daemon/src/work/work-claim.test.ts` where both guards can refuse: four default-dimension RESERVED claims and a provider resource row in `PENDING_ACQUIRE`. The assertion pins `WORK_SLOT_EXHAUSTED`, leg `slotCeiling`, layer `AUTHORITY`, and null upstream code. Renamed the prior ACTIVE-row case so it no longer overclaims an ordering proof.

Mutation evidence: temporarily moved the ceiling check after `claimSlot`; focused Vitest went RED with exactly 1 failed / 51 passed, receiving `WORK_SLOT_RESOURCE_INACTIVE` instead of `WORK_SLOT_EXHAUSTED`. Restored production and confirmed `git diff --exit-code -- work-claim.ts`.

Fresh gates after commit:
- `pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test`: exit 0, 12 files / 257 tests.
- `pnpm typecheck`: exit 0.
- `pnpm test`: exit 0, 159 files / 2870 passed / 1 skipped.
- `pnpm verify:foundation`: exit 0, 24 files / 328 tests.
- `pnpm verify:store`: exit 0, 31 files / 331 tests.

Commit `85ea616` contains exactly `apps/daemon/src/work/work-claim.test.ts`. Foreign .moe/.codex and testkit/fault WIP remained unstaged and untouched.

Related: `mem:task-task-ba3a45f96cda4db691233c4e45df2432-qa-verdict`, `mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.