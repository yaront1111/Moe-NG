/**
 * Manual approval binding for one prepared expansion.
 *
 * It composes four landed decisions and reimplements none of them: `evaluatePolicy` and
 * `decideSupersession` are RE-RUN over the preparation's stored inputs so the bound digests are
 * verified rather than trusted, `validateApprovalRecord` judges the record's shape and its
 * actor-authority floor, and `applyApprovalCommand` owns the `PENDING -> DECIDED` transition.
 *
 * # MANUAL ONLY
 *
 * Policy ALLOW makes a proposal ELIGIBLE FOR REVIEW; it cannot approve one. Eligibility is decided
 * in `prepareExpansion` and recorded as a bound fact; approval is decided HERE and only by a
 * `HUMAN` actor kind. There is deliberately no branch that reads `bound.policyDecision.decision`
 * to reach a success — the two verdicts never meet, so no later edit can collapse them by
 * accident.
 *
 * # ZERO CHILD AUTHORITY
 *
 * The accepted result carries a decided approval record and two identities. It mints no child
 * run, lease, effect, slot, allocation activation or dispatch; durable atomic activation and
 * supersession EXECUTION stay with daemon composition.
 */
import { createHash } from "node:crypto";

import type {
  ApprovalDecisionRecord, ApprovalDependencyChanges,
} from "../policy/approval-contract.js";
import { applyApprovalCommand } from "../policy/approval-invalidation.js";
import { validateApprovalRecord } from "../policy/approval-validation.js";
import { deepFreeze, exact, snapshotData, validHex64, validRef } from
  "../policy/policy-validation.js";
import { SUPERSESSION_KERNEL_LAYER } from "../supersession/supersession-engine.js";
import { canonicalBytes, prepareExpansion } from "./expansion-preparation.js";
import type {
  ExpansionPreparation, ExpansionPreparedFacts,
} from "./expansion-preparation.js";

export const EXPANSION_APPROVAL_CODES = Object.freeze([
  "EXPANSION_APPROVAL_BUDGET_MISMATCH", "EXPANSION_APPROVAL_COMMAND_REFUSED",
  "EXPANSION_APPROVAL_CRITERIA_MISMATCH", "EXPANSION_APPROVAL_DEADLINE_EXPIRED",
  "EXPANSION_APPROVAL_DEPENDENCY_MISMATCH", "EXPANSION_APPROVAL_INPUT_INVALID",
  "EXPANSION_APPROVAL_MANUAL_REQUIRED", "EXPANSION_APPROVAL_NOT_APPROVED",
  "EXPANSION_APPROVAL_POLICY_CHANGED", "EXPANSION_APPROVAL_POLICY_MISMATCH",
  "EXPANSION_APPROVAL_PREPARATION_MISMATCH", "EXPANSION_APPROVAL_PREPARATION_STALE",
  "EXPANSION_APPROVAL_QUALITY_MISMATCH", "EXPANSION_APPROVAL_RECORD_INVALID",
  "EXPANSION_APPROVAL_RECORD_INVALIDATED", "EXPANSION_APPROVAL_RESOURCE_MISMATCH",
  "EXPANSION_APPROVAL_REVISION_MISMATCH", "EXPANSION_APPROVAL_SCOPE_MISMATCH",
  "EXPANSION_APPROVAL_SUPERSESSION_CHANGED", "EXPANSION_APPROVAL_SUPERSESSION_MISMATCH",
] as const);
export const EXPANSION_APPROVAL_LAYERS = Object.freeze([
  "ACTOR", "BINDING", "DEADLINE", "IDENTITY", "INPUT", "LIFECYCLE", "POLICY",
  SUPERSESSION_KERNEL_LAYER,
] as const);
/** Which surface refused. Two of them are landed modules this one only composes. */
export const EXPANSION_APPROVAL_COMPONENTS = Object.freeze([
  "APPROVAL_COMMAND", "APPROVAL_VALIDATION", "EXPANSION_APPROVAL", "EXPANSION_PREPARATION",
  "POLICY_EVALUATION", "SUPERSESSION_ENGINE",
] as const);

export type ExpansionApprovalCode = (typeof EXPANSION_APPROVAL_CODES)[number];
export type ExpansionApprovalLayer = (typeof EXPANSION_APPROVAL_LAYERS)[number];
export type ExpansionApprovalComponent = (typeof EXPANSION_APPROVAL_COMPONENTS)[number];

