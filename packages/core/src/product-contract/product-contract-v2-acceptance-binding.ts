import { ACCEPTANCE_CONTRACT_LIMITS, admitAcceptanceContract, type AcceptanceContract } from
  "../planning/acceptance-contract.js";
import { encodeAcceptanceContract } from "../planning/acceptance-contract-codec.js";
import type { HumanAuthorityGate } from "../planning/approval-authority.js";
import {
  exact, validHex64, validRef,
} from "../planning/planning-snapshot.js";
import type {
  ProductAcceptanceBindingResult, ProductContractGraphBinding,
} from "./product-contract-acceptance-binding.js";
import {
  productContractRefusal, type ProductContractRefusal,
} from "./product-contract-contract.js";
import { admitProductContractRevisionV2 } from "./product-contract-v2-admission.js";
import { encodeProductContractRevisionV2 } from "./product-contract-v2-codec.js";
import type {
  ProductContractRevisionV2, ProductContractV2Refusal, ProductContractV2Requirement,
} from "./product-contract-v2-contract.js";
import { PRODUCT_CONTRACT_V2_LIMITS } from "./product-contract-v2-contract.js";
import {
  validateProductContractGate1V2, type ProductContractV2Gate1Result,
} from "./product-contract-v2-gate-1.js";
import { snapshotProductAcceptanceData } from
  "./product-contract-v2-acceptance-snapshot.js";

export interface ProductAcceptanceBindingV2Request {
  readonly acceptanceContract: unknown;
  readonly gate1Approval: HumanAuthorityGate;
  readonly graphBinding: unknown;
  readonly productContractRevision: unknown;
}
export type ProductAcceptanceBindingV2Result =
  | Extract<ProductAcceptanceBindingResult, { readonly ok: true }>
  | Exclude<ProductContractV2Gate1Result, { readonly ok: true }>
  | ProductContractRefusal
  | ProductContractV2Refusal;

const REQUEST_KEYS = Object.freeze([
  "acceptanceContract", "gate1Approval", "graphBinding", "productContractRevision",
]);
const GRAPH_KEYS = Object.freeze(["graphContentHash", "graphRevisionRef"]);
const encoder = new TextEncoder();

const refuse = (
  code: "PRODUCT_CONTRACT_ACCEPTANCE_INVALID"
    | "PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH"
    | "PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH"
    | "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS",
): ProductContractRefusal => productContractRefusal(code, "ACCEPTANCE_BINDING");

function snapshotRequest(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const snapshot = snapshotProductAcceptanceData(value, {
    maxArrayLength: Math.max(
      ACCEPTANCE_CONTRACT_LIMITS.maxAggregateEntries,
      PRODUCT_CONTRACT_V2_LIMITS.maxRetiredIds,
    ),
    maxDepth: PRODUCT_CONTRACT_V2_LIMITS.maxSnapshotDepth + 4,
    maxNodes: PRODUCT_CONTRACT_V2_LIMITS.maxSnapshotNodes
      + ACCEPTANCE_CONTRACT_LIMITS.maxAggregateEntries + 16,
  });
  return snapshot.ok && exact(snapshot.value, REQUEST_KEYS) ? snapshot.value : undefined;
}

function boundedRef(candidate: unknown): candidate is string {
  return validRef(candidate) && candidate.length <= PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes
    && candidate.isWellFormed()
    && candidate.normalize("NFC") === candidate && !candidate.includes("\0")
    && encoder.encode(candidate).byteLength <= PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes;
}

function readGraphBinding(value: unknown): ProductContractGraphBinding | undefined {
  if (!exact(value, GRAPH_KEYS) || !validHex64(value["graphContentHash"])
    || !boundedRef(value["graphRevisionRef"])) return undefined;
  return Object.freeze({
    graphContentHash: value["graphContentHash"], graphRevisionRef: value["graphRevisionRef"],
  });
}

function admittedAcceptance(value: unknown): AcceptanceContract | undefined {
  const encoded = encodeAcceptanceContract(value); if (!encoded.ok) return undefined;
  const admitted = admitAcceptanceContract(value);
  return admitted.ok ? admitted.contract : undefined;
}

function requirementsOf(
  revision: ProductContractRevisionV2,
): readonly ProductContractV2Requirement[] {
  return [
    ...revision.deploymentRequirements, ...revision.functionalRequirements,
    ...revision.nonFunctionalRequirements, ...revision.securityPrivacyRequirements,
    ...revision.technologyRequirements, ...revision.uxAccessibilityRequirements,
  ];
}

function validateCoverage(
  revision: ProductContractRevisionV2,
  contract: AcceptanceContract,
): ProductContractRefusal | undefined {
  const criteria = new Map(revision.criteria.map((item) => [item.criterionId, item]));
  const requirementIds = new Set(requirementsOf(revision).map((item) => item.requirementId));
  const coveredCriteria = new Set<string>(); const coveredRequirements = new Set<string>();
  for (const obligation of contract.obligations) {
    const criterion = criteria.get(obligation.criterionId);
    if (criterion === undefined || criterion.statement !== obligation.statement) {
      return refuse("PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH");
    }
    coveredCriteria.add(criterion.criterionId);
    for (const evidence of obligation.evidenceRequirements) {
      if (!requirementIds.has(evidence.requirementId)) {
        return refuse("PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS");
      }
      coveredRequirements.add(evidence.requirementId);
    }
    if (!obligation.evidenceRequirements.some(
      (evidence) => evidence.requirementId === criterion.requirementId,
    )) return refuse("PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS");
  }
  if ([...requirementIds].some((id) => !coveredRequirements.has(id))) {
    return refuse("PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS");
  }
  return coveredCriteria.size === criteria.size ? undefined
    : refuse("PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH");
}

/** Validates `/2` product truth against exact graph acceptance; grants no execution authority. */
export function validateProductAcceptanceBindingV2(
  request: ProductAcceptanceBindingV2Request,
): ProductAcceptanceBindingV2Result;
export function validateProductAcceptanceBindingV2(
  requestValue: unknown,
): ProductAcceptanceBindingV2Result {
  const request = snapshotRequest(requestValue);
  if (request === undefined) return refuse("PRODUCT_CONTRACT_ACCEPTANCE_INVALID");
  const encoded = encodeProductContractRevisionV2(request["productContractRevision"]);
  if (!encoded.ok) return encoded;
  const admitted = admitProductContractRevisionV2(request["productContractRevision"]);
  if (!admitted.ok) return admitted;
  const gate = validateProductContractGate1V2(
    admitted.revision, request["gate1Approval"] as HumanAuthorityGate,
  );
  if (!gate.ok) return gate;
  const graph = readGraphBinding(request["graphBinding"]);
  const acceptance = admittedAcceptance(request["acceptanceContract"]);
  if (graph === undefined || acceptance === undefined) {
    return refuse("PRODUCT_CONTRACT_ACCEPTANCE_INVALID");
  }
  if (graph.graphContentHash !== acceptance.applicability.graphContentHash
    || graph.graphRevisionRef !== acceptance.applicability.graphRevisionRef) {
    return refuse("PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH");
  }
  const coverage = validateCoverage(admitted.revision, acceptance);
  if (coverage !== undefined) return coverage;
  return Object.freeze({
    acceptanceCriteriaDigest: acceptance.criteriaDigest, advisoryOnly: true as const,
    graphBinding: graph, ok: true as const,
    productContractRevisionDigest: admitted.revision.revisionDigest,
  });
}
