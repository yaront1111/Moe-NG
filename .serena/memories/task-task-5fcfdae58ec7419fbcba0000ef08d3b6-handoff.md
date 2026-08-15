# task-5fcfdae5 — approval authority composed into daemon (implementation committed, verification blocked)

Commit **ee28441** owns exactly:
- apps/daemon/src/bootstrap/bootstrap-ledger.ts
- apps/daemon/src/planning/approval-gate.ts + .js
- apps/daemon/src/planning/planning-services.ts + .test.ts

What shipped:
- Real daemon command is `approval.decide` (not description's `plan.approve`).
- `plan.propose` persists an unsatisfied HumanAuthorityGate under the RUN_ID result's `workIdentity`, outside nested lifecycle `state`; later release -> reclaim -> repropose preserves it and caller null cannot clear it.
- `decideApproval` reads that durable gate, calls the public `decideApprovalAuthority` after durable-run identification and before core approval/activation, and surfaces contract code/layer unchanged.
- ABSENT vs UNREADABLE gate states are distinct; unreadable synthesizes an ungranted sentinel and fails closed.
- Proposal ingress rejects caller-shaped granted gates (normalizes them to unreadable); otherwise a forged coherent HumanAuthorityGrant could override REQUIRE_HUMAN.
- No timer exists in this daemon path. Zero delay is immediate; positive representable delay remains deferred; >2**31-1 becomes REQUIRE_HUMAN. Both non-immediate results refuse as APPROVAL_HUMAN_REVIEW_REQUIRED @ APPROVAL_POLICY rather than activating.
- Corrupt/null persisted run state cannot be recreated: only undefined means absent.

Evidence:
- TDD + six planned mutation drills recorded on task step 6; D6 split into code-only and layer-only mutants.
- Fresh focused final: planning-services.test.ts **26/26 passed**.
- Fresh core gate: **31 files / 781 tests passed**, exit 0.
- Production LOC: planning-services.ts 221, approval-gate.ts 107.
- Task paths clean after explicit-path commit ee28441.

BLOCKER:
Exact daemon gates cannot become green while preserving foreign shared-tree WIP. `pnpm --filter @moe/daemon typecheck` fails on untracked provider-run-codec.test.ts importing absent provider-run-codec.js and foreign foundation-attempt-service.test.ts; exact daemon test similarly fails provider codec plus other foreign in-flight daemon mismatches/timeouts. The provider test pre-existed this task at start; task-fc658104 is WORKING 2/7 with no assigned worker. Governor acknowledged msg-7f22d719... and routed it to #workers. Do not delete/reset/stash foreign files or fabricate exit 0. Re-run exact daemon typecheck/test when foreign tasks land/clear, then complete step 7 and task.

Clause 1: this closes the real consumer edge for contract task-5d8f11c86a3a41b4a8a420ef0d52a444. Remaining consumers are not done: control-room approval surface task-6fcca7da... and orchestrator settings task-e4af0e6e... (the latter is currently blocked because the live settings/timer consumer is outside moe-next). A legitimate gate-grant writer remains for the control-room/authority-bearing consumer; proposal ingress deliberately cannot mint grants.