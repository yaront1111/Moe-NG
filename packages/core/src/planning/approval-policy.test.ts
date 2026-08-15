/**
 * DoD 1 (a closed, frozen policy vocabulary whose auto-approval delay is an
 * explicit typed value) and DoD 2 (the human-authority gate refuses under EVERY
 * policy member).
 *
 * WHY THE GATED CASES ARE OTHERWISE-VALID APPROVALS, and why this file would be
 * worthless otherwise. The landed `approvePlan` refuses a malformed witness with
 * `illegal(state, command.kind)`. A gated case built on a bad witness would be
 * answered by THAT guard, and every assertion below would stay green while
 * proving nothing whatsoever about the gate. So the same state and command are
 * first put through `approvePlan` and asserted ACCEPTED; the refusals here are
 * therefore attributable to the gate, and each one names the layer that answered.
 */
import { expect, it } from "vitest";

import type { HumanAuthorityGate } from "./approval-authority.js";
import { grantHumanAuthority } from "./approval-authority.js";
import { APPROVAL_POLICY_KINDS, decideApprovalAuthority } from "./approval-policy.js";
import type {
  ApprovalAuthorityResult, ApprovalPolicy, ApprovalPolicyKind,
} from "./approval-policy.js";
import type { PlanApproveCommand } from "./planning-contract.js";
import { approvePlan } from "./planning-run-submission.js";
import { PLAN_APPROVAL, state } from "./planning-run-test-fixtures.js";

const GATE_ID = "GO_ACTIVATE";
const WORK_REF = "task-09008b4c";
const MOMENT = 1_755_216_000_000;

const gated = (): HumanAuthorityGate => ({ gateId: GATE_ID, grant: null, workRef: WORK_REF });
const HUMAN = { kind: "HUMAN", principalId: "human:yaron", profileRevisionId: "profile-1" };

/** Carries the stable code AND the refusing layer, so no assertion can pass on "not approved". */
const outcome = (result: ApprovalAuthorityResult): string =>
  result.ok ? `PROCEED(${result.delayMs},${result.grant === null ? "NONE" : "HUMAN"})`
    : `${result.code}@${result.layer}`;

/**
 * Exhaustive by construction. A new vocabulary member with no arm here leaves
 * this function unable to satisfy its declared `ApprovalPolicy` return type, so
 * the sweep below cannot silently skip a member that was added to the array.
 */
function policyFor(kind: ApprovalPolicyKind): ApprovalPolicy {
  switch (kind) {
    case "PROCEED_WITHOUT_HUMAN": return { delayMs: 2_000, kind };
    case "REQUIRE_HUMAN": return { kind };
  }
}

interface SweptCase {
  readonly kind: ApprovalPolicyKind;
  readonly policy: ApprovalPolicy;
}

const GATED_CASES: readonly SweptCase[] =
  APPROVAL_POLICY_KINDS.map((kind) => ({ kind, policy: policyFor(kind) }));

it("names exactly the reviewed approval policy vocabulary", () => {
  expect([...APPROVAL_POLICY_KINDS]).toEqual(["PROCEED_WITHOUT_HUMAN", "REQUIRE_HUMAN"]);
  expect(Object.isFrozen(APPROVAL_POLICY_KINDS)).toBe(true);
});

it("cannot express proceed-without-human without stating its delay", () => {
  // @ts-expect-error - `delayMs` is required. An auto-approval delay that
  // defaults implicitly is the exact mechanism of the incident this contract
  // exists to prevent, so the type system refuses to express one.
  const withoutDelay: ApprovalPolicy = { kind: "PROCEED_WITHOUT_HUMAN" };
  expect(withoutDelay.kind).toBe("PROCEED_WITHOUT_HUMAN");
});

/**
 * The pre-existing guard demonstrably does NOT answer the gated inputs below:
 * `approvePlan` ACCEPTS this exact state and command. Whatever refuses them in
 * the sweep can only be the new gate.
 */
const APPROVE: PlanApproveCommand = {
  commandId: "cmd-plan.approve", expectedVersion: 7, kind: "plan.approve", witness: PLAN_APPROVAL,
};

it("uses a plan approval that the landed approvePlan accepts on its own", () => {
  const landed = approvePlan(state("PLAN_REVIEW"), APPROVE);
  expect(landed.ok).toBe(true);
  if (!landed.ok) throw new Error("fixture is not an otherwise-valid approval");
  expect(landed.state.lifecycle).toBe("APPROVED");
});

