import type { V2CompiledCriterionBinding, V2CompiledNode } from "./contracts.js";
import { qualifiedIdentity } from "./material-identity.js";
import type { NodeFact } from "./topology.js";
import type {
  V2CompilerGraphAuthorityRequest, V2CompilerNodeAdmissionRequest,
} from "./authority-contracts.js";

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function budgetParts(node: V2CompiledNode): string[] {
  return node.budgetBindings.flatMap((budget) => [
    budget.budgetId, budget.kind, String(budget.limit), budget.unit,
  ]);
}

export function budgetBindingDigest(node: V2CompiledNode): string {
  return qualifiedIdentity("budget-bindings", [node.nodeId, ...budgetParts(node)]);
}

export function nodeAdmissionRequest(node: NodeFact, compiled: V2CompiledNode,
  graphId: string, contractBinding: V2CompilerGraphAuthorityRequest["contractBinding"],
  policyRevision: string): V2CompilerNodeAdmissionRequest {
  return Object.freeze({ authorityKind: node.authorityKind,
    budgetBindingDigest: budgetBindingDigest(compiled),
    budgetBindings: compiled.budgetBindings, contractBinding, graphId,
    nodeKey: node.nodeId, policyRevision });
}

/** Exact compiler-owned intent projection; opaque hashes keep Scheduler lists bounded. */
export function nodeIntentAuthority(node: NodeFact, compiled: V2CompiledNode,
  criteria: readonly V2CompiledCriterionBinding[], graphId: string,
  contractBinding: V2CompilerGraphAuthorityRequest["contractBinding"]) {
  const relevant = criteria.filter((criterion) => node.authorityKind === "BUILDER"
    ? criterion.ownerNodeId === node.nodeId : criterion.verifierNodeId === node.nodeId)
    .sort((left, right) => compare(left.criterionId, right.criterionId));
  const criterionParts = relevant.flatMap((criterion) => [criterion.category,
    criterion.criterionId, criterion.requirementId, criterion.statement, criterion.verification]);
  const material = compiled.materialBinding;
  const constraints = Object.freeze([
    qualifiedIdentity("contract-constraint", [contractBinding.contractId,
      contractBinding.revisionId, contractBinding.revisionDigest]),
    qualifiedIdentity("budget-constraint", budgetParts(compiled)),
    qualifiedIdentity("criteria-constraint", criterionParts),
    qualifiedIdentity("node-intent-constraint", [graphId, node.nodeId, node.authorityKind,
      node.capabilityId, ...node.dependencyIds.slice().sort(compare),
      material.catalogRevisionDigest, material.deliveryProfileQualificationDigest,
      material.deliveryProfileQualificationStatusDigest, material.deliveryProfileRevisionDigest,
      material.executionIsolationProfileRevisionDigest, material.sourceSnapshotDigest]),
  ].sort(compare));
  return Object.freeze({ constraints,
    objective: `Execute ${node.authorityKind.toLowerCase()} ${node.nodeId} for `
      + `${contractBinding.contractId}@${contractBinding.revisionId}.` });
}
