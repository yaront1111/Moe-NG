import { admitProductContractRevision } from "./product-contract-admission.js";
import {
  productContractRefusal, type ProductContractCriterion, type ProductContractRefusal,
  type ProductContractRequirement, type ProductContractRevision,
} from "./product-contract-contract.js";
import { encodeProductContractRevision } from "./product-contract-codec.js";

export type ProductContractAmendmentResult =
  | Readonly<{
    advisoryOnly: true;
    ok: true;
    parentRevisionDigest: string;
    revisionDigest: string;
  }>
  | ProductContractRefusal;

const lineageRefusal = (
  code: "PRODUCT_CONTRACT_LINEAGE_PARENT_NOT_CURRENT"
    | "PRODUCT_CONTRACT_LINEAGE_CONTRACT_MISMATCH"
    | "PRODUCT_CONTRACT_LINEAGE_ID_REUSED"
    | "PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE"
    | "PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED",
): ProductContractRefusal => productContractRefusal(code, "LINEAGE");

function validRevision(value: unknown): ProductContractRevision | ProductContractRefusal {
  const encoded = encodeProductContractRevision(value); if (!encoded.ok) return encoded;
  const admitted = admitProductContractRevision(value);
  return admitted.ok ? admitted.revision : admitted;
}

function requirementById(
  revision: ProductContractRevision, id: string,
): ProductContractRequirement | undefined {
  return revision.requirements.find((item) => item.requirementId === id);
}

function criterionById(
  revision: ProductContractRevision, id: string,
): ProductContractCriterion | undefined {
  return revision.criteria.find((item) => item.criterionId === id);
}

function requirementContinues(
  currentRequirementId: string, candidateRequirementId: string,
  candidate: ProductContractRevision,
): boolean {
  if (currentRequirementId === candidateRequirementId) return true;
  return requirementById(candidate, candidateRequirementId)?.supersedesRequirementId
    === currentRequirementId;
}

function requirementMeaningContinues(
  current: ProductContractRevision, candidate: ProductContractRevision,
  currentRequirementId: string, candidateRequirementId: string,
): boolean {
  if (requirementContinues(currentRequirementId, candidateRequirementId, candidate)) return true;
  const prior = requirementById(current, currentRequirementId);
  const next = requirementById(candidate, candidateRequirementId);
  return prior !== undefined && next !== undefined && prior.statement === next.statement;
}

function validRequirementChanges(
  current: ProductContractRevision, candidate: ProductContractRevision,
): ProductContractRefusal | undefined {
  const superseded = new Set<string>();
  const retired = new Set(candidate.retiredRequirementIds);
  for (const historicalId of current.retiredRequirementIds) {
    if (requirementById(candidate, historicalId) !== undefined) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_ID_REUSED");
    }
    if (!retired.has(historicalId)) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
    }
  }
  for (const next of candidate.requirements) {
    const carried = requirementById(current, next.requirementId);
    if (carried !== undefined) {
      if (next.statement !== carried.statement
        || next.supersedesRequirementId !== carried.supersedesRequirementId) {
        return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_ID_REUSED");
      }
      if (retired.has(next.requirementId)) {
        return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
      }
      continue;
    }
    if (next.supersedesRequirementId === null) {
      if (current.requirements.some((prior) => prior.statement === next.statement
        && requirementById(candidate, prior.requirementId) === undefined)) {
        return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE");
      }
      continue;
    }
    const prior = requirementById(current, next.supersedesRequirementId);
    if (prior === undefined || requirementById(candidate, prior.requirementId) !== undefined
      || !retired.has(prior.requirementId) || superseded.has(prior.requirementId)) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
    }
    if (next.statement === prior.statement) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE");
    }
    superseded.add(prior.requirementId);
  }
  for (const id of retired) {
    if ((requirementById(current, id) === undefined && !current.retiredRequirementIds.includes(id))
      || requirementById(candidate, id) !== undefined) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
    }
  }
  return current.requirements.every((prior) => requirementById(candidate, prior.requirementId)
    !== undefined || (superseded.has(prior.requirementId) && retired.has(prior.requirementId))
    || retired.has(prior.requirementId))
    ? undefined : lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
}

function validCriterionChanges(
  current: ProductContractRevision, candidate: ProductContractRevision,
): ProductContractRefusal | undefined {
  const superseded = new Set<string>();
  const retired = new Set(candidate.retiredCriterionIds);
  for (const historicalId of current.retiredCriterionIds) {
    if (criterionById(candidate, historicalId) !== undefined) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_ID_REUSED");
    }
    if (!retired.has(historicalId)) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
    }
  }
  for (const next of candidate.criteria) {
    const carried = criterionById(current, next.criterionId);
    if (carried !== undefined) {
      if (next.statement !== carried.statement
        || next.supersedesCriterionId !== carried.supersedesCriterionId
        || !requirementContinues(carried.requirementId, next.requirementId, candidate)) {
        return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_ID_REUSED");
      }
      if (retired.has(next.criterionId)) {
        return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
      }
      continue;
    }
    if (next.supersedesCriterionId === null) {
      if (current.criteria.some((prior) => prior.statement === next.statement
        && criterionById(candidate, prior.criterionId) === undefined
        && requirementMeaningContinues(
          current, candidate, prior.requirementId, next.requirementId,
        ))) return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE");
      continue;
    }
    const prior = criterionById(current, next.supersedesCriterionId);
    if (prior === undefined || criterionById(candidate, prior.criterionId) !== undefined
      || !retired.has(prior.criterionId) || superseded.has(prior.criterionId)) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
    }
    if (next.statement === prior.statement
      && requirementContinues(prior.requirementId, next.requirementId, candidate)) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE");
    }
    superseded.add(prior.criterionId);
  }
  for (const id of retired) {
    if ((criterionById(current, id) === undefined && !current.retiredCriterionIds.includes(id))
      || criterionById(candidate, id) !== undefined) {
      return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
    }
  }
  return current.criteria.every((prior) => criterionById(candidate, prior.criterionId)
    !== undefined || (superseded.has(prior.criterionId) && retired.has(prior.criterionId))
    || retired.has(prior.criterionId))
    ? undefined : lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED");
}

/** Checks one immutable candidate against the exact currently-effective parent. */
export function validateProductContractAmendment(
  currentValue: unknown, candidateValue: unknown,
): ProductContractAmendmentResult {
  const current = validRevision(currentValue); if ("ok" in current) return current;
  const candidate = validRevision(candidateValue); if ("ok" in candidate) return candidate;
  if (current.contractId !== candidate.contractId) {
    return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_CONTRACT_MISMATCH");
  }
  if (candidate.revisionId === current.revisionId || candidate.lineage === null
    || candidate.lineage.parentRevisionId !== current.revisionId
    || candidate.lineage.parentRevisionDigest !== current.revisionDigest) {
    return lineageRefusal("PRODUCT_CONTRACT_LINEAGE_PARENT_NOT_CURRENT");
  }
  const requirements = validRequirementChanges(current, candidate); if (requirements) return requirements;
  const criteria = validCriterionChanges(current, candidate); if (criteria) return criteria;
  return Object.freeze({
    advisoryOnly: true as const, ok: true as const,
    parentRevisionDigest: current.revisionDigest, revisionDigest: candidate.revisionDigest,
  });
}
