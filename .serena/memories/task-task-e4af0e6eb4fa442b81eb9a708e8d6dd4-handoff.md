# task-e4af0e6e handoff — DONE (REVIEW), commit ec29d0d

Bind the orchestrator settings to the typed approval policy. Previously BLOCKED for
"no settings load path exists"; a human resolved it with option (a) — apps/daemon owns
the loader plus a real call site. Planning then found the call site ALREADY EXISTED and
was sourcing its policy wrongly, so this was a repair, not a greenfield add.

## The defect that was closed (the thing to remember)

`planning-services.ts` called `decideApprovalAuthority({gate, policy: approvalPolicy(payload)})`.
`approvalPolicy` returned a module-level `DEFAULT_APPROVAL_POLICY = {kind:"PROCEED_WITHOUT_HUMAN",
delayMs: 0}` when the payload key was absent — and `PAYLOAD_KEYS["approval.decide"]` never
allow-listed `approvalPolicy`, so it was ALWAYS absent in production. Every gate-free approval
proceeded immediately on a delay nobody stated: the 2026-08-15 incident's exact mechanism.
See `mem:gotcha-a-default-policy-constant-is-the-live-authority`.

## What landed

- `apps/daemon/src/planning/approval-policy-settings.ts` (82 lines) + LF `.js` bridge + test.
  - `decodeApprovalPolicy(settings: unknown)` — single decision point. PROCEED_WITHOUT_HUMAN is
    constructed from the stated delay and nothing else.
  - `readApprovalPolicySettings(env)` — reads `approvalMode` / `speedModeDelayMs` off
    `MOE_APPROVAL_MODE` / `MOE_SPEED_MODE_DELAY_MS`, following `readStoreDependencyEnv`.
    Converts ONLY on `/^\d+$/u`, else hands the raw value to the decoder to be refused, so
    `Number()` cannot invent a delay from "", " 25 ", "1e3", "0x10".
  - Exports: `APPROVAL_MODE_ENV_KEY`, `SPEED_MODE_DELAY_ENV_KEY`, `SPEED_APPROVAL_MODE`,
    `ApprovalModeSettings`, `decodeApprovalPolicy`, `readApprovalPolicySettings`.
- `planning-services.ts` 221 -> 214 lines: `DEFAULT_APPROVAL_POLICY` and `approvalPolicy(payload)`
  DELETED outright. Delay bound already lived at the consumer (`approvalDelayDisposition`,
  approval-gate.ts:104-107) and REFUSES rather than clamps; only a comment was added.
- Test-tier: `bootstrap-test-fixtures.ts` and `http/affordance-read.test.ts` now STATE their
  approval settings (`process.env[KEY] ??= ...`, SPEED / "0"). Both drive an approval through the
  production handler; their setup throws once it stops defaulting.

## Traps found here, each cost real time

1. **The unit seam bypasses the registry allow-list.** `bootstrap-test-fixtures.send()` calls
   `runBootstrapCommand(store, bytes, ALL_HANDLERS)` directly, so 7 planning tests were pinning a
   payload branch production can never reach. If you delete a payload branch, expect those to move.
2. **`bootstrapSequence()` includes `approval.decide`, and `driveThrough` THROWS on a setup
   refusal.** Any change making gate-free approval refuse reddens goal-services (7 sites),
   bootstrap-durability, j1-command-path in SETUP, not in an assertion.
3. **A satisfied `HumanAuthorityGate` is unreachable through proposal ingress by design**
   (`proposalGate` requires `grant === null`). To test the granted path, seed the durable run:
   `seedPlanningRunResult(store, {state:{goalRef,lifecycle}, submissionHash, workIdentity:{humanAuthorityGate}})`.
4. **Two APPROVAL_POLICY branches answer with the same code+layer** — see
   `mem:gotcha-two-same-layer-refusal-branches-make-a-code-assertion-vacuous`.

## Gate shape

- `pnpm --filter @moe/daemon typecheck` — EXIT 0.
- Owned-path leg used as the completion verification:
  `pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/planning src/bootstrap src/goals src/http`
  -> "Test Files 12 passed (12)" / "Tests 206 passed (206)".
- Package-wide `pnpm --filter @moe/daemon test` was EXIT 1 from task-48c0c0db's live TDD loop in
  `src/work/foundation-attempt-service.test.ts`; delta over merge-base intersected with owned
  paths was EMPTY.

## Still open / next

- Nothing in this task. The daemon wiring (task-5fcfdae5) and the control-room surface
  (task-6fcca7da) remain separate consumers of the same `@moe/core` contract.
- `decodeApprovalPolicy` is exported and takes `unknown`; a revoked Proxy would throw at
  `Array.isArray`. Unreachable from the env path (fresh object literal). Noted, not fixed.
