import { exact, snapshotData, validHex64, validRef } from "../planning/planning-snapshot.js";
import { admitAcceptanceContract, type AcceptanceContract } from "../planning/acceptance-contract.js";
import { encodeAcceptanceContract } from "../planning/acceptance-contract-codec.js";
/**
 * INTRA-PACKAGE ON PURPOSE, exactly as `planning/approval-policy.ts` imports it.
 * `checkHumanAuthority` is deliberately absent from the root barrel: a consumer
 * able to call it could call it and then decide for itself whether to honour the
 * answer. Gate 1 lives inside this package, so it needs no published edge.
 *
 * AND NOT `decideApprovalAuthority`: that entry point falls through to the
 * approval POLICY when no gate is present, so a `PROCEED_WITHOUT_HUMAN` setting
 * would satisfy Gate 1. Gate 1 refuses an absent gate unconditionally and is
 * never satisfiable by a policy value.
 */
import {
  checkHumanAuthority, type ApprovalAuthorityRefusal, type HumanAuthorityGate,
} from "../planning/approval-authority.js";
import { admitProductContractRevision } from "./product-contract-admission.js";
import {
  PRODUCT_CONTRACT_LIMITS, productContractRefusal, type ProductContractRefusal,
  type ProductContractRevision,
} from "./product-contract-contract.js";
import { encodeProductContractRevision } from "./product-contract-codec.js";

/** The one gate identity Gate 1 honours. A grant minted for any other gate is a transplant. */
export const PRODUCT_CONTRACT_GATE_1_ID = "moe.product-contract.gate-1";

export interface ProductContractGraphBinding {
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
}
export interface ProductAcceptanceBindingRequest {
  readonly acceptanceContract: unknown;
  readonly gate1Approval: HumanAuthorityGate;
  readonly graphBinding: unknown;
  readonly productContractRevision: unknown;
}
export type ProductContractGate1Result =
  | Readonly<{
    advisoryOnly: true; gate: "GATE_1"; ok: true; revisionDigest: string;
  }>
  | ProductContractRefusal
  | ApprovalAuthorityRefusal;
export type ProductAcceptanceBindingResult =
  | Readonly<{
    acceptanceCriteriaDigest: string;
    advisoryOnly: true;
    graphBinding: ProductContractGraphBinding;
    ok: true;
    productContractRevisionDigest: string;
  }>
  | ProductContractRefusal
  | ApprovalAuthorityRefusal;

const GATE_KEYS = Object.freeze(["gateId", "grant", "workRef"]);
const GRANT_KEYS = Object.freeze([
  "gateId", "grantedAtEpochMs", "principalId", "principalKind", "workRef",
]);
const GRAPH_KEYS = Object.freeze(["graphContentHash", "graphRevisionRef"]);
const REQUEST_KEYS = Object.freeze([
  "acceptanceContract", "gate1Approval", "graphBinding", "productContractRevision",
]);
const encoder = new TextEncoder();

function boundedRef(candidate: unknown): candidate is string {
  return validRef(candidate) && candidate.isWellFormed()
    && candidate.normalize("NFC") === candidate && !candidate.includes("\0")
    && encoder.encode(candidate).byteLength <= PRODUCT_CONTRACT_LIMITS.maxIdBytes;
}

const refuseGate = (
  code: "PRODUCT_CONTRACT_GATE_1_REQUIRED" | "PRODUCT_CONTRACT_GATE_1_BINDING_INVALID",
): ProductContractRefusal => productContractRefusal(code, "GATE_1");
const refuseAcceptance = (
  code: "PRODUCT_CONTRACT_ACCEPTANCE_INVALID"
    | "PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH"
    | "PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH"
    | "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS",
): ProductContractRefusal => productContractRefusal(code, "ACCEPTANCE_BINDING");

function admittedRevision(value: unknown): ProductContractRevision | ProductContractRefusal {
  const encoded = encodeProductContractRevision(value); if (!encoded.ok) return encoded;
  const admitted = admitProductContractRevision(value);
  return admitted.ok ? admitted.revision : admitted;
}

/**
 * STRUCTURE ONLY, AND DELIBERATELY SO. This admits the SHAPE of a gate and
 * nothing more: every question about the principal, the moment and the binding
 * belongs to `checkHumanAuthority`. Re-asking any of them here would let the
 * GATE_1 layer answer first and collapse a grant-internal defect into a GATE_1
 * code, which is indistinguishable from not detecting it at all.
 *
 * The cast is safe for the same reason: `checkHumanAuthority` is total over
 * arbitrary values, so the field TYPES are its question, not this one's. The
 * snapshot is what gets handed on, never the caller's object, so nothing the
 * caller mutates afterwards can change an answer already derived.
 */
function readGate(value: unknown): HumanAuthorityGate | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, GATE_KEYS)) return undefined;
  const grant = snapshot.value["grant"];
  if (grant !== null && !exact(grant, GRANT_KEYS)) return undefined;
  return snapshot.value as unknown as HumanAuthorityGate;
}

/**
 * The work a Gate 1 grant must name: the contract, the revision and the revision
 * DIGEST, encoded so that no combination of ids can imitate another. One grant
 * is therefore usable on exactly one revision of exactly one contract.
 */
function gate1WorkRef(revision: ProductContractRevision): string {
  return `product-contract-gate-1:${JSON.stringify([
    revision.contractId, revision.revisionId, revision.revisionDigest,
  ])}`;
}

/**
 * The UNSATISFIED Gate 1 gate for a revision. It mints nothing and confers
 * nothing: only `grantHumanAuthority`, fed an authenticated principal, can
 * satisfy what this returns. It is published so that a caller never reconstructs
 * the work reference by hand, which is the one way a transplant could be
 * arranged from outside this module.
 */
