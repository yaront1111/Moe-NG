import type { ProductContractRevisionV2, ProductContractV2Requirement } from "@moe/core";

import { gate1Requirements } from "./gate1-contract-shape.js";

function hasRequirementCycle(requirements: readonly ProductContractV2Requirement[]): boolean {
  const edges = new Map(requirements.map((row) => [row.requirementId, row.dependsOnRequirementIds]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return requirements.some((row) => visit(row.requirementId));
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validGate1RevisionSemantics(revision: ProductContractRevisionV2): boolean {
  const requirements = gate1Requirements(revision);
  const requirementIds = new Set<string>();
  for (const row of requirements) {
    if (requirementIds.has(row.requirementId)) return false;
    requirementIds.add(row.requirementId);
  }
  if (revision.retiredRequirementIds.some((id) => requirementIds.has(id))) return false;
  const retiredRequirements = new Set(revision.retiredRequirementIds);
  const supersededRequirements = new Set<string>();
  for (const row of requirements) {
    if (row.dependsOnRequirementIds.some((id) => !requirementIds.has(id))) return false;
    if (row.supersedesRequirementId !== null) {
      if (!retiredRequirements.has(row.supersedesRequirementId)
        || supersededRequirements.has(row.supersedesRequirementId)) return false;
      supersededRequirements.add(row.supersedesRequirementId);
    }
  }
  if (hasRequirementCycle(requirements)) return false;

  const criterionIds = new Set(revision.criteria.map((row) => row.criterionId));
  if (revision.retiredCriterionIds.some((id) => criterionIds.has(id))) return false;
  const retiredCriteria = new Set(revision.retiredCriterionIds);
  const supersededCriteria = new Set<string>();
  const coveredRequirements = new Set<string>();
  for (const row of revision.criteria) {
    if (!requirementIds.has(row.requirementId)) return false;
    if (row.supersedesCriterionId !== null) {
      if (!retiredCriteria.has(row.supersedesCriterionId)
        || supersededCriteria.has(row.supersedesCriterionId)) return false;
      supersededCriteria.add(row.supersedesCriterionId);
    }
    coveredRequirements.add(row.requirementId);
  }
  if ([...requirementIds].some((id) => !coveredRequirements.has(id))) return false;

  const userJobIds = new Set(revision.userJobs.map((row) => row.userJobId));
  const representedJobs = new Set<string>();
  for (const journey of revision.journeys) {
    if (!userJobIds.has(journey.userJobId)
      || journey.criterionIds.some((id) => !criterionIds.has(id))) return false;
    representedJobs.add(journey.userJobId);
  }
  if ([...userJobIds].some((id) => !representedJobs.has(id))) return false;
  if (revision.assumptions.some((row) => !criterionIds.has(row.validationCriterionId))) {
    return false;
  }

  const objectiveIds = new Set(revision.objectives.map((row) => row.objectiveId));
  const measuredObjectives = new Set<string>();
  for (const metric of revision.successMetrics) {
    if (metric.objectiveIds.some((id) => !objectiveIds.has(id))) return false;
    metric.objectiveIds.forEach((id) => measuredObjectives.add(id));
  }
  if ([...objectiveIds].some((id) => !measuredObjectives.has(id))) return false;

  for (const decision of revision.materialDecisions) {
    if (decision.selectedOptionId === null
      || !decision.options.some((option) => option.optionId === decision.selectedOptionId)) {
      return false;
    }
  }
  if (!same(revision.productCompleteDefinition.criterionIds, [...criterionIds].sort())) return false;
  if (revision.lineage === null && (revision.retiredCriterionIds.length > 0
    || revision.retiredRequirementIds.length > 0
    || revision.criteria.some((row) => row.supersedesCriterionId !== null)
    || requirements.some((row) => row.supersedesRequirementId !== null))) return false;
  return true;
}
