# Worker handoff — task-6f786c58cabf4f85be8ed4135e68a752 (reopen 1)

## State
Steps 1–8 complete; step 9 IN_PROGRESS; step 10 pending. All QA rejection fixes are implemented and focused recovery is green. The exact daemon completion gate is moving foreign-red.

## QA fixes on disk
- Restore record v2 persists the signed BackupGeneration cursor; completion compares installed and reconciliation cursors before digest construction.
- A narrow recovery authority authenticates a fresh, signed, single-use SessionProof as the explicitly documented R3 command-specific step-up. The durable replay digest is stepUpAuthRef. Authenticated facts feed grantHumanAuthority; signed AGENT refuses APPROVAL_PRINCIPAL_NOT_HUMAN / HUMAN_AUTHORITY_GATE.
- Signed subject binds recovery digest, project/incarnation/key epoch, durable activation policy revision, exact reason, approvalRef, commandId, principalId and derived step-up ref.
- Current policy comes cursor-safely from the durable ProjectActivated witness and is included in the canonical completion digest.
- Replay uses commitExpectedVersionDecision as the exact raw-request identity oracle. Drift refuses RECOVERY_COMPLETION_IDEMPOTENCY_CONFLICT / RECOVERY_COMPLETION with upstream IDEMPOTENCY_CONFLICT / DURABLE_STORE. Direct prior.previousVersion event lookup works after 1,024 earlier events.
- Runtime registry composes createSessionAuthority/createRecoveryCompletionAuthority over the real project store and passes the required authority.
- Root publishes recoveryCompletionApprovalDigest for real clients.

## Fresh focused proof
Exact Node 24.16.0:
`pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/recovery/recovery-completion.test.ts`
=> Test Files 1 passed; Tests 28 passed; exit 0.
Earlier: restore/completion/activation 4 files / 96 passed; registry+completion 2 files / 131 passed; owned root/R3 surface 95 passed / 11 skipped.

## Mutation drills completed and restored by SHA
1. Digest comparison removed => named test expected RECOVERY_COMPLETION_DIGEST_MISMATCH but got approval-invalid.
2. Quarantine scan removed => named case became accepted.
3. Installed cursor comparison removed => signed cursor mismatch became accepted.
4. Authenticated principal forced HUMAN => signed AGENT became accepted.
All bytes restored exactly.

## Size / bridges / commit hazard
Production files are all <400: authority 185, digest 255, evidence 387, replay 143, completion 283, restore contract 293, controller 295, registry 313, root index 379. Recovery .js bridges are exact one-line re-exports. No owned scratch/probe files; git diff --check clean.
Foreign whole-tree commit f4966b5 captured reopen bytes. Never amend/reset/recommit to claim them. Original task commit ddb4753; task base cf272f6. Review by base-ref owned-path diff. Registry still contains foreign WIP.

## Exact environment
`export PATH=/home/sysadmin/.npm/_npx/32bdabe214bd28ec/node_modules/node/bin:/tmp/moe-node2416-bin:$PATH`
`export pnpm_config_verify_deps_before_run=`
Node v24.16.0; pnpm 11.0.8.

## Latest exact gate
After spawner paths became clean, ran fresh:
`pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test`
- typecheck exit 0.
- tests executed 93 files / 1,949 tests; 89 files and 1,944 tests passed; exit 1.
Five foreign failures:
1. graph-preview-request.test.ts package-root subprocess timed out at 5s.
2. index-surface.test.ts project-configuration package-root subprocess timed out at 5s.
3. runtime-entrypoint.test.ts root namespace subprocess timed out at 30s.
4–5. j1-command-path.test.ts goal.close refused GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED.

The gate ran while foreign files changed: j1-command-path.test.ts and index-surface.test.ts became/remained dirty. Their diff adds real review acceptance setup, publishes runReviewCommand/REVIEW_SCHEMA_VERSION and raises a package-root timeout, but the WIP was incomplete during the run. After a 5-minute quiescence wait both remained foreign-dirty. Do not edit/reset/stash/commit them. Governor was notified at msg-fad9d0bd5c104f3db9a0957d02b3408f.

## Resume
When the two foreign test paths are committed/cleared:
1. Re-run exact Node 24.16 daemon gate fresh; require exit 0 and nonzero counts.
2. Complete step 9 with drill + gate evidence.
3. Load adversarial-self-review and finish step 10: inspect owned/base-ref diff, verify no caller bypass/no second ProjectRecovered, bridges/sizes/scratch/git diff check.
4. Run verification-before-completion/regression gate fresh, update this handoff, and complete_task with exact exit-0 output.