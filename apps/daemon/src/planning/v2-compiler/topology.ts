import type { ProductContractRevisionV2 } from "@moe/core";
import {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  ABSOLUTE_MAX_GRAPH_NODES,
  MAX_GRAPH_KEY_CODE_UNITS,
} from "@moe/scheduler";

import {
  v2CompilerRefusal,
  type V2CompiledCriterionBinding,
  type V2CompilerRefusal,
  type V2CriterionCategory,
  type V2NodeAuthorityKind,
} from "./contracts.js";
import {
  assemblePreparedDag, materialBindingsConflict, type PreparedDag,
} from "./assembly.js";
import type { AdmittedCapabilityBinding, AdmittedResolution } from "./resolution.js";
import { contractRequirementOrderValid } from "./requirement-order.js";
import { exact, materialDigest, text } from "./snapshot.js";
import { graphIsCyclic } from "./topology-cycle.js";

const NODE_KEYS = Object.freeze([
  "authorityKind", "budgetRefs", "capabilityId", "criterionRefs", "dependsOn",
  "nodeId", "resolutionRef",
]);
const SCHEDULER_GRAPH_KEY = /^[A-Za-z0-9_][A-Za-z0-9._:@/+~-]*$/u;

export function schedulerGraphKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= MAX_GRAPH_KEY_CODE_UNITS && SCHEDULER_GRAPH_KEY.test(value);
}

export interface NodeFact {
  readonly authorityKind: V2NodeAuthorityKind;
  readonly budgetIds: readonly string[];
  readonly capabilityId: string;
  readonly criterionIds: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly nodeId: string;
  readonly capabilityBinding: AdmittedCapabilityBinding;
  readonly resolution: AdmittedResolution;
}

type PrepareResult = Readonly<{
  facts: readonly NodeFact[]; ok: true; prepared: PreparedDag;
}> | V2CompilerRefusal;
const refusal = (code: Parameters<typeof v2CompilerRefusal>[0],
  layer: Parameters<typeof v2CompilerRefusal>[1]): V2CompilerRefusal =>
  v2CompilerRefusal(code, layer);

function refs(value: unknown, key: "budgetId" | "criterionId" | "nodeId"):
readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const candidate of value) {
    if (!exact(candidate, [key]) || !text(candidate[key])) return undefined;
    result.push(candidate[key]);
  }
  return Object.freeze(result);
}

function resolutionKey(catalogRevisionDigest: string, builderCapabilityId: string): string {
  return `${catalogRevisionDigest}\0${builderCapabilityId}`;
}

