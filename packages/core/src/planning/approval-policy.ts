/**
 * The approval policy vocabulary, and the decision that composes it with the
 * human authority gate.
 *
 * WHAT A POLICY ANSWERS: "may this plan proceed without a human, and under what
 * conditions". Before this module moe-next could EXECUTE an approval — `plan.approve`
 * and its `approvePlan` reducer arm are landed — but could not EXPRESS a policy,
 * so approval was implicit and unrecorded, a property of whoever happened to call
 * the command rather than a decision the system holds and can be audited against.
 *
 * THE GATE IS NOT A POLICY MEMBER, AND IT IS CONSULTED FIRST. The tempting shape
 * is a `REQUIRE_HUMAN`-style policy value called "the gate". That shape is wrong,
 * because it is satisfiable by changing the policy — which is exactly what the
 * motivating incident did, at scale, to two release-cutover tasks. The gate is a
 * separate per-unit-of-work value that short-circuits: no ApprovalPolicy value,
 * no combination of them, and no agent action approves gated work. `REQUIRE_HUMAN`
 * below is a policy DEFAULT for ungated work; it is not the gate and cannot stand
 * in for one.
 *
 * A blanket project-wide mode is deliberately NOT the primary mechanism. Fast
 * delegation was the correct setting for most of the board in the incident;
 * flipping everything to manual review to protect two tasks is the wrong trade.
 *
 * This is a pure contract. It wires nothing; see the consumer tasks named in the
 * task handoff.
 */
import { checkHumanAuthority, refuseApprovalAuthority } from "./approval-authority.js";
import type {
  ApprovalAuthorityRefusal, HumanAuthorityGate, HumanAuthorityGrant,
} from "./approval-authority.js";

/**
 * The closed vocabulary, frozen, in one place a test can ITERATE — a test cannot
 * iterate a type, and DoD 2's sweep needs every member at runtime.
 */
export const APPROVAL_POLICY_KINDS = Object.freeze([
  "PROCEED_WITHOUT_HUMAN",
  "REQUIRE_HUMAN",
] as const);
export type ApprovalPolicyKind = (typeof APPROVAL_POLICY_KINDS)[number];

/**
 * What each member carries. This is the second half of "exhaustive by
 * construction": a member added to `APPROVAL_POLICY_KINDS` with no entry here
 * cannot be indexed by the mapped type below, so the vocabulary and the union
 * cannot drift apart without a compile error.
 *
 * `delayMs` IS REQUIRED. An auto-approval delay that defaults implicitly is the
 * incident's actual mechanism: that board ran a 2s auto-approval nobody had
 * stated per unit of work. A policy that cannot be constructed without naming
 * its delay cannot hide one.
 */
interface ApprovalPolicyPayloads {
  readonly PROCEED_WITHOUT_HUMAN: { readonly delayMs: number };
  readonly REQUIRE_HUMAN: Readonly<Record<never, never>>;
}

export type ApprovalPolicy = {
  [Kind in ApprovalPolicyKind]: { readonly kind: Kind } & ApprovalPolicyPayloads[Kind];
}[ApprovalPolicyKind];

export interface ApprovalAuthorityRequest {
  /** The unit of work's gate, or `null` when the work carries none. */
  readonly gate: HumanAuthorityGate | null;
  readonly policy: ApprovalPolicy;
}

export interface ApprovalAuthorityDecision {
  readonly ok: true;
  /**
   * How long the caller must wait before acting. Always explicit, never assumed.
   *
   * FOR THE CONSUMER: this is a safe non-negative integer, which is wider than
   * `setTimeout` accepts. A delay above 2**31-1 CLAMPS to 1ms there, so a
   * consumer that means "effectively never" and passes it straight to a timer
   * gets "immediately" — the inversion this contract exists to prevent. Bound it
   * at the consumer, where the timer lives.
   */
  readonly delayMs: number;
  /** The human whose grant permitted this, or `null` when a policy permitted it. */
  readonly grant: HumanAuthorityGrant | null;
}

export type ApprovalAuthorityResult = ApprovalAuthorityDecision | ApprovalAuthorityRefusal;

/**
 * The exhaustiveness anchor. Adding a member to `APPROVAL_POLICY_KINDS` without
 * an arm below makes this call a compile error, because the un-narrowed member is
 * not assignable to `never`. A switch whose arms all return compiles happily
 * without it, so the frozen array alone would NOT deliver DoD 1.
 *
 * It RETURNS a refusal rather than throwing: this contract fails closed, and a
 * crash is not a refusal.
 */
function assertNever(_member: never): ApprovalAuthorityRefusal {
  return refuseApprovalAuthority("APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY");
}

/** A delay, not a moment: a safe non-negative integer count of milliseconds. */
function validDelay(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function decidePolicy(policy: ApprovalPolicy): ApprovalAuthorityResult {
  switch (policy.kind) {
    case "PROCEED_WITHOUT_HUMAN":
      return validDelay(policy.delayMs)
        ? Object.freeze({ delayMs: policy.delayMs, grant: null, ok: true as const })
        : refuseApprovalAuthority("APPROVAL_POLICY_DELAY_INVALID", "APPROVAL_POLICY");
    case "REQUIRE_HUMAN":
      return refuseApprovalAuthority("APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY");
    default:
      return assertNever(policy);
  }
}

/**
 * THE GATE IS CONSULTED FIRST AND SHORT-CIRCUITS. Moving the policy ahead of it
 * would let a `PROCEED_WITHOUT_HUMAN` policy approve gated work, which is the one
 * outcome this whole module exists to make unrepresentable.
 *
 * A satisfied gate proceeds with `delayMs: 0` and carries the grant forward: a
 * human has decided, so the delay that would have stood in for one no longer
 * applies. Satisfying the gate is not a policy value — it takes a named human
 * principal — so this is not a way for a policy to approve gated work.
 */
export function decideApprovalAuthority(
  request: ApprovalAuthorityRequest,
): ApprovalAuthorityResult {
  const gate = request.gate;
  if (gate !== null && gate !== undefined) {
    const checked = checkHumanAuthority(gate);
    if (!checked.ok) return checked;
    return Object.freeze({ delayMs: 0, grant: checked.grant, ok: true as const });
  }
  return decidePolicy(request.policy);
}
