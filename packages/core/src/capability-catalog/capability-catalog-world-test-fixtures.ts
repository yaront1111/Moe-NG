import { createCapabilityCatalogRevision } from "./capability-catalog-codec.js";
import {
  ALL_CATEGORIES,
  ALL_ROLES,
  VERIFIER_ROLES,
  createDeliveryProfile,
  createExecutionProfile,
  createQualification,
  createVerificationRecipe,
  durableQualificationAuthority,
  hex,
} from "./capability-catalog-resolution-test-fixtures.js";

interface ReferencedRevision {
  readonly revisionDigest: string;
  readonly revisionId: string;
}
interface ProfileRevision extends ReferencedRevision {
  readonly profileFamilyId: string;
  readonly resourceClasses: readonly string[];
  readonly secretSchema: readonly Readonly<{ secretId: string }>[];
}
interface ExecutionRevision extends ReferencedRevision {
  readonly network: Readonly<{ plane: string }>;
}
interface RecipeRevision extends ReferencedRevision {
  readonly image: Readonly<{ imageDigest: string }>;
  readonly tool: Readonly<{ toolDigest: string }>;
}
export interface CatalogEntryBindingFixture {
  readonly execution: ExecutionRevision;
  readonly recipes: readonly RecipeRevision[];
}
export interface CatalogVerifierBindingFixture extends CatalogEntryBindingFixture {
  readonly capabilityId: string;
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const uniqueSorted = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort());

export function catalogEntry(
  profile: ProfileRevision,
  binding: CatalogEntryBindingFixture,
  capabilityId: string,
  authorityKind: "BUILDER" | "VERIFIER",
  verifierCapabilityIds: readonly string[] = [],
): Record<string, unknown> {
  const resourceClass = profile.resourceClasses[0]!;
  const secretId = profile.secretSchema[0]!.secretId;
  return {
    authorityKind,
    capabilityId,
    criterionCategories: [...ALL_CATEGORIES],
    deliveryProfileFamilyId: profile.profileFamilyId,
    deliveryProfileRevisionDigest: profile.revisionDigest,
    deliveryProfileRevisionId: profile.revisionId,
    executionIsolationProfileRevisionDigest: binding.execution.revisionDigest,
    executionIsolationProfileRevisionId: binding.execution.revisionId,
    readScopes: ["packages/core/src"],
    requiredImageDigests: uniqueSorted(
      binding.recipes.map((recipe) => recipe.image.imageDigest),
    ),
    requiredToolDigests: uniqueSorted(
      binding.recipes.map((recipe) => recipe.tool.toolDigest),
    ),
    resourceScopes: [
      { kind: "EVIDENCE_CLASS", ref: "EVIDENCE" },
      { kind: "NETWORK_PLANE", ref: binding.execution.network.plane },
      { kind: "RESOURCE_CLASS", ref: resourceClass },
      { kind: "SECRET_SCHEMA", ref: secretId },
    ],
    roles: authorityKind === "BUILDER" ? [...ALL_ROLES] : [...VERIFIER_ROLES],
    verificationRecipeRevisions: binding.recipes.map((recipe) => ({
      recipeRevisionDigest: recipe.revisionDigest,
      recipeRevisionId: recipe.revisionId,
    })).sort((left, right) => compareCodeUnits(
      left.recipeRevisionId, right.recipeRevisionId,
    )),
    verifierCapabilityIds: [...verifierCapabilityIds],
    writeScopes: authorityKind === "BUILDER" ? ["packages/core/generated"] : [],
  };
}