function readNodes(value: unknown, resolutions: ReadonlyMap<string, AdmittedResolution>):
readonly NodeFact[] | V2CompilerRefusal {
  if (!Array.isArray(value)) return refusal("V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT");
  if (value.length === 0) return refusal("V2_COMPILER_GRAPH_EMPTY", "V2_COMPILER_TOPOLOGY");
  if (value.length > ABSOLUTE_MAX_GRAPH_NODES) return refusal(
    "V2_COMPILER_GRAPH_LIMIT_EXCEEDED", "V2_COMPILER_TOPOLOGY",
  );
  const nodes: NodeFact[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!exact(candidate, NODE_KEYS) || !schedulerGraphKey(candidate["nodeId"])
      || !schedulerGraphKey(candidate["capabilityId"])
      || (candidate["authorityKind"] !== "BUILDER" && candidate["authorityKind"] !== "VERIFIER")) {
      return refusal("V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT");
    }
    const reference = candidate["resolutionRef"];
    if (!exact(reference, ["builderCapabilityId", "catalogRevisionDigest"])
      || !text(reference["builderCapabilityId"])
      || !materialDigest(reference["catalogRevisionDigest"])) {
      return refusal("V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT");
    }
    if (ids.has(candidate["nodeId"])) {
      return refusal("V2_COMPILER_NODE_DUPLICATE", "V2_COMPILER_TOPOLOGY");
    }
    ids.add(candidate["nodeId"]);
    const budgetIds = refs(candidate["budgetRefs"], "budgetId");
    const criterionIds = refs(candidate["criterionRefs"], "criterionId");
    const dependencyIds = refs(candidate["dependsOn"], "nodeId");
    if (budgetIds === undefined || criterionIds === undefined || dependencyIds === undefined) {
      return refusal("V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT");
    }
    if (dependencyIds.some((id) => !schedulerGraphKey(id))) return refusal(
      "V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT",
    );
    if (criterionIds.length === 0) return refusal(
      "V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT",
    );
    if (new Set(criterionIds).size !== criterionIds.length) return refusal(
      candidate["authorityKind"] === "BUILDER"
        ? "V2_COMPILER_CRITERION_OWNER_MULTIPLE"
        : "V2_COMPILER_CRITERION_VERIFIER_MULTIPLE",
      "V2_COMPILER_COVERAGE",
    );
    if (budgetIds.length === 0) return refusal(
      "V2_COMPILER_BUDGET_MISSING", "V2_COMPILER_BUDGET",
    );
    if (new Set(budgetIds).size !== budgetIds.length) return refusal(
      "V2_COMPILER_BUDGET_INVALID", "V2_COMPILER_BUDGET",
    );
    if (new Set(dependencyIds).size !== dependencyIds.length) return refusal(
      "V2_COMPILER_DEPENDENCY_DUPLICATE", "V2_COMPILER_TOPOLOGY",
    );
    const resolved = resolutions.get(resolutionKey(
      reference["catalogRevisionDigest"], reference["builderCapabilityId"],
    ));
    if (resolved === undefined) return refusal(
      "V2_COMPILER_CAPABILITY_UNRESOLVED", "V2_COMPILER_CAPABILITY_BINDING",
    );
    const capabilityBinding = candidate["authorityKind"] === "BUILDER"
      ? resolved.builder
      : resolved.verifiers.find((item) => item.capabilityId === candidate["capabilityId"]);
    if (capabilityBinding === undefined || capabilityBinding.capabilityId !== candidate["capabilityId"]
      || capabilityBinding.authorityKind !== candidate["authorityKind"]
      || !resolved.builder.verifierCapabilityIds.includes(candidate["capabilityId"])
        && candidate["authorityKind"] === "VERIFIER") {
      return refusal("V2_COMPILER_CAPABILITY_UNRESOLVED", "V2_COMPILER_CAPABILITY_BINDING");
    }
    nodes.push(Object.freeze({
      authorityKind: candidate["authorityKind"], budgetIds,
      capabilityBinding, capabilityId: candidate["capabilityId"], criterionIds, dependencyIds,
      nodeId: candidate["nodeId"], resolution: resolved,
    }));
  }
  if (nodes.reduce((count, node) => count + node.dependencyIds.length, 0)
    > ABSOLUTE_MAX_GRAPH_HARD_EDGES) return refusal(
    "V2_COMPILER_GRAPH_LIMIT_EXCEEDED", "V2_COMPILER_TOPOLOGY",
  );
  for (const node of nodes) {
    for (const dependency of node.dependencyIds) {
      if (dependency === node.nodeId) return refusal(
        "V2_COMPILER_DEPENDENCY_SELF", "V2_COMPILER_TOPOLOGY",
      );
      if (!ids.has(dependency)) return refusal(
        "V2_COMPILER_DEPENDENCY_UNKNOWN", "V2_COMPILER_TOPOLOGY",
      );
    }
  }
  return Object.freeze(nodes);
}

function criterionCategories(contract: ProductContractRevisionV2): ReadonlyMap<string, V2CriterionCategory> {
  const result = new Map<string, V2CriterionCategory>();
  const sections: readonly [V2CriterionCategory, readonly { requirementId: string }[]][] = [
    ["DEPLOYMENT", contract.deploymentRequirements],
    ["FUNCTIONAL", contract.functionalRequirements],
    ["NON_FUNCTIONAL", contract.nonFunctionalRequirements],
    ["SECURITY_PRIVACY", contract.securityPrivacyRequirements],
    ["TECHNOLOGY", contract.technologyRequirements],
    ["UX_ACCESSIBILITY", contract.uxAccessibilityRequirements],
  ];
  for (const [category, requirements] of sections) {
    for (const requirement of requirements) result.set(requirement.requirementId, category);
  }
  return new Map(contract.criteria.map((item) => [
    item.criterionId, result.get(item.requirementId)!,
  ]));
}

function dependsOn(nodes: ReadonlyMap<string, NodeFact>, consumer: string, producer: string): boolean {
  const pending = [...(nodes.get(consumer)?.dependencyIds ?? [])]; const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === producer) return true;
    if (seen.has(current)) continue;
    seen.add(current); pending.push(...(nodes.get(current)?.dependencyIds ?? []));
  }
  return false;
}