/** The caller's assertion of the live facts an ApprovalDecisionRecord cannot express. */
export interface ExpansionApprovalClaim {
  readonly budgetReservationId: string; readonly budgetReservationState: string;
  readonly preparationIdentity: string; readonly resourceEpoch: number;
  readonly resourceIds: readonly string[]; readonly resourceReservationState: string;
  readonly supersessionAuthorityHash: string;
}
export interface ExpansionApprovalRequest {
  readonly approval: ApprovalDecisionRecord; readonly claim: ExpansionApprovalClaim;
  readonly command: unknown; readonly nowEpochMs: number;
  readonly preparation: ExpansionPreparation;
}
export interface ExpansionApprovalBinding {
  readonly approvalRef: string; readonly decidedApproval: ApprovalDecisionRecord;
  readonly identity: string; readonly preparationIdentity: string;
}
export interface ExpansionApprovalRefusal {
  readonly code: ExpansionApprovalCode; readonly component: ExpansionApprovalComponent;
  readonly layer: ExpansionApprovalLayer; readonly ok: false;
}
export type ExpansionApprovalResult =
  | { readonly binding: ExpansionApprovalBinding; readonly ok: true }
  | ExpansionApprovalRefusal;

const REQUEST_KEYS = ["approval", "claim", "command", "nowEpochMs", "preparation"] as const;
const PREPARATION_KEYS = ["bound", "identity", "sources"] as const;
const SOURCE_KEYS = ["policy", "supersession"] as const;
const BOUND_KEYS = ["admitted", "criteria", "deadlineEpochMs", "fence", "funding",
  "graphLifecycle", "policyDecision", "policyInputHash", "supersessionAuthorityHash"] as const;
const POLICY_FACT_KEYS = ["decision", "decisionDigest", "policyRevisionRef"] as const;
const CLAIM_KEYS = ["budgetReservationId", "budgetReservationState", "preparationIdentity",
  "resourceEpoch", "resourceIds", "resourceReservationState",
  "supersessionAuthorityHash"] as const;

type Face = { readonly component: ExpansionApprovalComponent;
  readonly layer: ExpansionApprovalLayer };
const BINDING_FACE: Face = { component: "EXPANSION_APPROVAL", layer: "BINDING" };
const CODE_FACES: Readonly<Record<ExpansionApprovalCode, Face>> = {
  EXPANSION_APPROVAL_BUDGET_MISMATCH: BINDING_FACE,
  EXPANSION_APPROVAL_COMMAND_REFUSED: { component: "APPROVAL_COMMAND", layer: "LIFECYCLE" },
  EXPANSION_APPROVAL_CRITERIA_MISMATCH: BINDING_FACE,
  EXPANSION_APPROVAL_DEADLINE_EXPIRED: { component: "EXPANSION_APPROVAL", layer: "DEADLINE" },
  EXPANSION_APPROVAL_DEPENDENCY_MISMATCH: BINDING_FACE,
  EXPANSION_APPROVAL_INPUT_INVALID: { component: "EXPANSION_APPROVAL", layer: "INPUT" },
  EXPANSION_APPROVAL_MANUAL_REQUIRED: { component: "EXPANSION_APPROVAL", layer: "ACTOR" },
  EXPANSION_APPROVAL_NOT_APPROVED: { component: "EXPANSION_APPROVAL", layer: "LIFECYCLE" },
  EXPANSION_APPROVAL_POLICY_CHANGED: { component: "POLICY_EVALUATION", layer: "POLICY" },
  EXPANSION_APPROVAL_POLICY_MISMATCH: BINDING_FACE,
  EXPANSION_APPROVAL_PREPARATION_MISMATCH:
    { component: "EXPANSION_APPROVAL", layer: "IDENTITY" },
  EXPANSION_APPROVAL_PREPARATION_STALE:
    { component: "EXPANSION_PREPARATION", layer: "IDENTITY" },
  EXPANSION_APPROVAL_QUALITY_MISMATCH: BINDING_FACE,
  EXPANSION_APPROVAL_RECORD_INVALID: { component: "APPROVAL_VALIDATION", layer: "INPUT" },
  EXPANSION_APPROVAL_RECORD_INVALIDATED:
    { component: "EXPANSION_APPROVAL", layer: "LIFECYCLE" },
  EXPANSION_APPROVAL_RESOURCE_MISMATCH: BINDING_FACE,
  EXPANSION_APPROVAL_REVISION_MISMATCH: BINDING_FACE,
  EXPANSION_APPROVAL_SCOPE_MISMATCH: BINDING_FACE,
  EXPANSION_APPROVAL_SUPERSESSION_CHANGED:
    { component: "SUPERSESSION_ENGINE", layer: SUPERSESSION_KERNEL_LAYER },
  EXPANSION_APPROVAL_SUPERSESSION_MISMATCH: BINDING_FACE,
};

