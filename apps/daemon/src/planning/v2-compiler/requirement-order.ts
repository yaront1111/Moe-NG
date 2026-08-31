import type { ProductContractRevisionV2, ProductContractV2Requirement } from "@moe/core";

import type { V2CompiledCriterionBinding } from "./contracts.js";
import type { NodeFact } from "./topology.js";

function allRequirements(contract: ProductContractRevisionV2): readonly ProductContractV2Requirement[] {
  return [
    ...contract.deploymentRequirements, ...contract.functionalRequirements,
    ...contract.nonFunctionalRequirements, ...contract.securityPrivacyRequirements,
    ...contract.technologyRequirements, ...contract.uxAccessibilityRequirements,
  ];
}

function transitiveDependencies(
  requirementId: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const result = new Set<string>(); const pending = [...(dependencies.get(requirementId) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current); pending.push(...(dependencies.get(current) ?? []));
  }
  return result;
}

function nodeAncestors(nodes: ReadonlyMap<string, NodeFact>): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  for (const node of nodes.values()) {
    const pending = [...node.dependencyIds]; const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current); pending.push(...(nodes.get(current)?.dependencyIds ?? []));
    }
    result.set(node.nodeId, seen);
  }
  return result;
}

export function contractRequirementOrderValid(
  contract: ProductContractRevisionV2,
  criteria: readonly V2CompiledCriterionBinding[],
  nodes: ReadonlyMap<string, NodeFact>,
): boolean {
  const requirements = allRequirements(contract);
  const ancestors = nodeAncestors(nodes);
  const dependencies = new Map(requirements.map(
    (requirement) => [requirement.requirementId, requirement.dependsOnRequirementIds],
  ));
  const owners = new Map<string, Set<string>>();
  const verifiers = new Map<string, Set<string>>();
  for (const criterion of criteria) {
    const values = owners.get(criterion.requirementId) ?? new Set<string>();
    values.add(criterion.ownerNodeId); owners.set(criterion.requirementId, values);
    const verifierValues = verifiers.get(criterion.requirementId) ?? new Set<string>();
    verifierValues.add(criterion.verifierNodeId);
    verifiers.set(criterion.requirementId, verifierValues);
  }
  for (const requirement of requirements) {
    for (const dependencyId of transitiveDependencies(requirement.requirementId, dependencies)) {
      for (const owner of owners.get(requirement.requirementId) ?? []) {
        if (owners.get(dependencyId)?.has(owner)) continue;
        for (const prerequisiteVerifier of verifiers.get(dependencyId) ?? []) {
          if (owner !== prerequisiteVerifier && !ancestors.get(owner)?.has(prerequisiteVerifier)) {
            return false;
          }
        }
      }
    }
  }
  return true;
}
