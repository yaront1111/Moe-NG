# Handoff: task-4a3b5ec0 — reopen fixes complete, QA APPROVED

## Final state (QA qa-cbad3a29, 2026-08-09)
APPROVED. Full verdict with mutation receipts: `mem:task-task-4a3b5ec031f14079bce4141abf922905-qa-verdict`.
Gate at approval: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` exit 0,
20 files / 717 tests. Owned worktree diff and staged index both empty; zero drift in this task's
production files since baseline commit `7528e00`.

## Reopen scope (worker record, preserved)
QA requested exactly two test hardenings; production was already verified clean in commit `7528e00`.

1. `packages/runner/src/supervisor/launch-lock.test.ts`
   - The six SUSPECT rows now carry the literal expected layer `LAUNCH_LOCK`.
   - Assertion is exact `toEqual({ code, layer })`; the separate malformed-claim arm still pins
     `EFFECT_CLAIM_MALFORMED / KERNEL`.
   - Mutation re-stamping `LAUNCH_LOCK_SUSPECT` as `KERNEL` is killed — QA re-ran it: 2 FAIL.
2. `packages/runner/src/supervisor/restart-reconstruction.test.ts`
   - Terminal attempt + reconciliation + UNKNOWN resource now asserts exact `post:UNKNOWN`.
   - Mutation returning `post:SUSPECT` is killed — QA re-ran it: 1 FAIL.

Both production files restored hash-identical after every drill.

## Surface left behind for child 3 / child 4
`launch-lock.ts` (138), `duplicate-delivery.ts` (153, exports `DUPLICATE_DELIVERY_KINDS`),
`process-observation.ts` (88), `drain-table.ts` (210, frozen R1-R6 + disposition rank),
`drain-reconciliation.ts` (227, `resolveDrainRow`), `restart-reconstruction.ts` (188,
`RESTART_POST_STATES` + `reconstructAfterRestart`). `effect-kernel.ts` / `effect-lifecycle.ts`
were EXTENDED append-only (3 layers, 13 codes, the design-776 ACTIVE -> CANCEL_REQUESTED arc).
No syscalls, no clock, no randomness — every OS fact is a caller-supplied observation.

## Git attribution hazard (still live for the next task)
Foreign task `f837ce` fired its completion hook while these two tests were modified; the hook swept
the exact fixes into pushed commit `34a3d11` with 23 foreign paths. The owned patch is inspectable:
`git diff 34a3d11^ 34a3d11 -- packages/runner/src/supervisor/launch-lock.test.ts packages/runner/src/supervisor/restart-reconstruction.test.ts`.
Do not rewrite/revert it and do not manufacture a no-op edit.
Same runtime defect as `mem:gotcha-completion-hook-commits-whole-tree`.
