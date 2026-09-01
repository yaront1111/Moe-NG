import { createHash } from "node:crypto";

import {
  createAcceptanceContract, createPlanRevision, createSourceSnapshot,
  type SourceSnapshot, type SourceSnapshotRef,
} from "@moe/core";
import { ADMISSION_PURPOSES, createNodeDefinition, type NodeAuthorityEdgeInput,
  type NodeDefinition } from "@moe/scheduler";

import type { DeliveryV2SourceSnapshotReadResult } from
  "../../delivery-v2/source-snapshot-reader.js";

import type {
  V2CompilerGraphAuthority, V2CompilerGraphAuthorityRequest,
  V2CompilerNodeAdmissionAuthority, V2CompilerNodeAdmissionRequest,
  V2CompilerNodeAuthorityRequest, V2SchedulerDependency,
} from "./authority-contracts.js";
import { createPlannerAdmissionProfileRevision } from "./planner-admission-profile-codec.js";
import type { PlannerAdmissionProfileRevision } from
  "./planner-admission-profile-contract.js";
import { mapPlannerAdmissionProfileRevision } from "./planner-admission-profile-mapping.js";

const digest = (label: string): string => createHash("sha256").update(label).digest("hex");
export const TEST_REPOSITORY_BASE_TREE = digest("repository-base-tree");
export const TEST_PROJECT_ID = "project-v2-compiler-test";

export function compilerSourceSnapshot(
  label = "default",
  binding: Readonly<{
    projectId?: string;
    repositoryBaseTree?: string;
  }> = {},
): SourceSnapshot {
  const created = createSourceSnapshot({
    baseRevisionHash: digest(`source-base:${label}`),
    projectId: binding.projectId ?? TEST_PROJECT_ID,
    repositoryBaseTree: binding.repositoryBaseTree ?? TEST_REPOSITORY_BASE_TREE,
    repositoryRef: "refs/heads/main",
    scopeRef: `scope:compiler-test:${label}`,
  });
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.snapshot;
}

export const TEST_SOURCE_SNAPSHOT = compilerSourceSnapshot();

export function compilerPublishedSourceSnapshot(
  ref: SourceSnapshotRef,
): DeliveryV2SourceSnapshotReadResult {
  return ref.projectId === TEST_SOURCE_SNAPSHOT.projectId
    && ref.sourceSnapshotDigest === TEST_SOURCE_SNAPSHOT.sourceSnapshotDigest
    ? Object.freeze({ ok: true as const, snapshot: TEST_SOURCE_SNAPSHOT })
    : Object.freeze({
      code: "DELIVERY_V2_MATERIAL_ABSENT" as const,
      layer: "DAEMON_DELIVERY_V2_READER" as const,
      ok: false as const,
    });
}

export function compilerGraphAuthority(
  _request: V2CompilerGraphAuthorityRequest,
): V2CompilerGraphAuthority {
  return Object.freeze({ author: "principal:v2-compiler-test", decompositionBudget: 64,
    parentRevision: null, policyRevision: digest("policy:v2-compiler-test"),
    repositoryBaseTree: TEST_REPOSITORY_BASE_TREE });
}

export function compilerNodeAdmissionAuthority(
  request: V2CompilerNodeAdmissionRequest,
  identity: Readonly<{ profileId?: string; revisionId?: string }> = {},
): V2CompilerNodeAdmissionAuthority {
  const revision = compilerPlannerAdmissionProfileRevision(request, identity);
  const mapped = mapPlannerAdmissionProfileRevision(revision, request);
  if (!mapped.ok) throw new Error(`${mapped.code}@${mapped.layer}`);
  return mapped;
}

export function compilerPlannerAdmissionProfileRevision(
  request: V2CompilerNodeAdmissionRequest,
  identity: Readonly<{ profileId?: string; revisionId?: string }> = {},
): PlannerAdmissionProfileRevision {
  const purposeQuantities = [...ADMISSION_PURPOSES].sort().map((purpose) => ({
    purpose, quantity: 1,
  }));
  const created = createPlannerAdmissionProfileRevision({
    admissionGatePolicy: "POLICY_ALLOWANCE",
    allocationDecisionRef: `allocation-decision:${request.nodeKey}`,
    allocationSemantics: "SINGLE_ADMISSION_FULL_ENVELOPE",
    authorRef: "principal:v2-compiler-planner-admission-test",
    authorityKind: request.authorityKind,
    budgetAllocations: request.budgetBindings.map((budget) => ({
      conversion: {
        authorityRef: `conversion:${request.nodeKey}:${budget.budgetId}`,
        denominator: budget.limit,
        numerator: purposeQuantities.length,
        targetMeter: budget.kind === "TIME"
          ? request.authorityKind === "BUILDER"
            ? "runner.authorized_ms"
            : "verification.authorized_ms"
          : "attempt.count",
      },
      purposeQuantities,
      sourceBudget: budget,
    })),
    budgetBindingDigest: request.budgetBindingDigest,
    contractBinding: request.contractBinding,
    graphId: request.graphId,
    graphSnapshotIdentity: request.graphSnapshotIdentity,
    nodeIntentDigest: request.nodeIntentDigest,
    nodeKey: request.nodeKey,
    policyRevision: request.policyRevision,
    profileId: identity.profileId ?? `planner-admission-profile:${request.nodeKey}`,
    revisionId: identity.revisionId ?? `planner-admission-profile:${request.nodeKey}:r1`,
  });
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.revision;
}

