/**
 * Expansion preparation: validates ONE scheduler-admitted expansion together with its
 * supersession, funding and fence facts and its policy verdict, and freezes the whole set into
 * one canonical identity. It mints no child run, lease, effect, slot, allocation or dispatch
 * authority; durable atomic activation stays with daemon composition.
 *
 * NOT the scheduler's same-named module. `packages/scheduler/src/expansion/expansion-preparation.ts`
 * builds the ADMISSION request envelope; this one binds an ALREADY-ADMITTED expansion to an
 * approval identity. `@moe/core` declares only `@moe/contracts` and `@moe/scheduler` depends on
 * `@moe/core`, so the admitted facts can only arrive as INBOUND DATA. They are validated here by
 * a closed shape check — exact keys, no extras, no defaults, no normalisation.
 *
 * # WHY THE GRAPH BINDING AND THE POLICY INPUT ARE NOT BOUND BESIDE THEIR DIGESTS
 *
 * `decideSupersession` computes an `authorityHash` over the predecessor binding, the successor
 * binding and every disposition. Binding those scalars AGAIN next to the hash would make each of
 * them unfalsifiable: dropping one from the identity leaves its perturbation test green, because
 * perturbing it still moves the hash. So `bound` carries the hash ALONE, and the binding itself is
 * reached through `sources.supersession`, whose integrity the recomputed hash proves. The policy
 * evaluation input CANNOT lean on its decided facts the same way — `decisionDigest` is the
 * caller's own passthrough, not a kernel computation — so `bind` hashes the canonical policy
 * input bytes itself and carries that digest as `policyInputHash`, giving `sources.policy` the
 * same recompute-and-compare integrity the supersession input gets from `authorityHash`.
 */
import { createHash } from "node:crypto";

import type { ApprovalDependencyChanges } from "../policy/approval-contract.js";
import type { PolicyEvaluationInput, PolicyOutcome, PolicyRiskTier } from
  "../policy/policy-contract.js";
import { evaluatePolicy } from "../policy/policy-evaluation.js";
import { deepFreeze, exact, snapshotData, validHex64, validRef, validTier, validTruthClass } from
  "../policy/policy-validation.js";
import type { GraphRevisionLifecycle } from "../planning/graph-revision-contract.js";
import { GRAPH_REVISION_TRANSITIONS } from "../planning/graph-revision-reducer.js";
import { SUPERSESSION_KERNEL_LAYER, decideSupersession } from
  "../supersession/supersession-engine.js";
import type { SupersessionInput, SupersessionRefusal } from
  "../supersession/supersession-engine.js";

export const EXPANSION_PREPARATION_CODES = Object.freeze([
  "EXPANSION_PREPARATION_BUDGET_NOT_RESERVED", "EXPANSION_PREPARATION_EVIDENCE_UNKNOWN",
  "EXPANSION_PREPARATION_FENCE_UNPROVEN", "EXPANSION_PREPARATION_FUNDING_NOT_RESERVED",
  "EXPANSION_PREPARATION_GRAPH_NOT_SUPERSEDABLE", "EXPANSION_PREPARATION_INPUT_INVALID",
  "EXPANSION_PREPARATION_POLICY_INPUT_INVALID", "EXPANSION_PREPARATION_POLICY_NOT_ELIGIBLE",
  "EXPANSION_PREPARATION_RESOURCES_NOT_HELD",
] as const);
/** `SUPERSESSION_KERNEL` is the kernel's OWN layer constant, so a rename there breaks here. */
export const EXPANSION_PREPARATION_LAYERS = Object.freeze([
  "BUDGET", "EVIDENCE", "FENCE", "FUNDING", "INPUT", "LIFECYCLE", "POLICY", "RESOURCE",
  SUPERSESSION_KERNEL_LAYER,
] as const);
/** Which surface answered. A delegated refusal names that surface, never this module. */
export const EXPANSION_PREPARATION_COMPONENTS = Object.freeze([
  "EXPANSION_PREPARATION", "GRAPH_REVISION", "POLICY_EVALUATION", "SUPERSESSION_ENGINE",
] as const);

export type ExpansionPreparationCode = (typeof EXPANSION_PREPARATION_CODES)[number];
export type ExpansionPreparationLayer = (typeof EXPANSION_PREPARATION_LAYERS)[number];
export type ExpansionPreparationComponent = (typeof EXPANSION_PREPARATION_COMPONENTS)[number];