it("generates one gated case per approval policy member", () => {
  expect(GATED_CASES.length).toBe(APPROVAL_POLICY_KINDS.length);
  expect(GATED_CASES.length).toBeGreaterThan(0);
});

/**
 * THE CENTRAL TEST. Every policy member, against a gated unit of work, refuses
 * at the gate layer with the same stable code. No ApprovalPolicy value or
 * combination approves gated work; the gate is not satisfiable by configuration.
 */
it("refuses gated work under every approval policy member", () => {
  const answered = GATED_CASES.map(({ kind, policy }) =>
    `${kind}:${outcome(decideApprovalAuthority({ gate: gated(), policy }))}`);
  expect(answered).toEqual(GATED_CASES.map(({ kind }) =>
    `${kind}:APPROVAL_HUMAN_AUTHORITY_REQUIRED@HUMAN_AUTHORITY_GATE`));
  expect(answered.length).toBe(APPROVAL_POLICY_KINDS.length);
});

/**
 * THE ORDERING TEST. Both layers can refuse this one input: the gate is
 * ungranted AND the policy states an impossible delay. The gate is consulted
 * first and short-circuits, so the gate layer answers. The second assertion
 * proves the policy layer really would have answered it — without that, "the
 * gate answered" would be consistent with a policy layer that simply never
 * refuses anything.
 */
const IMPOSSIBLE: ApprovalPolicy = { delayMs: -1, kind: "PROCEED_WITHOUT_HUMAN" };

it("answers from the gate layer when the policy layer could also refuse", () => {
  expect(outcome(decideApprovalAuthority({ gate: gated(), policy: IMPOSSIBLE })))
    .toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED@HUMAN_AUTHORITY_GATE");
  expect(outcome(decideApprovalAuthority({ gate: null, policy: IMPOSSIBLE })))
    .toBe("APPROVAL_POLICY_DELAY_INVALID@APPROVAL_POLICY");
});

const DELAY_REFUSALS: readonly (readonly [string, number])[] = [
  ["negative", -1], ["fractional", 1.5], ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
];

it("generates one refusal case per rejected auto-approval delay", () => {
  expect(DELAY_REFUSALS.length).toBe(4);
  expect(DELAY_REFUSALS.length).toBeGreaterThan(0);
});

it.each(DELAY_REFUSALS)("refuses an ungated %s auto-approval delay", (_label, delayMs) => {
  expect(outcome(decideApprovalAuthority({ gate: null, policy: { delayMs, kind: "PROCEED_WITHOUT_HUMAN" } })))
    .toBe("APPROVAL_POLICY_DELAY_INVALID@APPROVAL_POLICY");
});

it("proceeds on ungated work under a stated auto-approval delay", () => {
  expect(outcome(decideApprovalAuthority({
    gate: null, policy: { delayMs: 2_000, kind: "PROCEED_WITHOUT_HUMAN" },
  }))).toBe("PROCEED(2000,NONE)");
});

it("refuses ungated work at the policy layer when the policy requires a human", () => {
  expect(outcome(decideApprovalAuthority({ gate: null, policy: { kind: "REQUIRE_HUMAN" } })))
    .toBe("APPROVAL_HUMAN_REVIEW_REQUIRED@APPROVAL_POLICY");
});

/**
 * A granted gate proceeds under every policy member, and carries the human
 * grant forward rather than the auto-approval delay: a human decided, so the
 * delay that would have stood in for one no longer applies.
 */
it("proceeds on granted work under every approval policy member", () => {
  const minted = grantHumanAuthority(gated(), HUMAN, MOMENT);
  if (!minted.ok) throw new Error("expected a grant");
  const answered = GATED_CASES.map(({ kind, policy }) =>
    `${kind}:${outcome(decideApprovalAuthority({ gate: minted.gate, policy }))}`);
  expect(answered).toEqual(GATED_CASES.map(({ kind }) => `${kind}:PROCEED(0,HUMAN)`));
  expect(answered.length).toBe(APPROVAL_POLICY_KINDS.length);
});

it("names the granting human principal on the decision it permits", () => {
  const minted = grantHumanAuthority(gated(), HUMAN, MOMENT);
  if (!minted.ok) throw new Error("expected a grant");
  const decided = decideApprovalAuthority({ gate: minted.gate, policy: { kind: "REQUIRE_HUMAN" } });
  if (!decided.ok) throw new Error("expected the granted gate to proceed");
  expect(decided.grant).toEqual({
    gateId: GATE_ID, grantedAtEpochMs: MOMENT, principalId: "human:yaron",
    principalKind: "HUMAN", workRef: WORK_REF,
  });
});
