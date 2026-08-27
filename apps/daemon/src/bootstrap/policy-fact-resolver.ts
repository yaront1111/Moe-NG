import { createHash } from "node:crypto";

import type { PolicyFactInput } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { readPolicyRisk } from "./policy-risk-reader.js";

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
 * Resolve policy-risk authority from the durable, strictly joined reader.
 *
 * A full reader join yields the human approval's fact id and tier verbatim. Every refusal keeps
 * the prior UNKNOWN value byte-for-byte: `assessRisk` skips that null-tier fact, adds
 * RISK_TIER_UNCLASSIFIABLE, and folds evaluation to HOLD_UNKNOWN.
 *
 * The server binds the configured project and authenticated principal. The action is only the
 * caller-requested evaluation subject: the reader treats it only as an equality fence. It cannot
 * supply a tier, truth, waiver, subject, or live allowance.
 */
export function resolvePolicyFact(
  store: SqliteEventStore,
  projectId: string,
  authenticatedPrincipal: string,
  callerRequestedAction: string,
): PolicyFactInput {
  const resolved = readPolicyRisk(
    store, projectId, authenticatedPrincipal, callerRequestedAction,
  );
  if (resolved.ok) {
    return Object.freeze({
      factId: resolved.factId,
      tier: resolved.tier,
      truthClass: resolved.truthClass,
    });
  }
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
