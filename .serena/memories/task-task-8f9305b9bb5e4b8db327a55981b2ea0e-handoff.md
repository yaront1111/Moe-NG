# task-8f9305b9 — Review-qualified goal closure (BLOCKED, not planned)

Architect: architect-d46fcb95, 2026-08-09. Epic M1 Foundation Preview. CRITICAL.

## Verdict
Blocked on hard dependency **task-44d4873eb9f746b1a978e97ff9743dc4 "Durable verification receipt dispatch"**, which is PLANNING, not DONE. No prerequisite created — it already exists; a second would be a silent duplicate.

## Measurements
- `grep -rln "EvidenceReceipt|evidence_receipt|evidenceReceipt" apps/daemon/src packages/store/src` → **ZERO**. No durable EvidenceReceipt record, table, writer or reader exists.
  - **Decoy to avoid re-tripping on:** a broad `grep -rln "eceipt"` over the store returns ~50 files. They are all `command_receipts`, `inbox_receipts`, `command_receipt_scopes` in `sqlite-schema-manifest.ts` — command-dedupe/idempotency plumbing, nothing to do with evidence. Grep the exact symbol, not the substring.
- `ls apps/daemon/src/evidence/` → **DIRECTORY ABSENT**. task-44d4873e's owned path holds nothing.
- So DoD 1 and DoD 2's missing-receipt / non-passing-or-UNKNOWN-receipt / mismatched-result-hash clauses have no durable subject.

## What IS ready
- task-9011e3b32c414e9ca0d49f49fdfaaf08 (review persistence) is DONE. `apps/daemon/src/review/review-acceptance.ts` exports `decideEscalation` and `acceptOutput`, and emits `ReviewOutputAccepted` at `:119`.
- **Caveat for the next planner:** `ReviewOutputAccepted` is only ever EMITTED — `grep` finds no reader. The closure composer needs a read path for the accepted-output record keyed by candidate/result, and that may itself need a prerequisite task. Do not assume the review half is turnkey just because its task is DONE.

## The gap the task describes IS real
`apps/daemon/src/goals/goal-services.ts` is 114 lines and pulls `closureWitness` and `zeroAuthorityWitness` straight off `request.payload` (lines 80-92) with no durable check. Its own comment claims "Acceptance is evidence-bound BY CONSTRUCTION" — true only of the core reducer's shape requirement, not of the witnesses' provenance. That is exactly the authority gap worth closing once the receipts exist.

## Dependency chain, as measured
task-69f2b6f785ca (Verification process wrapper) **DONE** → task-44d4873e (Durable verification receipt dispatch) **PLANNING** → this task.

## Unblock condition
task-44d4873e DONE **and** `apps/daemon/src/evidence/` carrying a receipt read model.