function dependencyContract(edge: V2SchedulerDependency, graphBindingDigest: string) {
  const suffix = digest(edge.edgeKey).slice(0, 16);
  const predicateRef = `predicate-${suffix}`;
  return {
    alternateProducers: [] as string[],
    alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
    consumer: { contractHash: digest(`consumer-${suffix}`),
      criterionRef: `criterion-${suffix}`, kind: "PRECONDITION" },
    consumerNodeKey: edge.consumerNodeKey,
    consumptionHorizon: "RESULT_SEAL",
    edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest,
    invalidationFacts: [{ sourceFactDigest: digest(`fact-${suffix}`),
      sourceFactRef: `fact-${suffix}`, sourceFactVersion: 1 }],
    minimumQualifyingMilestone: "RESULT_SEALED",
    necessity: { failedConsumerCriterionRef: `criterion-${suffix}`,
      failureKind: "MISSING_ARTIFACT", truthClass: "OBSERVED" },
    producer: { artifactOrInterfaceRef: `artifact-${suffix}`,
      digest: digest(`artifact-${suffix}`), kind: "ARTIFACT_CONSUMPTION" },
    producerNodeKey: edge.producerNodeKey,
    recheckPredicateRef: predicateRef,
    satisfactionPredicate: { parametersDigest: digest(`parameters-${suffix}`),
      predicateRef, schemaId: `schema-${suffix}`, schemaVersion: 1 },
    satisfactionWitnesses: [{ sourceOperationClass: "ARTIFACT_SEAL",
      witnessDigest: digest(`witness-${suffix}`), witnessRef: `witness-${suffix}`,
      witnessVersion: 1 }],
    stability: "MONOTONIC",
    truthClass: "OBSERVED",
  };
}

function planning(request: V2CompilerNodeAuthorityRequest) {
  const graphContentHash = digest(`planning-graph:${request.graphId}`);
  const criterionIds = request.criterionBindings.map((item) => item.criterionId);
  const plan = createPlanRevision({ affectedCriterionIds: criterionIds,
    affectedNodeIds: [request.nodeKey], approvalState: "APPROVED",
    authorRef: "principal:v2-compiler-test",
    graphBinding: { graphContentHash, graphRevisionRef: `graph:${request.graphId}` },
    parentRevisionId: null, rejectionRef: null,
    revisionId: `plan:${digest(request.nodeKey).slice(0, 20)}`,
    steps: [{ description: `Execute ${request.nodeKey}.`, kind: "IMPLEMENTATION",
      stepId: `step:${digest(request.nodeKey).slice(0, 20)}` }],
    verificationRecipeRefs: request.verificationRecipeRevisions });
  const acceptance = createAcceptanceContract({
    applicability: { graphContentHash, graphRevisionRef: `graph:${request.graphId}`,
      nodeIds: [request.nodeKey], nodeKind: request.joinRole === "COMPLETION"
        ? "COMPOSITE_COMPLETION" : "LEAF" },
    authorRef: "principal:v2-compiler-test",
    contractId: `acceptance:${digest(request.nodeKey).slice(0, 20)}`,
    obligations: criterionIds.map((criterionId) => ({ criterionId,
      evidenceRequirements: [{ evidenceRef: `evidence:${digest(criterionId).slice(0, 20)}`,
        kind: "ARTIFACT" as const,
        requirementId: `requirement:${digest(criterionId).slice(0, 20)}` }],
      statement: `${criterionId} is independently evidenced.`,
      verificationRecipeRefs: request.verificationRecipeRevisions })),
  });
  if (!plan.ok || !acceptance.ok) throw new Error("test planning authority refused");
  return { acceptance: acceptance.contract, plan: plan.revision };
}

export function compilerNodeDefinition(request: V2CompilerNodeAuthorityRequest): NodeDefinition {
  const { acceptance, plan } = planning(request);
  const directHardDependencies: NodeAuthorityEdgeInput[] =
    request.directHardDependencies.map((edge) => ({ edgeKey: edge.edgeKey,
      requirement: { contract: dependencyContract(edge, request.snapshotIdentity),
        edgeKind: "ARTIFACT_CONSUMPTION" } }));
  const predicateRegistry = request.directHardDependencies.map((edge) => {
    const suffix = digest(edge.edgeKey).slice(0, 16);
    return { parameterSchema: { digest: digest(`schema-${suffix}`), kind: "JSON_SCHEMA" },
      predicateRef: `predicate-${suffix}`,
      proofRationale: "An artifact seal is monotonic for this dependency.",
      schemaId: `schema-${suffix}`, schemaVersion: 1,
      sourceOperationClass: "ARTIFACT_SEAL" };
  });
  const created = createNodeDefinition({ acceptanceContract: acceptance,
    draft: { admissionAmounts: request.admissionAmounts,
    admissionGatePolicy: request.admissionGatePolicy, capability: request.capability,
    completionLinkage: request.completionLinkage,
    constraints: request.constraints,
    directHardDependencies, joinRole: request.joinRole, nodeKey: request.nodeKey,
    objective: request.objective, policySliceHash: request.policySliceHash,
    readScopes: request.readScopes, repositoryBaseTree: request.repositoryBaseTree,
    resources: request.resources,
    verificationRecipeRevisions: request.verificationRecipeRevisions,
    writeScopes: request.writeScopes }, planRevision: plan, predicateRegistry });
  if (!created.ok) throw new Error(created.issues.map(
    (issue) => `${issue.code}@${issue.layer}`).join(","));
  return created.value.definition;
}
