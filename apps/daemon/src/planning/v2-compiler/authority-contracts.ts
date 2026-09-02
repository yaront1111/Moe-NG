import type { SourceSnapshotRef } from "@moe/core";
import type { NodeDefinition, NodePlanningSourceContent } from "@moe/scheduler";

import type {
  V2CompiledCriterionBinding, V2CompiledNode, V2NodeAuthorityKind,
} from "./contracts.js";
import type {
  PlannerAdmissionProfileAuthoritySuccess,
  PlannerAdmissionProfileMappingExpectation,
} from "./planner-admission-profile-contract.js";

export interface V2SchedulerDependency {
  readonly consumerNodeKey: string;
  readonly edgeKey: string;
  readonly producerNodeKey: string;
}

export interface V2CompilerGraphAuthorityRequest {
  readonly contractBinding: Readonly<{
    contractId: string; revisionDigest: string; revisionId: string;
  }>;
  readonly graphId: string;
  readonly projectId: string;
  readonly snapshot: Readonly<{
    completionNodeKey: string;
    edges: readonly Readonly<{
      consumerNodeKey: string; edgeKey: string; kind: "HARD"; producerNodeKey: string;
    }>[];
    nodes: readonly Readonly<{ executionBearing: true; nodeKey: string }>[];
  }>;
}

/** Durable graph-author fields are supplied only by the server composition root. */
export interface V2CompilerGraphAuthority {
  readonly author: string;
  readonly decompositionBudget: number;
  readonly parentRevision: string | null;
  readonly policyRevision: string;
  readonly repositoryBaseTree: string;
}

export interface V2CompilerNodeAuthorityRequest {
  readonly admissionAmounts: NodeDefinition["admissionAmounts"];
  readonly admissionGatePolicy: NodeDefinition["admissionGatePolicy"];
  readonly authorityKind: V2NodeAuthorityKind;
  readonly budgetBindings: V2CompiledNode["budgetBindings"];
  readonly capability: string;
  readonly completionLinkage: string | null;
  readonly constraints: NodeDefinition["constraints"];
  readonly contractBinding: V2CompilerGraphAuthorityRequest["contractBinding"];
  readonly contractRequirementIds: readonly string[];
  readonly criterionBindings: readonly V2CompiledCriterionBinding[];
  readonly directHardDependencies: readonly V2SchedulerDependency[];
  readonly graphId: string;
  readonly joinRole: "COMPLETION" | "NONE";
  readonly nodeKey: string;
  readonly objective: string;
  readonly policySliceHash: string;
  readonly readScopes: readonly string[];
  readonly repositoryBaseTree: string;
  readonly requiredImageDigests: readonly string[];
  readonly requiredToolDigests: readonly string[];
  readonly resources: readonly string[];
  readonly roles: readonly string[];
  readonly snapshotIdentity: string;
  readonly verificationRecipeRevisions: readonly string[];
  readonly writeScopes: readonly string[];
}

export type V2CompilerNodeAdmissionRequest = PlannerAdmissionProfileMappingExpectation;
export type V2CompilerNodeAdmissionAuthority = PlannerAdmissionProfileAuthoritySuccess;

/** Source-owned planning/dependency material; all other draft fields and identities are derived. */
export type V2CompilerNodePlanningAuthority = Omit<NodePlanningSourceContent, "version">;

export type V2CompilerGraphAuthorityReader =
  (request: V2CompilerGraphAuthorityRequest) => unknown;
export type V2CompilerNodePlanningAuthorityReader =
  (request: V2CompilerNodeAuthorityRequest) => V2CompilerNodePlanningAuthority | unknown;
export type V2CompilerNodeAdmissionAuthorityReader =
  (request: V2CompilerNodeAdmissionRequest) => unknown;
/** Server composition must bind this port to readDeliveryV2PublishedSourceSnapshot. */
export type V2CompilerPublishedSourceSnapshotReader =
  (ref: SourceSnapshotRef) => unknown;