function refuse(code: ExpansionApprovalCode): ExpansionApprovalRefusal {
  return deepFreeze({ code, ...CODE_FACES[code], ok: false as const });
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sameBytes(left: unknown, right: unknown): boolean {
  return canonicalBytes(left) === canonicalBytes(right);
}

function validClaim(value: unknown): ExpansionApprovalClaim | null {
  if (!exact(value, CLAIM_KEYS) || !validRef(value["budgetReservationId"])
    || !validRef(value["budgetReservationState"]) || !validHex64(value["preparationIdentity"])
    || !isCount(value["resourceEpoch"]) || !validRef(value["resourceReservationState"])
    || !validHex64(value["supersessionAuthorityHash"]) || !Array.isArray(value["resourceIds"])
    || !value["resourceIds"].every(validRef)) return null;
  return value as unknown as ExpansionApprovalClaim;
}

/**
 * Re-runs the WHOLE preparation over the record's own stored facts. A stored record that no
 * longer prepares to its own identity has been tampered with, re-prepared, or overtaken by a
 * policy or supersession decision that has since moved; each of those gets its own code.
 */
function verifyPreparation(
  preparation: Readonly<Record<string, unknown>>,
): ExpansionPreparedFacts | ExpansionApprovalRefusal {
  const bound = preparation["bound"];
  const sources = preparation["sources"];
  if (!exact(bound, BOUND_KEYS) || !exact(sources, SOURCE_KEYS)
    || !validHex64(preparation["identity"])) return refuse("EXPANSION_APPROVAL_INPUT_INVALID");
  const reprepared = prepareExpansion({
    admitted: bound["admitted"], criteria: bound["criteria"],
    deadlineEpochMs: bound["deadlineEpochMs"], fence: bound["fence"], funding: bound["funding"],
    graphLifecycle: bound["graphLifecycle"], policy: sources["policy"],
    supersession: sources["supersession"],
  });
  if (!reprepared.ok) {
    if (reprepared.layer === SUPERSESSION_KERNEL_LAYER) {
      return refuse("EXPANSION_APPROVAL_SUPERSESSION_CHANGED");
    }
    return refuse(reprepared.layer === "POLICY"
      ? "EXPANSION_APPROVAL_POLICY_CHANGED" : "EXPANSION_APPROVAL_PREPARATION_STALE");
  }
  const fresh = reprepared.preparation.bound;
  if (fresh.supersessionAuthorityHash !== bound["supersessionAuthorityHash"]) {
    return refuse("EXPANSION_APPROVAL_SUPERSESSION_CHANGED");
  }
  // The triple below cannot prove `sources.policy`: `decisionDigest` is the caller's own
  // passthrough, so only this recomputed input digest ties the stored evidence to the exact
  // input the bound decision was evaluated over.
  if (fresh.policyInputHash !== bound["policyInputHash"]) {
    return refuse("EXPANSION_APPROVAL_POLICY_CHANGED");
  }
  // Field-by-field rather than by canonical bytes: the stored value is arbitrary caller data,
  // and a deeply nested one would blow the serialiser's stack instead of refusing.
  const storedPolicy = bound["policyDecision"];
  if (!exact(storedPolicy, POLICY_FACT_KEYS) || POLICY_FACT_KEYS.some(
    (key) => storedPolicy[key] !== fresh.policyDecision[key],
  )) return refuse("EXPANSION_APPROVAL_POLICY_CHANGED");
  if (reprepared.preparation.identity !== preparation["identity"]) {
    return refuse("EXPANSION_APPROVAL_PREPARATION_STALE");
  }
  return fresh;
}

/** The live facts no ApprovalDecisionRecord can carry, matched against the stored identity. */
function matchClaim(
  claim: ExpansionApprovalClaim,
  bound: ExpansionPreparedFacts,
): ExpansionApprovalCode | null {
  const budget = bound.admitted.budgetReservation;
  const resource = bound.admitted.resourceReservation;
  if (claim.budgetReservationId !== budget.reservationId
    || claim.budgetReservationState !== budget.state) {
    return "EXPANSION_APPROVAL_BUDGET_MISMATCH";
  }
  if (claim.resourceEpoch !== resource.epoch
    || claim.resourceReservationState !== resource.state
    || !sameBytes(claim.resourceIds, resource.resourceIds)) {
    return "EXPANSION_APPROVAL_RESOURCE_MISMATCH";
  }
  if (claim.supersessionAuthorityHash !== bound.supersessionAuthorityHash) {
    return "EXPANSION_APPROVAL_SUPERSESSION_MISMATCH";
  }
  return null;
}

/** Every approval byte DoD 2 enumerates, each against the fact the preparation froze. */
function matchRecord(
  record: ApprovalDecisionRecord,
  bound: ExpansionPreparedFacts,
  successorGraphContentHash: unknown,
): ExpansionApprovalCode | null {
  const criteria = bound.criteria;
  if (record.approvalRef !== criteria.approvalRef || record.criteriaRef !== criteria.criteriaRef
    || record.riskTier !== criteria.riskTier) return "EXPANSION_APPROVAL_CRITERIA_MISMATCH";
  if (record.budgetRef !== criteria.budgetRef) return "EXPANSION_APPROVAL_BUDGET_MISMATCH";
  if (!sameBytes(record.approvedNodeScope, bound.admitted.childKeys)) {
    return "EXPANSION_APPROVAL_SCOPE_MISMATCH";
  }
  if (record.planQualityAssessmentRef !== bound.admitted.qualityDigest) {
    return "EXPANSION_APPROVAL_QUALITY_MISMATCH";
  }
  if (!sameBytes(record.dependencyChanges as ApprovalDependencyChanges,
    criteria.dependencyChanges)) return "EXPANSION_APPROVAL_DEPENDENCY_MISMATCH";
  if (record.applicablePolicyRef !== bound.policyDecision.policyRevisionRef
    || record.policyDecisionRef !== bound.policyDecision.decisionDigest) {
    return "EXPANSION_APPROVAL_POLICY_MISMATCH";
  }
  if (record.exactRevisionHash !== successorGraphContentHash) {
    return "EXPANSION_APPROVAL_REVISION_MISMATCH";
  }
  return null;
}

const IDENTITY_DOMAIN = "@moe/core.expansion.approval/v1";

function bindingIdentity(
  decidedApproval: ApprovalDecisionRecord,
  preparationIdentity: string,
): string {
  return createHash("sha256").update(IDENTITY_DOMAIN, "utf8").update(" ", "utf8")
    .update(canonicalBytes({ approval: decidedApproval, preparationIdentity }), "utf8")
    .digest("hex");
}

function successorHashOf(sources: unknown): unknown {
  const supersession = exact(sources, SOURCE_KEYS) ? sources["supersession"] : undefined;
  const successor = supersession !== null && typeof supersession === "object"
    ? (supersession as Record<string, unknown>)["successor"] : undefined;
  return successor !== null && typeof successor === "object"
    ? (successor as Record<string, unknown>)["graphContentHash"] : undefined;
}

/**
 * Approves ONE prepared expansion from ONE human decision. Every refusal names its stable code,
 * the layer that refused, and the component that answered; no refusal touches its inputs.
 */
export function approveExpansionManually(value: unknown): ExpansionApprovalResult {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, REQUEST_KEYS)
    || !isCount(snapshot.value["nowEpochMs"])
    || !exact(snapshot.value["preparation"], PREPARATION_KEYS)) {
    return refuse("EXPANSION_APPROVAL_INPUT_INVALID");
  }
  const request = snapshot.value;
  const preparation = request["preparation"] as Readonly<Record<string, unknown>>;
  const verified = verifyPreparation(preparation);
  if ("ok" in verified) return verified;
  const claim = validClaim(request["claim"]);
  if (claim === null) return refuse("EXPANSION_APPROVAL_INPUT_INVALID");
  if (claim.preparationIdentity !== preparation["identity"]) {
    return refuse("EXPANSION_APPROVAL_PREPARATION_MISMATCH");
  }
  if ((request["nowEpochMs"] as number) > verified.deadlineEpochMs) {
    return refuse("EXPANSION_APPROVAL_DEADLINE_EXPIRED");
  }
  const claimed = matchClaim(claim, verified);
  if (claimed !== null) return refuse(claimed);
  return decide(request, preparation, verified);
}

