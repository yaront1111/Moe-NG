# Worker handoff — task-6f786c58cabf4f85be8ed4135e68a752 (reopen 1)

## State
Steps 1–8 are complete. Step 9 is IN_PROGRESS; step 10 is pending. The QA rejection has been repaired and the focused recovery surface is green, but the exact daemon completion gate is currently blocked by foreign shared-tree WIP.

## QA fixes now on disk
- Restore record schema v2 persists the signed BackupGeneration cursor; completion compares installed cursor to reconciliation cursor before digest construction.
- Added a narrow recovery authority using a fresh signed, single-use SessionProof as the explicitly documented R3 command-specific step-up. The durable replay digest is the stepUpAuthRef. Authenticated facts feed grantHumanAuthority; signed AGENT refuses APPROVAL_PRINCIPAL_NOT_HUMAN / HUMAN_AUTHORITY_GATE.
- The signed recovery-approval subject includes recovery digest, project/incarnation/key epoch, durable activation policy revision, exact decision reason, approvalRef, commandId, principalId and derived step-up ref.
- Current activation policy revision is read cursor-safely from the durable ProjectActivated witness and is part of the completion digest.
- Replay now re-enters commitExpectedVersionDecision with the caller's exact raw request identity. Drift refuses RECOVERY_COMPLETION_IDEMPOTENCY_CONFLICT / RECOVERY_COMPLETION with upstream IDEMPOTENCY_CONFLICT / DURABLE_STORE. Durable event lookup jumps from prior.previousVersion and works after 1,024 prior events.
- Runtime registry constructs createSessionAuthority/createRecoveryCompletionAuthority over the real project store and passes the now-required authority into runRecoveryCompleteCommand.
- Public root exports recoveryCompletionApprovalDigest so clients sign the production canonical subject.

## Fresh focused evidence
Under exact Node 24.16.0:
`pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/recovery/recovery-completion.test.ts`
=> Test Files 1 passed; Tests 28 passed; exit 0.

Earlier focused runs:
- restore + completion + activation: 4 files / 96 tests passed.
- registry + completion: 2 files / 131 tests passed.
- owned index/R3 surface: 95 passed / 11 skipped.

## Mutation drills completed and byte-restored
1. Disable exact recovery-digest comparison: named digest test reddened on expected RECOVERY_COMPLETION_DIGEST_MISMATCH vs approval-invalid.
2. Disable unresolved-quarantine scan: named quarantine test became accepted and reddened.
3. Remove installed-cursor comparison: signed cursor mismatch test became accepted and reddened.
4. Force authenticated principalKind HUMAN: signed AGENT test became accepted and reddened.
All target SHA-256 values matched after restoration.

## Production size / bridges
All production files are below the binding 400-line cap: authority 185, digest 255, evidence 387, replay 143, completion 283, restore contract 293, restore controller 295, registry 313, root index 379. Four recovery completion .js bridges are exact one-line wildcard re-exports. No recovery probe/backup/scratch file remains. `git diff --check` on owned recovery/index/registry paths is clean.

## Completion-hook hazard
Foreign whole-tree commit f4966b5 (task-6cbff010) captured the reopen bytes, including recovery-completion-authority/replay and related changes. Do not amend/reset/recommit to claim them. QA must review the base-ref owned-path diff and committed bytes. Original task commit is ddb4753; base before the task is cf272f6. Registry files still carry live foreign operator-principal WIP and remain modified; do not stage/overwrite them.

## Exact gate blocker
Use:
`export PATH=/home/sysadmin/.npm/_npx/32bdabe214bd28ec/node_modules/node/bin:/tmp/moe-node2416-bin:$PATH`
`export pnpm_config_verify_deps_before_run=`
Node is v24.16.0 and pnpm is 11.0.8.

Fresh exact command:
`pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test`
currently exits 1 before tests solely in foreign WIP:
- apps/daemon/src/orchestrator/agent-spawner.test.ts:237 killProcessGroup absent and callback params implicit-any
- :273/:274 killGraceMs absent and callback pid implicit-any
- :315 killGraceMs absent

The three foreign dirty paths are agent-spawner.ts, agent-spawner.test.ts and agent-spawn-invocation.ts. They contain unrelated process-group/timeout/UNQUOTABLE changes predating producer task-d4329e8. Governor is identifying their owner; nobody may overwrite/reset/stash them. Focused recovery remains 28/28 green.

## Resume
Once those foreign paths are committed/cleared:
1. Run the exact daemon gate fresh under Node 24.16.0 and require a nonzero Vitest count plus exit 0.
2. Complete step 9 with the four drill results and exact gate evidence.
3. Load adversarial-self-review for step 10; inspect the base-ref owned-path diff, run regression/verification-before-completion, confirm no caller bypass and no second ProjectRecovered.
4. Write final handoff and call complete_task with the exact command/exit 0/output tail.