import { admitProductContractRevisionV2 } from "./product-contract-v2-admission.js";
import { encodeProductContractRevisionV2 } from "./product-contract-v2-codec.js";
import {
  productContractV2Refusal,
  type ProductContractRevisionV2,
  type ProductContractV2Criterion,
  type ProductContractV2Refusal,
  type ProductContractV2Requirement,
} from "./product-contract-v2-contract.js";

export type ProductContractV2AmendmentResult =
  | Readonly<{
    advisoryOnly: true;
    ok: true;
    parentRevisionDigest: string;
    revisionDigest: string;
  }>
  | ProductContractV2Refusal;

type LineageCode =
  | "PRODUCT_CONTRACT_V2_LINEAGE_PARENT_NOT_CURRENT"
  | "PRODUCT_CONTRACT_V2_LINEAGE_CONTRACT_MISMATCH"
  | "PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED"
  | "PRODUCT_CONTRACT_V2_LINEAGE_ID_UNSTABLE"
  | "PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED";

type RequirementSection =
  | "DEPLOYMENT"
  | "FUNCTIONAL"
  | "NON_FUNCTIONAL"
  | "SECURITY_PRIVACY"
  | "TECHNOLOGY"
  | "UX_ACCESSIBILITY";

const lineageRefusal = (code: LineageCode): ProductContractV2Refusal =>
  productContractV2Refusal(code, "PRODUCT_CONTRACT_V2_LINEAGE");

function validRevision(value: unknown): ProductContractRevisionV2 | ProductContractV2Refusal {
  const encoded = encodeProductContractRevisionV2(value); if (!encoded.ok) return encoded;
  const admitted = admitProductContractRevisionV2(value);
  return admitted.ok ? admitted.revision : admitted;
}

function requirementEntries(
  revision: ProductContractRevisionV2,
): readonly (readonly [ProductContractV2Requirement, RequirementSection])[] {
  return [
    ...revision.deploymentRequirements.map((item) => [item, "DEPLOYMENT"] as const),
    ...revision.functionalRequirements.map((item) => [item, "FUNCTIONAL"] as const),
    ...revision.nonFunctionalRequirements.map((item) => [item, "NON_FUNCTIONAL"] as const),
    ...revision.securityPrivacyRequirements.map((item) => [item, "SECURITY_PRIVACY"] as const),
    ...revision.technologyRequirements.map((item) => [item, "TECHNOLOGY"] as const),
    ...revision.uxAccessibilityRequirements.map((item) => [item, "UX_ACCESSIBILITY"] as const),
  ];
}

function requirementById(
  revision: ProductContractRevisionV2,
  id: string,
): readonly [ProductContractV2Requirement, RequirementSection] | undefined {
  return requirementEntries(revision).find(([item]) => item.requirementId === id);
}

function criterionById(
  revision: ProductContractRevisionV2,
  id: string,
): ProductContractV2Criterion | undefined {
  return revision.criteria.find((item) => item.criterionId === id);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameRequirementMeaning(
  left: readonly [ProductContractV2Requirement, RequirementSection],
  right: readonly [ProductContractV2Requirement, RequirementSection],
): boolean {
  return left[1] === right[1]
    && left[0].statement === right[0].statement
    && left[0].priority === right[0].priority
    && sameStrings(left[0].dependsOnRequirementIds, right[0].dependsOnRequirementIds);
}

function sameCarriedRequirement(
  left: readonly [ProductContractV2Requirement, RequirementSection],
  right: readonly [ProductContractV2Requirement, RequirementSection],
): boolean {
  return sameRequirementMeaning(left, right)
    && left[0].supersedesRequirementId === right[0].supersedesRequirementId;
}

function requirementContinues(
  currentRequirementId: string,
  candidateRequirementId: string,
  candidate: ProductContractRevisionV2,
): boolean {
  if (currentRequirementId === candidateRequirementId) return true;
  return requirementById(candidate, candidateRequirementId)?.[0].supersedesRequirementId
    === currentRequirementId;
}

function requirementMeaningContinues(
  current: ProductContractRevisionV2,
  candidate: ProductContractRevisionV2,
  currentRequirementId: string,
  candidateRequirementId: string,
): boolean {
  if (requirementContinues(currentRequirementId, candidateRequirementId, candidate)) return true;
  const prior = requirementById(current, currentRequirementId);
  const next = requirementById(candidate, candidateRequirementId);
  return prior !== undefined && next !== undefined && sameRequirementMeaning(prior, next);
}

function validRequirementChanges(
  current: ProductContractRevisionV2,
  candidate: ProductContractRevisionV2,
): ProductContractV2Refusal | undefined {
  const superseded = new Set<string>();
  const retired = new Set(candidate.retiredRequirementIds);
  for (const historicalId of current.retiredRequirementIds) {
    if (requirementById(candidate, historicalId) !== undefined) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED");
    }
    if (!retired.has(historicalId)) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
    }
  }
  for (const next of requirementEntries(candidate)) {
    const carried = requirementById(current, next[0].requirementId);
    if (carried !== undefined) {
      if (!sameCarriedRequirement(carried, next)) {
        return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED");
      }
      if (retired.has(next[0].requirementId)) {
        return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
      }
      continue;
    }
    const replacedId = next[0].supersedesRequirementId;
    if (replacedId === null) {
      if (requirementEntries(current).some((prior) => sameRequirementMeaning(prior, next)
        && requirementById(candidate, prior[0].requirementId) === undefined)) {
        return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_ID_UNSTABLE");
      }
      continue;
    }
    const prior = requirementById(current, replacedId);
    if (prior === undefined || requirementById(candidate, replacedId) !== undefined
      || !retired.has(replacedId) || superseded.has(replacedId)) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
    }
    if (sameRequirementMeaning(prior, next)) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_ID_UNSTABLE");
    }
    superseded.add(replacedId);
  }
  for (const id of retired) {
    if ((requirementById(current, id) === undefined && !current.retiredRequirementIds.includes(id))
      || requirementById(candidate, id) !== undefined) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
    }
  }
  return requirementEntries(current).every(([prior]) =>
    requirementById(candidate, prior.requirementId) !== undefined
    || retired.has(prior.requirementId))
    ? undefined : lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
}

