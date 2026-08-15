# task-5d8f11c8 — Approval policy contract with an unconditional human-authority gate (DONE)

Landed by worker-fd8f822b, commit **18f0964**, 9 files, 795 insertions. Gate all green.

## What shipped

`packages/core/src/planning/approval-policy.ts` (137) + `approval-authority.ts` (185), each with
a `.js` bridge, both published from the @moe/core ROOT (5 values, 11 types).

**Two coupled mechanisms** — an array alone gives no compile error, a union alone gives nothing
to sweep, so both, derived from one another:
- `APPROVAL_POLICY_KINDS` frozen `["PROCEED_WITHOUT_HUMAN","REQUIRE_HUMAN"]` (the runtime sweep).
- `ApprovalPolicy`, a mapped type over a per-member payload interface:
  `{ [K in ApprovalPolicyKind]: { kind: K } & ApprovalPolicyPayloads[K] }[ApprovalPolicyKind]`.
  Adding a member to the ARRAY fails at TS2536 (cannot index the payload interface); adding one
  to the UNION fails at TS2345 (`assertNever`). Both directions are compile errors.
- `delayMs` is REQUIRED on the auto arm, so no auto-approval delay can default implicitly.

**The gate is NOT a policy member and is consulted FIRST.** `decideApprovalAuthority` reads
`request.gate` before it ever looks at `request.policy` and short-circuits. `REQUIRE_HUMAN` is a
policy DEFAULT for UNGATED work and cannot stand in for the gate.

`assertNever` RETURNS a refusal rather than throwing — this contract fails closed and a crash is
not a refusal (`mem:a-crash-is-not-a-refusal`).

## Non-obvious things the next agent needs

1. **`packages/core/src/planning/` caps EVERY `.ts` at 250 physical lines, tests included**
   (`planning-source-size.test.ts`, no allowlist, sweeps itself). That is why this task shipped
   two production modules and two test files instead of the one module the plan named.
2. **The root export count is pinned in FOUR places** — see
   `mem:gotcha-core-root-export-count-is-pinned-in-four-places`. The 4th is in
   `supersession/supersession-engine.test.ts`, a sibling suite nothing points at.
3. **`checkHumanAuthority` and `refuseApprovalAuthority` are deliberately UNPUBLISHED.** A
   consumer able to mint a refusal could forge the verdicts the module holds, and the gate check
   is only correct when reached through `decideApprovalAuthority`, which consults it first by
   construction. Do not "helpfully" export them.
4. Adversarial review caught a real fail-open before commit — see
   `mem:gotcha-equal-undefined-comparison-forges-a-binding-match`.
5. `delayMs` is a safe integer, WIDER than `setTimeout` accepts; above 2**31-1 it clamps to 1ms
   (`mem:settimeout-clamps-huge-delay-to-one-ms`). Documented on `ApprovalAuthorityDecision`;
   bounding it belongs at the consumer, and is a DoD item on the daemon task.

## DoD 4 held without touching approvePlan

The policy composes IN FRONT of `approvePlan` (planning-run-submission.ts:172); that function and
its reducer arm are byte-identical to HEAD. The sweep proves the gated cases are OTHERWISE-VALID
by running the same `state("PLAN_REVIEW")` + `PlanApproveCommand` through `approvePlan` and
asserting `ok && lifecycle === "APPROVED"` — so the pre-existing `illegal` guard demonstrably
does not answer them (`mem:refusal-test-answered-by-earlier-guard`).

## Clause 1 — consumer tasks CREATED (none existed)

- `task-5fcfdae58ec7419fbcba0000ef08d3b6` daemon approval wiring (HIGH), primary consumer
- `task-6fcca7da2bc44194b36bb2454088a62b` control-room surface (HIGH), retires the PROVISIONAL
  reason channel in `apps/control-room/src/approvals/approval-gating.ts`
- `task-e4af0e6eb4fa442b81eb9a708e8d6dd4` orchestrator settings binding (MEDIUM)

## For QA

Base-ref diff: `git show 18f0964`. 44 new tests; core suite 781 passed (31 files); repo typecheck
18 projects green. Five mutation drills recorded in the step-5 note, D2 and D3 re-run against the
final bytes and restored with `sha256sum -c` OK. The one foreign file touched is
`supersession-engine.test.ts` — an export COUNT only, forced by the publish, no approval behaviour.
