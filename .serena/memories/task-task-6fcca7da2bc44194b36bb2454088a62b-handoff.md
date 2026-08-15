# task-6fcca7da — control-room approval authority vocabulary plan (APPROVED)

Plan approved in SPEED mode with 6 steps / 5 owned paths:
- `apps/control-room/package.json`
- `pnpm-lock.yaml`
- `apps/control-room/src/approvals/approval-gating.ts`
- `apps/control-room/src/approvals/approval-inbox.tsx`
- `apps/control-room/src/approvals/approval-gating.test.tsx`

Fresh measurements:
- Authoritative-design SHA-256 matched `1d9d1ec97d3f07247fbbc088045e0ba2fd6da8307f10a9026c55106419383191`.
- D2 PROVISIONAL marker remains at approval-gating.ts:21.
- @moe/core root publishes APPROVAL_AUTHORITY_CODES/LAYERS, APPROVAL_POLICY_KINDS, decideApprovalAuthority, ApprovalPolicy, HumanAuthorityGate, and HumanAuthorityGrant.
- The consumer edge is absent from both control-room package.json and the lock importer; step 1 owns the scoped workspace install and an in-package, trap-deleted bare-specifier typecheck probe.
- Current production sizes are approval-gating.ts 229 lines and approval-inbox.tsx exactly 250, so the plan requires compacting obsolete commentary/helpers to keep each <=250.

Approved design:
- Replace RuntimeErrorCode/source ApprovalReason with the eight landed codes and an exhaustive canonical code→layer map (first six HUMAN_AUTHORITY_GATE, last two APPROVAL_POLICY).
- Keep the local client guard ID separate from the stable refusing layer.
- A supplied authority context is evaluated once through decideApprovalAuthority before local guards; a refusal nulls commandId.
- Translate local stale lifecycle/validity/hash cases to APPROVAL_AUTHORITY_BINDING_MISMATCH@HUMAN_AUTHORITY_GATE while preserving precise phrases and guard IDs.
- Do not invent policy/gate/grant when context is absent; nextAllowedCommands remains the existing zero-authority UI boundary until separately scoped daemon wiring.
- DecisionControl visibly renders code + layer and truth-preserving policy/gate/grant facts; production never imports/calls grantHumanAuthority or adds a force/grant affordance.

Tests pin all eight literal code@layer pairs with nonzero/exact cardinality, gate-layer and policy-layer visible refusals, granted-gate rendering, and every approval decision kind refused/absent for a gated unit. Required mutation changes one production mapping, proves that named test red, restores byte-exact by SHA-256, then runs the full named repo gate.