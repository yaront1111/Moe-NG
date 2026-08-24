import { exact, snapshotData, validHex64, validRef } from "../planning/planning-snapshot.js";
import { admitAcceptanceContract, type AcceptanceContract } from "../planning/acceptance-contract.js";
import { encodeAcceptanceContract } from "../planning/acceptance-contract-codec.js";
import { admitProductContractRevision } from "./product-contract-admission.js";
import {
  PRODUCT_CONTRACT_LIMITS, productContractRefusal, type ProductContractRefusal,
  type ProductContractRevision,
} from "./product-contract-contract.js";
import { encodeProductContractRevision } from "./product-contract-codec.js";

export interface ProductContractGate1Approval {
  readonly approvalId: string;
  readonly approvedAtEpochMs: number;
  readonly contractId: string;
  readonly principalId: string;
  readonly principalKind: "HUMAN";
  readonly revisionDigest: string;
  readonly revisionId: string;
}
export interface ProductContractGraphBinding {
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
}
export interface ProductAcceptanceBindingRequest {
  readonly acceptanceContract: unknown;
  readonly gate1Approval: unknown;
  readonly graphBinding: unknown;
  readonly productContractRevision: unknown;
}
export type ProductContractGate1Result =
  | Readonly<{
    advisoryOnly: true; gate: "GATE_1"; ok: true; revisionDigest: string;
  }>
  | ProductContractRefusal;
export type ProductAcceptanceBindingResult =
  | Readonly<{
    acceptanceCriteriaDigest: string;
    advisoryOnly: true;
    graphBinding: ProductContractGraphBinding;
    ok: true;
    productContractRevisionDigest: string;
  }>
  | ProductContractRefusal;

const APPROVAL_KEYS = Object.freeze([
  "approvalId", "approvedAtEpochMs", "contractId", "principalId", "principalKind",
  "revisionDigest", "revisionId",
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

function readApproval(value: unknown): ProductContractGate1Approval | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, APPROVAL_KEYS)) return undefined;
  const record = snapshot.value;
  if (![record["approvalId"], record["contractId"], record["principalId"], record["revisionId"]]
    .every(boundedRef) || record["principalKind"] !== "HUMAN"
    || !validHex64(record["revisionDigest"])
    || !Number.isSafeInteger(record["approvedAtEpochMs"])
    || (record["approvedAtEpochMs"] as number) < 0) return undefined;
  return Object.freeze({
    approvalId: record["approvalId"] as string,
    approvedAtEpochMs: record["approvedAtEpochMs"] as number,
    contractId: record["contractId"] as string,
    principalId: record["principalId"] as string,
    principalKind: "HUMAN" as const,
    revisionDigest: record["revisionDigest"] as string,
    revisionId: record["revisionId"] as string,
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

function gateResult(
  revision: ProductContractRevision, approvalValue: unknown,
): ProductContractGate1Result {
  if (approvalValue === null || approvalValue === undefined) {
    return refuseGate("PRODUCT_CONTRACT_GATE_1_REQUIRED");
  }
  const approval = readApproval(approvalValue);
  if (approval === undefined || approval.contractId !== revision.contractId
    || approval.revisionId !== revision.revisionId
    || approval.revisionDigest !== revision.revisionDigest) {
    return refuseGate("PRODUCT_CONTRACT_GATE_1_BINDING_INVALID");
  }
  return Object.freeze({
    advisoryOnly: true as const, gate: "GATE_1" as const, ok: true as const,
    revisionDigest: revision.revisionDigest,
  });
}

export function validateProductContractGate1(
  revisionValue: unknown, approvalValue: unknown,
): ProductContractGate1Result {
  const revision = admittedRevision(revisionValue);
  return "ok" in revision ? revision : gateResult(revision, approvalValue);
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