export interface ExpansionBudgetReservationFacts {
  readonly accountId: string; readonly admissionRef: string;
  readonly reservationId: string; readonly state: "RESERVED";
}
export interface ExpansionResourceReservationFacts {
  readonly epoch: number; readonly resourceIds: readonly string[]; readonly state: "HELD";
}
export interface ExpansionFairnessFacts {
  readonly capRevisionRef: string | null; readonly opportunityRef: string;
  readonly resourceId: string; readonly workItemId: string;
}
export interface ExpansionAdmittedFacts {
  readonly budgetReservation: ExpansionBudgetReservationFacts;
  readonly childKeys: readonly string[]; readonly evidenceDigest: string;
  readonly fairness: ExpansionFairnessFacts; readonly goalVersion: number;
  readonly observedAtSequence: number; readonly proposalId: string;
  readonly qualityDigest: string;
  readonly resourceReservation: ExpansionResourceReservationFacts;
  readonly revision: number; readonly sourceDigests: readonly string[];
  readonly truthClass: "DAEMON_VERIFIED";
}
export interface ExpansionApprovalCriteria {
  readonly approvalRef: string; readonly budgetRef: string; readonly criteriaRef: string;
  readonly dependencyChanges: ApprovalDependencyChanges; readonly riskTier: PolicyRiskTier;
}
/**
 * Proof the predecessor's subordinate authority was FENCED OFF. It grants nothing: the field is
 * named `authorityFencedRef` rather than `leaseFencedRef` so no reader — and no zero-authority
 * sweep — can mistake evidence of a revoked lease for a lease this kernel handed out.
 */
export interface ExpansionFenceFacts {
  readonly authorityFencedRef: string; readonly fencedAtEpoch: number;
  readonly subordinateAuthorityFenced: true;
}
export interface ExpansionFundingFacts {
  readonly fundingRef: string; readonly meter: string; readonly quantity: number;
  readonly reservationId: string; readonly state: "RESERVED";
}
export interface ExpansionPolicyFacts {
  readonly decision: PolicyOutcome; readonly decisionDigest: string;
  readonly policyRevisionRef: string;
}
/** The complete set of bytes the canonical identity covers. Each family appears exactly once. */
export interface ExpansionPreparedFacts {
  readonly admitted: ExpansionAdmittedFacts; readonly criteria: ExpansionApprovalCriteria;
  readonly deadlineEpochMs: number; readonly fence: ExpansionFenceFacts;
  readonly funding: ExpansionFundingFacts; readonly graphLifecycle: GraphRevisionLifecycle;
  readonly policyDecision: ExpansionPolicyFacts; readonly policyInputHash: string;
  readonly supersessionAuthorityHash: string;
}
/** Re-runnable evidence. Nothing here is bound directly; the bound digests prove it. */
export interface ExpansionPreparationSources {
  readonly policy: PolicyEvaluationInput; readonly supersession: SupersessionInput;
}
export interface ExpansionPreparation {
  readonly bound: ExpansionPreparedFacts; readonly identity: string;
  readonly sources: ExpansionPreparationSources;
}
/** The carried facts, minus the three the preparation DECIDES, plus the inputs the kernels take. */
export type ExpansionPreparationInput =
  Omit<ExpansionPreparedFacts, "policyDecision" | "policyInputHash" | "supersessionAuthorityHash">
  & ExpansionPreparationSources;
export interface ExpansionPreparationRefusal {
  readonly code: ExpansionPreparationCode | SupersessionRefusal["code"];
  readonly component: ExpansionPreparationComponent;
  readonly layer: ExpansionPreparationLayer; readonly ok: false;
}
export type ExpansionPreparationResult =
  | { readonly ok: true; readonly preparation: ExpansionPreparation }
  | ExpansionPreparationRefusal;

const INPUT_KEYS = ["admitted", "criteria", "deadlineEpochMs", "fence", "funding",
  "graphLifecycle", "policy", "supersession"] as const;
const ADMITTED_KEYS = ["budgetReservation", "childKeys", "evidenceDigest", "fairness",
  "goalVersion", "observedAtSequence", "proposalId", "qualityDigest", "resourceReservation",
  "revision", "sourceDigests", "truthClass"] as const;
const BUDGET_KEYS = ["accountId", "admissionRef", "reservationId", "state"] as const;
const FAIRNESS_KEYS = ["capRevisionRef", "opportunityRef", "resourceId", "workItemId"] as const;
const RESERVATION_KEYS = ["epoch", "resourceIds", "state"] as const;
const CRITERIA_KEYS = ["approvalRef", "budgetRef", "criteriaRef", "dependencyChanges",
  "riskTier"] as const;
