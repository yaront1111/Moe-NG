import { createHash } from "node:crypto";

import type { V2CompiledCriterionBinding, V2CompiledNode } from "./contracts.js";
import {
  V2_COMPILER_NODE_INTENT_DIGEST_DOMAIN, type V2CompilerNodeIntent,
} from "./contracts.js";
import { qualifiedIdentity } from "./material-identity.js";
import type { NodeFact } from "./topology.js";
import type {
  V2CompilerGraphAuthorityRequest, V2CompilerNodeAdmissionRequest,
} from "./authority-contracts.js";

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const encoder = new TextEncoder();

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(source).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(source[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("v2 compiler node intent digest received unadmitted data");
}

function normalizedNodeIntent(node: NodeFact): V2CompilerNodeIntent {
  return Object.freeze({
    authorityKind: node.authorityKind,
    budgetRefs: Object.freeze(node.budgetIds.slice().sort(compare)
      .map((budgetId) => Object.freeze({ budgetId }))),
    capabilityId: node.capabilityId,
    criterionRefs: Object.freeze(node.criterionIds.slice().sort(compare)
      .map((criterionId) => Object.freeze({ criterionId }))),
    dependsOn: Object.freeze(node.dependencyIds.slice().sort(compare)
      .map((nodeId) => Object.freeze({ nodeId }))),
    nodeId: node.nodeId,
    resolutionRef: Object.freeze({
      builderCapabilityId: node.resolution.builder.capabilityId,
      catalogRevisionDigest: node.resolution.catalogRevisionDigest,
    }),
  });
}

export function nodeIntentDigest(node: NodeFact): string {
  return createHash("sha256").update(V2_COMPILER_NODE_INTENT_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0)).update(encoder.encode(canonicalText(normalizedNodeIntent(node))))
    .digest("hex");
}

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
  graphSnapshotIdentity: string, policyRevision: string): V2CompilerNodeAdmissionRequest {
  return Object.freeze({ authorityKind: node.authorityKind,
    budgetBindingDigest: budgetBindingDigest(compiled),
    budgetBindings: compiled.budgetBindings, contractBinding, graphId,
    graphSnapshotIdentity, nodeIntentDigest: nodeIntentDigest(node),
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