/**
 * The manual half. `validateApprovalRecord` judges the record, the actor kind must be `HUMAN`, and
 * `applyApprovalCommand` owns the transition — policy plays no part in reaching this success.
 */
function decide(
  request: Readonly<Record<string, unknown>>,
  preparation: Readonly<Record<string, unknown>>,
  bound: ExpansionPreparedFacts,
): ExpansionApprovalResult {
  const record = validateApprovalRecord(request["approval"]);
  if (record === undefined) return refuse("EXPANSION_APPROVAL_RECORD_INVALID");
  if (record.actorKind !== "HUMAN") return refuse("EXPANSION_APPROVAL_MANUAL_REQUIRED");
  if (record.validity !== "CURRENT") return refuse("EXPANSION_APPROVAL_RECORD_INVALIDATED");
  const mismatch = matchRecord(record, bound, successorHashOf(preparation["sources"]));
  if (mismatch !== null) return refuse(mismatch);
  const decided = applyApprovalCommand(record, request["command"]);
  if (!decided.ok) return refuse("EXPANSION_APPROVAL_COMMAND_REFUSED");
  if (decided.value.decision !== "APPROVE") return refuse("EXPANSION_APPROVAL_NOT_APPROVED");
  const preparationIdentity = preparation["identity"] as string;
  return deepFreeze({
    binding: {
      approvalRef: decided.value.approvalRef, decidedApproval: decided.value,
      identity: bindingIdentity(decided.value, preparationIdentity), preparationIdentity,
    },
    ok: true as const,
  });
}