const DEPENDENCY_KEYS = ["additions", "challenges", "removals"] as const;
const FENCE_KEYS = ["authorityFencedRef", "fencedAtEpoch",
  "subordinateAuthorityFenced"] as const;
const FUNDING_KEYS = ["fundingRef", "meter", "quantity", "reservationId", "state"] as const;
const SUPERSESSION_KEYS = ["dispositions", "expectedPredecessor", "successor",
  "supportedCanonicalizerVersions"] as const;
const MAX_REFS = 128;
const ELIGIBLE_OUTCOMES: readonly PolicyOutcome[] = ["ALLOW", "REQUIRE_HUMAN_APPROVAL"];

type Face = { readonly component: ExpansionPreparationComponent;
  readonly layer: ExpansionPreparationLayer };
const LOCAL: Face = { component: "EXPANSION_PREPARATION", layer: "INPUT" };
const CODE_FACES: Readonly<Record<ExpansionPreparationCode, Face>> = {
  EXPANSION_PREPARATION_BUDGET_NOT_RESERVED: { ...LOCAL, layer: "BUDGET" },
  EXPANSION_PREPARATION_EVIDENCE_UNKNOWN: { ...LOCAL, layer: "EVIDENCE" },
  EXPANSION_PREPARATION_FENCE_UNPROVEN: { ...LOCAL, layer: "FENCE" },
  EXPANSION_PREPARATION_FUNDING_NOT_RESERVED: { ...LOCAL, layer: "FUNDING" },
  EXPANSION_PREPARATION_GRAPH_NOT_SUPERSEDABLE:
    { component: "GRAPH_REVISION", layer: "LIFECYCLE" },
  EXPANSION_PREPARATION_INPUT_INVALID: LOCAL,
  EXPANSION_PREPARATION_POLICY_INPUT_INVALID: { component: "POLICY_EVALUATION", layer: "POLICY" },
  EXPANSION_PREPARATION_POLICY_NOT_ELIGIBLE: { component: "POLICY_EVALUATION", layer: "POLICY" },
  EXPANSION_PREPARATION_RESOURCES_NOT_HELD: { ...LOCAL, layer: "RESOURCE" },
};

export function refuseExpansionPreparation(
  code: ExpansionPreparationCode,
): ExpansionPreparationRefusal {
  return deepFreeze({ code, ...CODE_FACES[code], ok: false as const });
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function list(value: unknown, item: (entry: unknown) => boolean, empty: boolean):
readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REFS) return null;
  if (value.length === 0 && !empty) return null;
  return value.every(item) ? (value as readonly string[]) : null;
}

function budgetOf(value: unknown): ExpansionBudgetReservationFacts | null {
  if (!exact(value, BUDGET_KEYS) || !validRef(value["accountId"])
    || !validRef(value["admissionRef"]) || !validRef(value["reservationId"])
    || !validRef(value["state"])) return null;
  return { accountId: value["accountId"], admissionRef: value["admissionRef"],
    reservationId: value["reservationId"], state: value["state"] as "RESERVED" };
}

function reservationOf(value: unknown): ExpansionResourceReservationFacts | null {
  if (!exact(value, RESERVATION_KEYS) || !isCount(value["epoch"])
    || !validRef(value["state"])) return null;
  const resourceIds = list(value["resourceIds"], validRef, false);
  if (resourceIds === null) return null;
  return { epoch: value["epoch"], resourceIds: [...resourceIds],
    state: value["state"] as "HELD" };
}

function fairnessOf(value: unknown): ExpansionFairnessFacts | null {
  if (!exact(value, FAIRNESS_KEYS) || !validRef(value["opportunityRef"])
    || !validRef(value["resourceId"]) || !validRef(value["workItemId"])
    || !(value["capRevisionRef"] === null || validRef(value["capRevisionRef"]))) return null;
  return { capRevisionRef: value["capRevisionRef"] as string | null,
    opportunityRef: value["opportunityRef"], resourceId: value["resourceId"],
    workItemId: value["workItemId"] };
}

