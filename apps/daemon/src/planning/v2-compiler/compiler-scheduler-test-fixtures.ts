import { createHash } from "node:crypto";

import { createAcceptanceContract, createPlanRevision } from "@moe/core";
import { createNodeDefinition, type NodeAuthorityEdgeInput,
  type NodeDefinition } from "@moe/scheduler";

import type {
  V2CompilerGraphAuthority, V2CompilerGraphAuthorityRequest,
  V2CompilerNodeAdmissionAuthority, V2CompilerNodeAdmissionRequest,
  V2CompilerNodeAuthorityRequest, V2SchedulerDependency,
} from "./authority-contracts.js";

const digest = (label: string): string => createHash("sha256").update(label).digest("hex");
export const TEST_REPOSITORY_BASE_TREE = digest("repository-base-tree");

export function compilerGraphAuthority(
  _request: V2CompilerGraphAuthorityRequest,
): V2CompilerGraphAuthority {
  return Object.freeze({ author: "principal:v2-compiler-test", decompositionBudget: 64,
    parentRevision: null, policyRevision: digest("policy:v2-compiler-test"),
    repositoryBaseTree: TEST_REPOSITORY_BASE_TREE });
}

export function compilerNodeAdmissionAuthority(
  request: V2CompilerNodeAdmissionRequest,
): V2CompilerNodeAdmissionAuthority {
  return Object.freeze({ admissionAmounts: Object.freeze([{ meter: "attempt.count" as const,
    purpose: request.authorityKind === "BUILDER" ? "EXECUTION" as const : "VERIFICATION" as const,
    quantity: 1 }]), admissionGatePolicy: "POLICY_ALLOWANCE",
    budgetBindingDigest: request.budgetBindingDigest });
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
