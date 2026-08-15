# Task task-6fcca7da2bc44194b36bb2454088a62b handoff

Replaced the control-room approval surface's provisional runtime-error channel with the landed `@moe/core` approval authority vocabulary.

Owned/base-ref review paths:
- `apps/control-room/package.json`
- `pnpm-lock.yaml`
- `apps/control-room/src/approvals/approval-gating.ts`
- `apps/control-room/src/approvals/approval-inbox.tsx`
- `apps/control-room/src/approvals/approval-gating.test.tsx`
- `apps/control-room/src/approvals/approval-details.test.tsx`
- `apps/control-room/src/approvals/approval-inbox.test.tsx`

The `@moe/core` edge is `workspace:*` and the lock importer resolves `link:../../packages/core`; a trap-cleaned bare-specifier probe typechecked and left no file. `approval-gating.ts` has an exhaustive 6 gate / 2 policy code-layer record, a correlated ApprovalReason union, runtime reason normalization, optional authority evaluation before local guards, hostile-safe single-read snapshots, and duplicate-control deduplication. `approval-inbox.tsx` visibly renders exact code/layer plus policy, gate, and validated human grant facts; it has no grant/force affordance.

TDD evidence: original feature red 14/20; adversarial additions red on forged code-layer pass-through and duplicate controls (2 failed/21 passed), and a getter-read test proved 2 reads; final targeted 23/23 and full control-room 70 files/860 tests. Mutation drill changed APPROVAL_HUMAN_REVIEW_REQUIRED to HUMAN_AUTHORITY_GATE, the literal code@layer test failed, and original bytes/hash were restored.

Fresh final exact gate exit 0 in path-attributed ext4 snapshot with byte-identical owned paths: control-room 70/860; root 273 files, 6504 passed +3 skipped; foundation 32/661; store 42/501; daemon task-start baseline 89/1823. Current HEAD's foreign daemon delta remains red outside owned paths: `apps/daemon/src/runtime-entrypoint.test.ts` missing `orchestrator/verifier-process-runner.ts` bridge and two `apps/daemon/src/goals/j1-command-path.test.ts` failures with `GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED`.

A foreign whole-tree commit `f4966b5` captured the first five-step owned bytes. Do not amend/reset it. QA must review `git diff ddb4753e052ec2d7d27fcc4cabf0b60cdfe0b6e8..HEAD -- <owned paths>` plus the remaining two-file working diff. Production line counts: gating 240, inbox 231; gating test 300.