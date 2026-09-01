import type { ProductContractRevisionV2 } from "@moe/core";
import type { GraphContent, GraphRevisionContent } from "@moe/scheduler";

export const V2_COMPILED_DAG_VERSION = "moe-compiled-dag/2" as const;
export const V2_COMPILED_DAG_DIGEST_DOMAIN = "moe-compiled-dag-digest/2" as const;
export const V2_COMPILER_CODES = Object.freeze([
  "V2_COMPILER_INPUT_MALFORMED",
  "V2_COMPILER_CONTRACT_INVALID",
  "V2_COMPILER_GRAPH_EMPTY",
  "V2_COMPILER_GRAPH_LIMIT_EXCEEDED",
  "V2_COMPILER_NODE_DUPLICATE",
  "V2_COMPILER_DEPENDENCY_DUPLICATE",
  "V2_COMPILER_DEPENDENCY_UNKNOWN",
  "V2_COMPILER_DEPENDENCY_SELF",
  "V2_COMPILER_GRAPH_CYCLE",
  "V2_COMPILER_COMPLETION_NODE_INVALID",
  "V2_COMPILER_COMPLETION_CLOSURE_INCOMPLETE",
  "V2_COMPILER_REQUIREMENT_ORDER_INVALID",
  "V2_COMPILER_BUDGET_MISSING",
  "V2_COMPILER_BUDGET_INVALID",
  "V2_COMPILER_BUDGET_SHARED_UNALLOCATED",
  "V2_COMPILER_CRITERION_UNKNOWN",
  "V2_COMPILER_CRITERION_OWNER_MISSING",
  "V2_COMPILER_CRITERION_OWNER_MULTIPLE",
  "V2_COMPILER_CRITERION_VERIFIER_MISSING",
  "V2_COMPILER_CRITERION_VERIFIER_MULTIPLE",
  "V2_COMPILER_VERIFIER_ORDER_INVALID",
  "V2_COMPILER_CAPABILITY_UNRESOLVED",
  "V2_COMPILER_IDENTITY_COLLISION",
  "V2_COMPILER_DELIVERY_PROFILE_UNQUALIFIED",
  "V2_COMPILER_BUILD_RECIPE_MISSING",
  "V2_COMPILER_VERIFICATION_RECIPE_MISSING",
  "V2_COMPILER_MATERIAL_DIGEST_UNBOUND",
  "V2_COMPILER_GRAPH_AUTHORITY_UNAVAILABLE",
  "V2_COMPILER_NODE_AUTHORITY_INVALID",
  "V2_COMPILER_SCHEDULER_GRAPH_INVALID",
  "V2_COMPILER_QUALIFICATION_FENCE_LIMIT_EXCEEDED",
  "V2_COMPILER_QUALIFICATION_AUTHORITY_MISMATCH",
] as const);
export const V2_COMPILER_LAYERS = Object.freeze([
  "V2_COMPILER_INPUT",
  "V2_COMPILER_CONTRACT",
  "V2_COMPILER_TOPOLOGY",
  "V2_COMPILER_BUDGET",
  "V2_COMPILER_COVERAGE",
  "V2_COMPILER_CAPABILITY_BINDING",
  "V2_COMPILER_RECIPE_BINDING",
  "V2_COMPILER_MATERIAL_BINDING",
  "V2_COMPILER_SCHEDULER_AUTHORITY",
] as const);

export type V2CompilerCode = (typeof V2_COMPILER_CODES)[number];
export type V2CompilerLayer = (typeof V2_COMPILER_LAYERS)[number];
export type V2NodeAuthorityKind = "BUILDER" | "VERIFIER";
export type V2CriterionCategory =
  | "DEPLOYMENT" | "FUNCTIONAL" | "NON_FUNCTIONAL"
  | "SECURITY_PRIVACY" | "TECHNOLOGY" | "UX_ACCESSIBILITY";