export function catalogDraft(
  profile: ProfileRevision,
  builder: CatalogEntryBindingFixture,
  verifiers: readonly CatalogVerifierBindingFixture[],
  builderPatch: Record<string, unknown> = {},
  verifierPatch: Record<string, unknown> = {},
): Record<string, unknown> {
  const verifierIds = verifiers.map((item) => item.capabilityId).sort();
  const entries = [
    { ...catalogEntry(
      profile, builder, "capability-web-build", "BUILDER", verifierIds,
    ), ...builderPatch },
    ...verifiers.map((verifier) => ({ ...catalogEntry(
      profile, verifier, verifier.capabilityId, "VERIFIER",
    ), ...verifierPatch })),
  ].sort((left, right) => compareCodeUnits(
    String(left.capabilityId), String(right.capabilityId),
  ));
  return {
    catalogId: "catalog-default",
    entries,
    lineage: null,
    revisionId: "catalog-revision-1",
    sourceCommitSha256: hex("1"),
  };
}

export interface CapabilityCatalogWorldOptions {
  readonly builderPatch?: Record<string, unknown>;
  readonly executionPatch?: Record<string, unknown>;
  readonly qualificationPatch?: Record<string, unknown>;
  readonly receiptVerifierCapabilityIds?: readonly string[];
  readonly recipePatch?: Record<string, unknown>;
  readonly verifierCapabilityIds?: readonly string[];
  readonly verifierExecutionPatch?: Record<string, unknown>;
  readonly verifierPatch?: Record<string, unknown>;
  readonly verifierRecipePatch?: Record<string, unknown>;
}

export function createWorld(options: CapabilityCatalogWorldOptions = {}) {
  const profile = createDeliveryProfile();
  const verifierIds = options.verifierCapabilityIds ?? ["capability-web-verify"];
  const qualification = createQualification(
    profile, options.qualificationPatch,
    options.receiptVerifierCapabilityIds ?? verifierIds,
  );
  const builderExecution = createExecutionProfile(
    profile.revisionDigest, options.executionPatch, "BUILD_AGENT",
  );
  const verifierExecution = createExecutionProfile(
    profile.revisionDigest, options.verifierExecutionPatch, "FRESH_VERIFIER",
  );
  const builderRecipes = [createVerificationRecipe(builderExecution, {
    recipeId: "verify-builder", revisionId: "verify-builder-r1", ...options.recipePatch,
  })];
  const verifierRecipes = [createVerificationRecipe(verifierExecution, {
    recipeId: "verify-verifier", revisionId: "verify-verifier-r1",
    ...options.verifierRecipePatch,
  })];
  const builderBinding = { execution: builderExecution, recipes: builderRecipes };
  const verifierBindings = verifierIds.map((capabilityId) => ({
    capabilityId, execution: verifierExecution, recipes: verifierRecipes,
  }));
  const created = createCapabilityCatalogRevision(catalogDraft(
    profile, builderBinding, verifierBindings,
    options.builderPatch, options.verifierPatch,
  ));
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  const entryMaterials = [
    { capabilityId: "capability-web-build",
      executionIsolationProfileRevision: builderExecution,
      verificationRecipeRevisions: Object.freeze(builderRecipes) },
    ...verifierBindings.map((binding) => ({ capabilityId: binding.capabilityId,
      executionIsolationProfileRevision: verifierExecution,
      verificationRecipeRevisions: Object.freeze(verifierRecipes) })),
  ].sort((left, right) => compareCodeUnits(left.capabilityId, right.capabilityId));
  return Object.freeze({
    authority: durableQualificationAuthority(),
    builderExecutionIsolationProfileRevision: builderExecution,
    builderVerificationRecipeRevisions: Object.freeze(builderRecipes),
    catalog: created.revision,
    materials: Object.freeze({
      deliveryProfileQualification: qualification,
      deliveryProfileRevision: profile,
      entryMaterials: Object.freeze(entryMaterials),
    }),
    request: Object.freeze({
      atEpochMs: 1_500,
      capabilityId: "capability-web-build",
      requiredCriterionCategories: Object.freeze(["FUNCTIONAL", "SECURITY_PRIVACY"]),
    }),
    verifierExecutionIsolationProfileRevision: verifierExecution,
    verifierVerificationRecipeRevisions: Object.freeze(verifierRecipes),
  });
}