/** Shape only. The reservation STATES are judged separately so each gets its own code. */
function admittedOf(value: unknown): ExpansionAdmittedFacts | null {
  if (!exact(value, ADMITTED_KEYS)) return null;
  const budgetReservation = budgetOf(value["budgetReservation"]);
  const resourceReservation = reservationOf(value["resourceReservation"]);
  const fairness = fairnessOf(value["fairness"]);
  const childKeys = list(value["childKeys"], validRef, false);
  const sourceDigests = list(value["sourceDigests"], validHex64, false);
  if (!budgetReservation || !resourceReservation || !fairness || !childKeys || !sourceDigests
    || !validHex64(value["evidenceDigest"]) || !validHex64(value["qualityDigest"])
    || !isCount(value["goalVersion"]) || !isCount(value["observedAtSequence"])
    || !isCount(value["revision"]) || !validRef(value["proposalId"])
    || !validTruthClass(value["truthClass"])) return null;
  return { budgetReservation, childKeys: [...childKeys],
    evidenceDigest: value["evidenceDigest"], fairness, goalVersion: value["goalVersion"],
    observedAtSequence: value["observedAtSequence"], proposalId: value["proposalId"],
    qualityDigest: value["qualityDigest"], resourceReservation, revision: value["revision"],
    sourceDigests: [...sourceDigests], truthClass: value["truthClass"] as "DAEMON_VERIFIED" };
}

function dependencyOf(value: unknown): ApprovalDependencyChanges | null {
  if (!exact(value, DEPENDENCY_KEYS)) return null;
  const additions = list(value["additions"], validRef, true);
  const challenges = list(value["challenges"], validRef, true);
  const removals = list(value["removals"], validRef, true);
  if (!additions || !challenges || !removals) return null;
  return { additions: [...additions], challenges: [...challenges], removals: [...removals] };
}

function criteriaOf(value: unknown): ExpansionApprovalCriteria | null {
  if (!exact(value, CRITERIA_KEYS)) return null;
  const dependencyChanges = dependencyOf(value["dependencyChanges"]);
  if (!dependencyChanges || !validRef(value["approvalRef"]) || !validHex64(value["budgetRef"])
    || !validHex64(value["criteriaRef"]) || !validTier(value["riskTier"])) return null;
  return { approvalRef: value["approvalRef"], budgetRef: value["budgetRef"],
    criteriaRef: value["criteriaRef"], dependencyChanges, riskTier: value["riskTier"] };
}

function fenceOf(value: unknown): ExpansionFenceFacts | null {
  if (!exact(value, FENCE_KEYS) || !isCount(value["fencedAtEpoch"])
    || !validRef(value["authorityFencedRef"])
    || typeof value["subordinateAuthorityFenced"] !== "boolean") return null;
  return { authorityFencedRef: value["authorityFencedRef"],
    fencedAtEpoch: value["fencedAtEpoch"],
    subordinateAuthorityFenced: value["subordinateAuthorityFenced"] as true };
}

function fundingOf(value: unknown): ExpansionFundingFacts | null {
  if (!exact(value, FUNDING_KEYS) || !validRef(value["fundingRef"]) || !validRef(value["meter"])
    || !validRef(value["reservationId"]) || !isCount(value["quantity"])
    || !validRef(value["state"])) return null;
  return { fundingRef: value["fundingRef"], meter: value["meter"], quantity: value["quantity"],
    reservationId: value["reservationId"], state: value["state"] as "RESERVED" };
}

/** Key-sorted so a recomputation over a stored record cannot depend on insertion order. */
export function canonicalBytes(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalBytes).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalBytes(source[key])}`,
  ).join(",")}}`;
}

const IDENTITY_DOMAIN = "@moe/core.expansion.preparation/v1";
const POLICY_INPUT_DOMAIN = "@moe/core.expansion.policy-input/v1";

export function expansionIdentityOf(bound: ExpansionPreparedFacts): string {
  return createHash("sha256").update(IDENTITY_DOMAIN, "utf8").update(" ", "utf8")
    .update(canonicalBytes(bound), "utf8").digest("hex");
}

/**
 * Domain-separated digest over the canonical policy input bytes. `decisionDigest` cannot serve
 * here — it is the caller's passthrough, so it proves nothing about the input it rode in on;
 * only a digest computed HERE lets a verifier prove the stored `sources.policy` is the exact
 * input the bound decision was evaluated over.
 */
function policyInputHashOf(policy: unknown): string {
  return createHash("sha256").update(POLICY_INPUT_DOMAIN, "utf8").update(" ", "utf8")
    .update(canonicalBytes(policy), "utf8").digest("hex");
}

