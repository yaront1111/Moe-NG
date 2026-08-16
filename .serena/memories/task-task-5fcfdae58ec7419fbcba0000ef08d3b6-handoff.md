# task-5fcfdae5 — approval authority composed into daemon — QA APPROVED 2026-08-16 (DONE)

Deliverable commit **ee28441**, owned paths byte-identical at review HEAD 91fc622, worktree clean.
Files: `apps/daemon/src/planning/approval-gate.ts` (107) + `.js` bridge,
`planning-services.ts` (221), `planning-services.test.ts` (26 tests),
`bootstrap/bootstrap-ledger.ts` (+2: `...APPROVAL_AUTHORITY_LAYERS` into frozen `SERVICE_REFUSED_BY`).

## What QA independently confirmed
- Composition point: `decideApprovalAuthority` at planning-services.ts:192 — AFTER `durableRun`
  identifies RUN_ID, BEFORE `applyApprovalCommand` and `activateInitialGraph`. Public entry only;
  `checkHumanAuthority`/`refuseApprovalAuthority` never reached around.
- Gate persisted at `workIdentity.humanAuthorityGate`, a SIBLING of the nested lifecycle `state`,
  not inside it. `grep targetAggregateId/aggregateId` proves `proposePlan` (planning-services.ts:120)
  is the ONLY writer of the run aggregate, so the gate cannot be dropped by another service.
- `persistApprovalGate` never lets an existing slot be replaced or cleared; proposal ingress may
  establish only an unsatisfied gate (`grant: null` forced) so a caller cannot mint a human.
- UNREADABLE gate synthesises `unreadable-approval-gate:<workRef>` with `grant: null` -> fails closed
  as APPROVAL_HUMAN_AUTHORITY_REQUIRED @ HUMAN_AUTHORITY_GATE.
- delayMs: `approvalDelayDisposition` (2**31-1). 0 = IMMEDIATE, positive = DEFERRED, above the bound =
  REQUIRE_HUMAN; handler refuses anything non-IMMEDIATE. No timer on this path, so DEFERRED and
  REQUIRE_HUMAN are indistinguishable AT THE HANDLER — an honest equivalent mutant, documented in the
  module comment, not a defect. The next consumer that adds a timer must keep the bound.

## Gates re-run by QA (fresh, at 91fc622)
- owned suites (planning-services + bootstrap-services): 2 files / 37 tests, exit 0.
- `@moe/core`: 31 files / 781 tests, exit 0. Commit touches ZERO core files -> DoD 4 intact.
- scoped daemon tsc (needs `--ignoreConfig`, see `mem:gotcha-scoped-tsc-needs-ignoreconfig`): exit 0,
  positive control with a planted `const probe: number = "nope"` returned TS2322 (probe in Temp,
  outside the repo, deleted).
- `pnpm --filter @moe/daemon typecheck` exit 1: exactly 2 TS2741, both `src/review/*`. Grep of the
  output for owned paths: NONE.
- `pnpm --filter @moe/daemon test` exit 1: 9 files / 28 tests; planning-services.test.ts is among the
  88 PASSED.
- `pnpm typecheck` exit 1 (same 2). `pnpm test` exit 1: runner claude-launcher.windows,
  store recovery-anchor, tests/integration release-archive-cleanup. (store event-read-model-contract
  is now GREEN — the worker's earlier baseline is stale.)
- Delta (HEAD failing paths minus baseline) ∩ owned paths = EMPTY on every leg.

## The attribution, reproduced by QA not taken on trust
5 of the 9 red daemon files die at the SAME `TypeError: Cannot read properties of undefined (reading
'aggregateVersion')` in `recordVerifierReceipt src/review/verifier-receipt-ledger.ts:147` via
`seedVerifierReceipt src/review/review-test-fixtures.ts:329`. Decisive:
`git cat-file -e ee28441:apps/daemon/src/review/verifier-receipt-ledger.ts` ->
"exists on disk, but not in 'ee28441'"; `git log --diff-filter=A` names foreign commit **c970f10**.
The `runtime-entrypoint` bridge guard red names missing bridge `http\event-stream-ack-contract.ts`
(also c970f10) — NOT approval-gate.js, which is present and correct. agent-spawner /
foundation-launch-authority / foundation-attempt-windows are unrelated subsystems.
`SERVICE_REFUSED_BY` widening is uncontested: only consumers are index.ts (re-export) and
index-surface.test.ts (typeof + type equality), both green. review-refusal-vocabulary.test.ts does
NOT reference it — grep confirmed, so its red masks no verdict on this change.

## QA mutation drills (mine, all restored, `sha256sum -c` OK)
- D1 neutralise the `decideApprovalAuthority` call -> "refuses every approval policy for gated work
  before activation" red at `expect(outcome.ok).toBe(false)` (6 tests red).
- D2 let a later propose clear the stored gate -> "keeps the human authority gate on work identity
  across lifecycle transitions" red, `expected null to deeply equal { gateId: 'gate-plan-approval' }`
  — the 2026-08-15 incident reproduced deliberately.
- D3 delete the delayMs bound -> "requires human review instead of clamping an oversized
  auto-approval delay" AND "does not execute a deferred policy decision without a daemon timer" red.

## Open follow-ups for whoever picks this up
- Clause 1 for contract task-5d8f11c86a3a41b4a8a420ef0d52a444 is CLOSED: real consumer edge, durable
  call site. Still unbuilt: control-room approval surface (task-6fcca7da, its approval-gating.ts
  reason channel stays PROVISIONAL) and orchestrator settings binding (task-e4af0e6e).
- No legitimate grant writer exists yet. Proposal ingress deliberately cannot mint grants; whoever
  builds one must carry the same expected-version discipline the approval commit uses.
- A malformed/unknown `approvalPolicy` payload value is fail-closed by construction
  (`{kind:"INVALID_POLICY"}` -> core `assertNever` -> APPROVAL_HUMAN_REVIEW_REQUIRED @ APPROVAL_POLICY)
  but has NO daemon-level test. Not a DoD item here; worth an arm when the next consumer lands.
- `bootstrap-ledger.ts` is 269 lines — over the 250 target, under the 400 split bar, 267 of them
  predating this task. Not a rejection reason; split it if it grows again.
