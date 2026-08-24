import { createHash } from "node:crypto";

import type { PolicyFactInput } from "@moe/core";

const FACT_ID_DOMAIN = "moe.policy-fact-resolver.v1";

export interface ResolvedEmptyPolicyWaivers {
  readonly status: "RESOLVED_EMPTY";
  readonly waivers: readonly [];
}

const RESOLVED_EMPTY_WAIVERS: ResolvedEmptyPolicyWaivers = Object.freeze({
  status: "RESOLVED_EMPTY",
  waivers: Object.freeze([] as const),
});

/**
 * The waiver source was consulted and resolved empty; it was not absent.
 *
 * Policy waivers require a real humanApprovalRef (policy-contract.ts:102-108), and Foundation has
 * no such record. More importantly, HOLD_UNKNOWN dominates ALLOW and a waiver can only suppress
 * a layer-2 relaxation, so it structurally cannot turn HOLD_UNKNOWN into ALLOW
 * (policy-evaluation.ts:12-14, design 712). This zero-argument source therefore has no branch that
 * can mint a waiver and makes consultation distinguishable from absence.
 */
export function resolvePolicyWaivers(): ResolvedEmptyPolicyWaivers {
  return RESOLVED_EMPTY_WAIVERS;
}

/**
 * Resolve the only policy-risk fact Foundation can honestly assert today.
 *
 * No durable record is entitled to classify risk, so the daemon records that risk is
 * unknowable rather than claiming that no fact was found. `assessRisk` skips a null-tier fact
 * whose truth is not DAEMON_VERIFIED/HUMAN_APPROVED; that leaves risk unclassifiable, adds
 * RISK_TIER_UNCLASSIFIABLE, and folds the evaluator to HOLD_UNKNOWN. The value therefore keeps
 * `PolicyEvaluated` writable without creating authority or ending the request before evaluation.
 *
 * The server binds the configured project and authenticated principal. The action is only the
 * caller-requested evaluation subject: it may distinguish this UNKNOWN audit identity, but it
 * cannot supply a tier, truth, waiver, or live allowance. Any future tier-bearing action binding
 * belongs to task-b211ac9de4944582ae19aa73afda7b25, not this fail-closed resolver.
 */
export function resolvePolicyFact(
  projectId: string,
  authenticatedPrincipal: string,
  callerRequestedAction: string,
): PolicyFactInput {
  const identity = JSON.stringify([
    FACT_ID_DOMAIN,
    projectId,
    authenticatedPrincipal,
    callerRequestedAction,
  ]);
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return Object.freeze({
    factId: `policy-risk-unclassifiable:sha256:${digest}`,
    tier: null,
    truthClass: "UNKNOWN",
  });
}
