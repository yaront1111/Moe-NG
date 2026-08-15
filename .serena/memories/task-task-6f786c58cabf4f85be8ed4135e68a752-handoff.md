# QA handoff — task-6f786c58cabf4f85be8ed4135e68a752 (REJECTED, reopen 1)

Rejected on 2026-08-15 for DoD 1/2/4/5.

## Verified
- Reviewed base-ref task paths from `d01a512..HEAD`.
- Before live peer edits, all 12 task-path working blobs matched HEAD.
- Production line counts: digest 257, evidence 342, service 339; all below the 400 hard cap.
- Three JS bridges exactly re-export their TS siblings.
- Focused direct Vitest under Linux Node 24: `recovery-completion.test.ts` — 1 file / 22 tests passed.
- Literal `pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test` could not start because this QA shell has no pnpm (exit 127). Direct TS 7 / full Vitest later saw only live foreign WIP/environment failures: index-surface doctor export edits, untracked provider-run-codec test, planning-services test WIP, Node pin and plain-Node timing. Do not attribute these to this task.

## Blocking defects
1. **Unbound RPO cursor.** `recovery-completion-evidence.ts:221` copies `record.backupCursor`; `crossCheck` compares only generation digest. Production restore harness creates a signed BackupGeneration at the real database cursor, but the positive completion fixture hard-codes cursor 42 and still clears QUIESCED. The installed verified manifest cursor must be persisted/read and matched before digest approval.
2. **Fabricable human/step-up.** `recentStepUp` checks only timestamp + hex64 shape. The accepted suffix is arbitrary `hex("5e")`, not bound to digest/project/incarnation. Approval record and command are caller payloads; core validates shape/lifecycle, not human identity. Agents can hold ADMIN. Compose authenticated durable human authority and exact step-up binding.
3. **DoD-5 inputs not bound.** policy revision, decisionReason and stepUpAuthRef are not recovery-digest inputs or current durable reads. Changes remain accepted.
4. **Replay bypass.** `answerReplayed` ignores `prior.requestSha256` and checks only reconciliationDigest; changed approval/reason/step-up/version returns REPLAYED rather than idempotency conflict. It also scans only the first 1,000 events.

Moe rejectionDetails contain exact files/lines and required tests.