function sameCriterionMeaning(
  left: ProductContractV2Criterion,
  right: ProductContractV2Criterion,
  current: ProductContractRevisionV2,
  candidate: ProductContractRevisionV2,
): boolean {
  return left.statement === right.statement
    && left.verification === right.verification
    && requirementMeaningContinues(
      current, candidate, left.requirementId, right.requirementId,
    );
}

function validCriterionChanges(
  current: ProductContractRevisionV2,
  candidate: ProductContractRevisionV2,
): ProductContractV2Refusal | undefined {
  const superseded = new Set<string>();
  const retired = new Set(candidate.retiredCriterionIds);
  for (const historicalId of current.retiredCriterionIds) {
    if (criterionById(candidate, historicalId) !== undefined) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED");
    }
    if (!retired.has(historicalId)) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
    }
  }
  for (const next of candidate.criteria) {
    const carried = criterionById(current, next.criterionId);
    if (carried !== undefined) {
      if (carried.statement !== next.statement || carried.verification !== next.verification
        || carried.supersedesCriterionId !== next.supersedesCriterionId
        || carried.requirementId !== next.requirementId) {
        return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED");
      }
      if (retired.has(next.criterionId)) {
        return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
      }
      continue;
    }
    const replacedId = next.supersedesCriterionId;
    if (replacedId === null) {
      if (current.criteria.some((prior) => sameCriterionMeaning(prior, next, current, candidate)
        && criterionById(candidate, prior.criterionId) === undefined)) {
        return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_ID_UNSTABLE");
      }
      continue;
    }
    const prior = criterionById(current, replacedId);
    if (prior === undefined || criterionById(candidate, replacedId) !== undefined
      || !retired.has(replacedId) || superseded.has(replacedId)) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
    }
    if (sameCriterionMeaning(prior, next, current, candidate)) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_ID_UNSTABLE");
    }
    superseded.add(replacedId);
  }
  for (const id of retired) {
    if ((criterionById(current, id) === undefined && !current.retiredCriterionIds.includes(id))
      || criterionById(candidate, id) !== undefined) {
      return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
    }
  }
  return current.criteria.every((prior) => criterionById(candidate, prior.criterionId) !== undefined
    || retired.has(prior.criterionId))
    ? undefined : lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED");
}

/** Checks one immutable candidate against the exact currently-effective `/2` parent. */
export function validateProductContractV2Amendment(
  currentValue: unknown,
  candidateValue: unknown,
): ProductContractV2AmendmentResult {
  const current = validRevision(currentValue);
  if ("ok" in current) return current;
  const candidate = validRevision(candidateValue);
  if ("ok" in candidate) return candidate;
  if (current.contractId !== candidate.contractId) {
    return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_CONTRACT_MISMATCH");
  }
  if (candidate.revisionId === current.revisionId || candidate.lineage === null
    || candidate.lineage.parentRevisionId !== current.revisionId
    || candidate.lineage.parentRevisionDigest !== current.revisionDigest) {
    return lineageRefusal("PRODUCT_CONTRACT_V2_LINEAGE_PARENT_NOT_CURRENT");
  }
  const requirements = validRequirementChanges(current, candidate); if (requirements) return requirements;
  const criteria = validCriterionChanges(current, candidate); if (criteria) return criteria;
  return Object.freeze({
    advisoryOnly: true as const,
    ok: true as const,
    parentRevisionDigest: current.revisionDigest,
    revisionDigest: candidate.revisionDigest,
  });
}