const SUPERSEDABLE: readonly string[] = GRAPH_REVISION_TRANSITIONS["graph.supersede"];

interface Valid {
  readonly admitted: ExpansionAdmittedFacts; readonly criteria: ExpansionApprovalCriteria;
  readonly fence: ExpansionFenceFacts; readonly funding: ExpansionFundingFacts;
}

function stateCode(valid: Valid): ExpansionPreparationCode | null {
  if (valid.admitted.truthClass !== "DAEMON_VERIFIED") {
    return "EXPANSION_PREPARATION_EVIDENCE_UNKNOWN";
  }
  if (valid.admitted.budgetReservation.state !== "RESERVED") {
    return "EXPANSION_PREPARATION_BUDGET_NOT_RESERVED";
  }
  if (valid.admitted.resourceReservation.state !== "HELD") {
    return "EXPANSION_PREPARATION_RESOURCES_NOT_HELD";
  }
  if (valid.funding.state !== "RESERVED") return "EXPANSION_PREPARATION_FUNDING_NOT_RESERVED";
  if (valid.fence.subordinateAuthorityFenced !== true) {
    return "EXPANSION_PREPARATION_FENCE_UNPROVEN";
  }
  return null;
}

/**
 * The supersession kernel is handed the predecessor binding the caller declared and validates the
 * whole payload itself; its refusal travels out with its own code and layer, never a local synonym.
 */
function bind(
  input: Readonly<Record<string, unknown>>,
  valid: Valid,
  policy: ExpansionPolicyFacts,
): ExpansionPreparationResult {
  const supersession = input["supersession"];
  const predecessor = exact(supersession, SUPERSESSION_KEYS)
    ? supersession["expectedPredecessor"] : undefined;
  const decided = decideSupersession(predecessor, supersession);
  if (!decided.ok) {
    return deepFreeze({ code: decided.code, component: "SUPERSESSION_ENGINE" as const,
      layer: decided.layer, ok: false as const });
  }
  const bound: ExpansionPreparedFacts = {
    admitted: valid.admitted, criteria: valid.criteria,
    deadlineEpochMs: input["deadlineEpochMs"] as number, fence: valid.fence,
    funding: valid.funding, graphLifecycle: input["graphLifecycle"] as GraphRevisionLifecycle,
    policyDecision: policy, policyInputHash: policyInputHashOf(input["policy"]),
    supersessionAuthorityHash: decided.decision.authorityHash,
  };
  return deepFreeze({ ok: true as const, preparation: { bound,
    identity: expansionIdentityOf(bound),
    sources: { policy: input["policy"] as PolicyEvaluationInput,
      supersession: supersession as SupersessionInput } } });
}

/** Validates and freezes one admitted expansion into a single canonical prepared identity. */
export function prepareExpansion(value: unknown): ExpansionPreparationResult {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, INPUT_KEYS)) {
    return refuseExpansionPreparation("EXPANSION_PREPARATION_INPUT_INVALID");
  }
  const input = snapshot.value;
  const admitted = admittedOf(input["admitted"]);
  const criteria = criteriaOf(input["criteria"]);
  const fence = fenceOf(input["fence"]);
  const funding = fundingOf(input["funding"]);
  if (!admitted || !criteria || !fence || !funding || !isCount(input["deadlineEpochMs"])
    || typeof input["graphLifecycle"] !== "string") {
    return refuseExpansionPreparation("EXPANSION_PREPARATION_INPUT_INVALID");
  }
  const valid: Valid = { admitted, criteria, fence, funding };
  const stale = stateCode(valid);
  if (stale !== null) return refuseExpansionPreparation(stale);
  if (!SUPERSEDABLE.includes(input["graphLifecycle"])) {
    return refuseExpansionPreparation("EXPANSION_PREPARATION_GRAPH_NOT_SUPERSEDABLE");
  }
  const policy = evaluatePolicy(input["policy"]);
  if (!policy.ok) return refuseExpansionPreparation("EXPANSION_PREPARATION_POLICY_INPUT_INVALID");
  if (!ELIGIBLE_OUTCOMES.includes(policy.record.decision)) {
    return refuseExpansionPreparation("EXPANSION_PREPARATION_POLICY_NOT_ELIGIBLE");
  }
  return bind(input, valid, { decision: policy.record.decision,
    decisionDigest: policy.record.decisionDigest,
    policyRevisionRef: policy.record.policyRevisionRef });
}