export interface V2CompilerNodeIntent {
  readonly authorityKind: V2NodeAuthorityKind;
  readonly budgetRefs: readonly Readonly<{ budgetId: string }>[];
  readonly capabilityId: string;
  readonly criterionRefs: readonly Readonly<{ criterionId: string }>[];
  readonly dependsOn: readonly Readonly<{ nodeId: string }>[];
  readonly nodeId: string;
  readonly resolutionRef: Readonly<{
    builderCapabilityId: string;
    catalogRevisionDigest: string;
  }>;
}

export interface V2CompilerInput {
  readonly completionNodeKey: string;
  readonly contract: ProductContractRevisionV2;
  readonly graphId: string;
  readonly nodes: readonly V2CompilerNodeIntent[];
}

export interface V2CompiledRecipeBinding {
  readonly argv: readonly string[];
  readonly recipeDigest: string;
  readonly recipeRef: string;
  readonly toolRef: string;
}

export interface V2CompiledVerificationRecipeBinding {
  readonly recipeId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

export interface V2CompiledNode {
  readonly authorityKind: V2NodeAuthorityKind;
  readonly budgetBindings: readonly Readonly<{
    budgetId: string; kind: string; limit: number; unit: string;
  }>[];
  readonly buildRecipe: V2CompiledRecipeBinding | null;
  readonly capabilityId: string;
  readonly criterionRefs: readonly Readonly<{ criterionId: string }>[];
  readonly dependsOn: readonly Readonly<{ nodeId: string }>[];
  readonly materialBinding: Readonly<{
    catalogRevisionDigest: string;
    deliveryProfileQualificationDigest: string;
    deliveryProfileQualificationStatusDigest: string;
    deliveryProfileRevisionDigest: string;
    executionIsolationProfileRevisionDigest: string;
    sourceSnapshotDigest: string;
  }>;
  readonly nodeId: string;
  readonly verificationRecipes: readonly V2CompiledVerificationRecipeBinding[];
}

export interface V2CompiledCriterionBinding {
  readonly category: V2CriterionCategory;
  readonly criterionId: string;
  readonly ownerNodeId: string;
  readonly requirementId: string;
  readonly statement: string;
  readonly verification: string;
  readonly verifierNodeId: string;
}

export interface V2CompiledMaterialDigest {
  readonly digest: string;
  readonly kind: "BUILD_RECIPE" | "CAPABILITY_CATALOG" | "DELIVERY_PROFILE"
    | "DELIVERY_PROFILE_QUALIFICATION" | "DELIVERY_PROFILE_QUALIFICATION_STATUS"
    | "EXECUTION_ISOLATION_PROFILE"
    | "SOURCE_SNAPSHOT" | "VERIFICATION_RECIPE";
  readonly ref: string;
}

export interface V2CompiledDag {
  readonly contractBinding: Readonly<{
    contractId: string; revisionDigest: string; revisionId: string;
  }>;
  readonly criteria: readonly V2CompiledCriterionBinding[];
  readonly graphDigest: string;
  readonly graphId: string;
  readonly materialDigests: readonly V2CompiledMaterialDigest[];
  readonly nodes: readonly V2CompiledNode[];
  readonly qualificationFences: readonly Readonly<{
    qualificationDigest: string;
    qualificationId: string;
    statusDigest: string;
    statusRef: string;
  }>[];
  readonly schedulerAuthority: Readonly<{
    canonicalBytesBase64: string;
    content: GraphRevisionContent;
    graphContentHash: string;
    schemaVersion: GraphContent["schemaVersion"];
    snapshotIdentity: string;
  }>;
  readonly version: typeof V2_COMPILED_DAG_VERSION;
}

export interface V2CompilerRefusal {
  readonly code: V2CompilerCode;
  readonly layer: V2CompilerLayer;
  readonly ok: false;
}

export type V2CompileResult = Readonly<{
  canonicalBytesBase64: string;
  dag: V2CompiledDag;
  graphDigest: string;
  ok: true;
}> | V2CompilerRefusal;

export function v2CompilerRefusal(
  code: V2CompilerCode,
  layer: V2CompilerLayer,
): V2CompilerRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}