export function productContractGate1Authority(
  revision: ProductContractRevision,
): HumanAuthorityGate {
  return Object.freeze({
    gateId: PRODUCT_CONTRACT_GATE_1_ID, grant: null, workRef: gate1WorkRef(revision),
  });
}

function readGraphBinding(value: unknown): ProductContractGraphBinding | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, GRAPH_KEYS)
    || !validHex64(snapshot.value["graphContentHash"])
    || !boundedRef(snapshot.value["graphRevisionRef"])) return undefined;
  return Object.freeze({
    graphContentHash: snapshot.value["graphContentHash"],
    graphRevisionRef: snapshot.value["graphRevisionRef"],
  });
}

/**
 * The verdict is DERIVED, never read off caller bytes. `checkHumanAuthority`
 * answers first and its refusal is returned VERBATIM, so the layer that actually
 * refused stays legible; only after it has passed does Gate 1 ask its own
 * question, which is whether this authority was given for THIS revision.
 */
function gateResult(
  revision: ProductContractRevision, gateValue: unknown,
): ProductContractGate1Result {
  if (gateValue === null || gateValue === undefined) {
    return refuseGate("PRODUCT_CONTRACT_GATE_1_REQUIRED");
  }
  const gate = readGate(gateValue);
  if (gate === undefined) return refuseGate("PRODUCT_CONTRACT_GATE_1_BINDING_INVALID");
  const checked = checkHumanAuthority(gate);
  if (!checked.ok) return checked;
  if (gate.gateId !== PRODUCT_CONTRACT_GATE_1_ID || gate.workRef !== gate1WorkRef(revision)) {
    return refuseGate("PRODUCT_CONTRACT_GATE_1_BINDING_INVALID");
  }
  return Object.freeze({
    advisoryOnly: true as const, gate: "GATE_1" as const, ok: true as const,
    revisionDigest: revision.revisionDigest,
  });
}

export function validateProductContractGate1(
  revisionValue: unknown, gate: HumanAuthorityGate,
): ProductContractGate1Result;
export function validateProductContractGate1(
  revisionValue: unknown, gateValue: unknown,
): ProductContractGate1Result {
  const revision = admittedRevision(revisionValue);
  return "ok" in revision ? revision : gateResult(revision, gateValue);
}

function admittedAcceptance(value: unknown): AcceptanceContract | undefined {
  const encoded = encodeAcceptanceContract(value); if (!encoded.ok) return undefined;
  const admitted = admitAcceptanceContract(value);
  return admitted.ok ? admitted.contract : undefined;
}

function validCoverage(
  revision: ProductContractRevision, contract: AcceptanceContract,
): ProductContractRefusal | undefined {
  const productCriteria = new Map(revision.criteria.map((item) => [item.criterionId, item]));
  const productRequirements = new Set(revision.requirements.map((item) => item.requirementId));
  const coveredRequirements = new Set<string>(); const coveredCriteria = new Set<string>();
  for (const obligation of contract.obligations) {
    const criterion = productCriteria.get(obligation.criterionId);
    if (criterion === undefined || criterion.statement !== obligation.statement) {
      return refuseAcceptance("PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH");
    }
    coveredCriteria.add(criterion.criterionId);
    for (const evidence of obligation.evidenceRequirements) {
      if (!productRequirements.has(evidence.requirementId)) {
        return refuseAcceptance("PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS");
      }
      coveredRequirements.add(evidence.requirementId);
    }
    if (!obligation.evidenceRequirements.some(
      (evidence) => evidence.requirementId === criterion.requirementId,
    )) return refuseAcceptance("PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS");
  }
  if (revision.requirements.some((item) => !coveredRequirements.has(item.requirementId))) {
    return refuseAcceptance("PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS");
  }
  return revision.criteria.length === coveredCriteria.size ? undefined
    : refuseAcceptance("PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH");
}

/** Validates content and current-graph binding but deliberately returns no execution affordance. */
export function validateProductAcceptanceBinding(
  request: ProductAcceptanceBindingRequest,
): ProductAcceptanceBindingResult;
export function validateProductAcceptanceBinding(
  requestValue: unknown,
): ProductAcceptanceBindingResult {
  const snapshot = snapshotData(requestValue);
  if (!snapshot.ok || !exact(snapshot.value, REQUEST_KEYS)) {
    return refuseAcceptance("PRODUCT_CONTRACT_ACCEPTANCE_INVALID");
  }
  const request = snapshot.value;
  const revision = admittedRevision(request["productContractRevision"]);
  if ("ok" in revision) return revision;
  const gate = gateResult(revision, request["gate1Approval"]); if (!gate.ok) return gate;
  const graph = readGraphBinding(request["graphBinding"]);
  const contract = admittedAcceptance(request["acceptanceContract"]);
  if (graph === undefined || contract === undefined) {
    return refuseAcceptance("PRODUCT_CONTRACT_ACCEPTANCE_INVALID");
  }
  if (graph.graphContentHash !== contract.applicability.graphContentHash
    || graph.graphRevisionRef !== contract.applicability.graphRevisionRef) {
    return refuseAcceptance("PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH");
  }
  const coverage = validCoverage(revision, contract); if (coverage !== undefined) return coverage;
  return Object.freeze({
    acceptanceCriteriaDigest: contract.criteriaDigest, advisoryOnly: true as const,
    graphBinding: graph, ok: true as const,
    productContractRevisionDigest: revision.revisionDigest,
  });
}