export function prepareDag(contract: ProductContractRevisionV2, nodeValue: unknown,
  resolutions: ReadonlyMap<string, AdmittedResolution>): PrepareResult {
  const admitted = readNodes(nodeValue, resolutions);
  if ("ok" in admitted) return admitted;
  if (graphIsCyclic(admitted)) return refusal("V2_COMPILER_GRAPH_CYCLE", "V2_COMPILER_TOPOLOGY");
  const byId = new Map(admitted.map((node) => [node.nodeId, node]));
  const budgets = new Map(contract.budgets.map((budget) => [budget.budgetId, budget]));
  if (budgets.size === 0) return refusal("V2_COMPILER_BUDGET_MISSING", "V2_COMPILER_BUDGET");
  const usedBudgets = new Set<string>();
  for (const node of admitted) for (const id of node.budgetIds) {
    if (!budgets.has(id)) return refusal("V2_COMPILER_BUDGET_INVALID", "V2_COMPILER_BUDGET");
    usedBudgets.add(id);
  }
  if (usedBudgets.size !== budgets.size) return refusal(
    "V2_COMPILER_BUDGET_MISSING", "V2_COMPILER_BUDGET",
  );
  const budgetOwners = new Map<string, string>();
  for (const node of admitted) for (const id of node.budgetIds) {
    const owner = budgetOwners.get(id);
    if (owner !== undefined && owner !== node.nodeId) return refusal(
      "V2_COMPILER_BUDGET_SHARED_UNALLOCATED", "V2_COMPILER_BUDGET",
    );
    budgetOwners.set(id, node.nodeId);
  }
  const knownCriteria = new Set(contract.criteria.map((item) => item.criterionId));
  for (const node of admitted) if (node.criterionIds.some((id) => !knownCriteria.has(id))) {
    return refusal("V2_COMPILER_CRITERION_UNKNOWN", "V2_COMPILER_COVERAGE");
  }
  const categories = criterionCategories(contract); const compiledCriteria: V2CompiledCriterionBinding[] = [];
  for (const criterion of contract.criteria) {
    const owners = admitted.filter((node) => node.authorityKind === "BUILDER"
      && node.criterionIds.includes(criterion.criterionId));
    const verifiers = admitted.filter((node) => node.authorityKind === "VERIFIER"
      && node.criterionIds.includes(criterion.criterionId));
    if (owners.length === 0) return refusal("V2_COMPILER_CRITERION_OWNER_MISSING", "V2_COMPILER_COVERAGE");
    if (owners.length !== 1) return refusal("V2_COMPILER_CRITERION_OWNER_MULTIPLE", "V2_COMPILER_COVERAGE");
    if (verifiers.length === 0) return refusal("V2_COMPILER_CRITERION_VERIFIER_MISSING", "V2_COMPILER_COVERAGE");
    if (verifiers.length !== 1) return refusal("V2_COMPILER_CRITERION_VERIFIER_MULTIPLE", "V2_COMPILER_COVERAGE");
    const owner = owners[0]!; const verifier = verifiers[0]!; const category = categories.get(criterion.criterionId)!;
    if (owner.resolution !== verifier.resolution || owner.capabilityId !== owner.resolution.builder.capabilityId
      || !owner.capabilityBinding.criterionCategories.includes(category)
      || !owner.resolution.requiredCriterionCategories.includes(category)
      || !verifier.capabilityBinding.criterionCategories.includes(category)) return refusal(
      "V2_COMPILER_CAPABILITY_UNRESOLVED", "V2_COMPILER_CAPABILITY_BINDING",
    );
    if (!dependsOn(byId, verifier.nodeId, owner.nodeId)) return refusal(
      "V2_COMPILER_VERIFIER_ORDER_INVALID", "V2_COMPILER_COVERAGE",
    );
    compiledCriteria.push(Object.freeze({ category, criterionId: criterion.criterionId,
      ownerNodeId: owner.nodeId, requirementId: criterion.requirementId,
      statement: criterion.statement, verification: criterion.verification,
      verifierNodeId: verifier.nodeId }));
  }
  if (!contractRequirementOrderValid(contract, compiledCriteria, byId)) return refusal(
    "V2_COMPILER_REQUIREMENT_ORDER_INVALID", "V2_COMPILER_TOPOLOGY",
  );
  const usedFacts = [...new Set(admitted.map((node) => node.resolution))];
  if (usedFacts.length !== resolutions.size || materialBindingsConflict(usedFacts)) return refusal(
    "V2_COMPILER_MATERIAL_DIGEST_UNBOUND", "V2_COMPILER_MATERIAL_BINDING",
  );
  return Object.freeze({ facts: admitted, ok: true as const,
    prepared: assemblePreparedDag(admitted, budgets, compiledCriteria, usedFacts) });
}

export { resolutionKey };
