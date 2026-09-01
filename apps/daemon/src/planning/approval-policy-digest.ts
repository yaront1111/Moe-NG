import type { JsonObject } from "@moe/contracts";
import type { ApprovalPolicy, HumanAuthorityGrant } from "@moe/core";

import { decisionDigestFor } from "../bootstrap/bootstrap-policy-authority.js";

/**
 * The activation binding's `policyHash`: a digest over the policy decision that authorised THIS
 * approval, composed from server-held facts and from nothing else.
 *
 * WHICH POLICY DECISION THIS IS, because two different ones exist and confusing them would be a
 * silent authority swap. `policy.validate` decides whether a PRINCIPAL may act on a NODE, and
 * `bootstrap-policy-services.ts` seals that answer as `PolicyEvaluated.decisionDigest` under
 * `POLICY_DECISION_DIGEST_VERSION`; `admission-gate-resolver.ts` is its consumer. THIS module
 * answers the different question `GraphActivationBinding.policyHash` asks — under which approval
 * policy was this graph revision approved and activated — and it is deliberately versioned apart
 * so a reader can never mistake one digest for the other.
 *
 * EVERY MEMBER IS SERVER-HELD. The mode comes from the daemon's own environment via
 * `readApprovalPolicySettings`, which has no payload branch at all; the delay and the grant are
 * the core's `decideApprovalAuthority` verdict, not a caller claim; the refs are read off durable
 * records; and the principal is the authenticated envelope's, already compared against the
 * approval record's actor upstream. A caller can at most PREDICT this value, and a prediction
 * that disagrees is refused rather than adopted — the same shape the budget half uses.
 *
 * It reuses `decisionDigestFor` rather than reaching for a hash directly: that function is the
 * repository's one canonical-JSON framed digest, so a field added here changes the digest
 * unambiguously instead of colliding with a differently-framed neighbour.
 */

/** Names the framing, so a later material change is a VERSION bump rather than a silent redigest. */
export const APPROVAL_POLICY_DIGEST_VERSION = "moe.graph.approve.policy.v1" as const;

/**
 * The complete preimage. Declared as an exact interface rather than assembled inline because the
 * digest's meaning IS this key set: a member silently dropped at the call site would still digest,
 * and would still be 64 hex, and would bind an approval to a policy decision it never took.
 */
export interface ApprovalPolicyMaterial extends JsonObject {
  /** `REQUIRE_HUMAN` or `PROCEED_WITHOUT_HUMAN`, from the daemon environment. */
  readonly approvalPolicyKind: ApprovalPolicy["kind"];
  /** The core's decided wait, never the settings' stated one — a satisfied gate proceeds at 0. */
  readonly authorityDelayMs: number;
  readonly digestVersion: typeof APPROVAL_POLICY_DIGEST_VERSION;
  readonly goalRef: string;
  /** The human whose gate grant permitted this, or `null` when the policy alone permitted it. */
  readonly grantPrincipalId: string | null;
  readonly graphRevisionRef: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly runId: string;
}

export interface ApprovalPolicyMaterialInput {
  readonly delayMs: number;
  readonly goalRef: string;
  readonly grant: HumanAuthorityGrant | null;
  readonly graphRevisionRef: string;
  readonly policy: ApprovalPolicy;
  readonly principalId: string;
  readonly projectId: string;
  readonly runId: string;
}

/**
 * The preimage, frozen. `grant` is reduced to its PRINCIPAL alone: `grantedAtEpochMs` moves with
 * the clock on every otherwise identical approval, and folding it in would make the digest
 * unreproducible for anyone auditing the same decision later.
 */
export function approvalPolicyMaterial(
  input: ApprovalPolicyMaterialInput,
): ApprovalPolicyMaterial {
  return Object.freeze({
    approvalPolicyKind: input.policy.kind,
    authorityDelayMs: input.delayMs,
    digestVersion: APPROVAL_POLICY_DIGEST_VERSION,
    goalRef: input.goalRef,
    grantPrincipalId: input.grant === null ? null : input.grant.principalId,
    graphRevisionRef: input.graphRevisionRef,
    principalId: input.principalId,
    projectId: input.projectId,
    runId: input.runId,
  });
}

/** Lowercase 64-hex, the spelling `validBinding` requires of every binding member. */
export function approvalPolicyHash(material: ApprovalPolicyMaterial): string {
  return decisionDigestFor(material);
}
