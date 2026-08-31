import { admitVerificationRecipeForExecutionProfile } from
  "../execution-profile/verification-recipe-codec.js";
import type {
  CapabilityCatalogEntry,
  CapabilityCatalogResourceScope,
} from "./capability-catalog-contract.js";
import type {
  CapabilityCatalogEntryResolutionMaterials,
  CapabilityCatalogResolutionMaterials,
  CapabilityCatalogResolutionRequest,
} from "./capability-catalog-resolution-contract.js";

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sortedUnique = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort();

function scopeClaimMatches(
  scope: CapabilityCatalogResourceScope,
  entryMaterials: CapabilityCatalogEntryResolutionMaterials,
  materials: CapabilityCatalogResolutionMaterials,
): boolean {
  const profile = materials.deliveryProfileRevision;
  const execution = entryMaterials.executionIsolationProfileRevision;
  if (scope.kind === "NETWORK_PLANE") return scope.ref === execution.network.plane;
  if (scope.kind === "RESOURCE_CLASS") return profile.resourceClasses.some(
    (resourceClass) => resourceClass === scope.ref,
  );
  if (scope.kind === "SECRET_SCHEMA") return profile.secretSchema.some(
    (secret) => secret.secretId === scope.ref,
  );
  return scope.ref === "EVIDENCE" && entryMaterials.verificationRecipeRevisions.some(
    (recipe) => recipe.expectedOutputs.some((output) => output.mount === "EVIDENCE"),
  );
}

function pathScopesMatch(
  entry: CapabilityCatalogEntry,
  entryMaterials: CapabilityCatalogEntryResolutionMaterials,
): boolean {
  const mounts = entryMaterials.executionIsolationProfileRevision.mounts;
  const sourceReadable = mounts.some(
    (mount) => mount.kind === "SOURCE_SNAPSHOT" && mount.access === "READ_ONLY",
  );
  const repositoryOutputWritable = mounts.some((mount) =>
    (mount.kind === "OUTPUT" || mount.kind === "RUN_SCRATCH")
    && mount.access === "READ_WRITE");
  return (entry.readScopes.length === 0 || sourceReadable)
    && (entry.writeScopes.length === 0
      || (entry.authorityKind === "BUILDER" && repositoryOutputWritable));
}

function executionBindingsMatch(
  entry: CapabilityCatalogEntry,
  entryMaterials: CapabilityCatalogEntryResolutionMaterials,
  materials: CapabilityCatalogResolutionMaterials,
): boolean {
  const profile = materials.deliveryProfileRevision;
  const execution = entryMaterials.executionIsolationProfileRevision;
  const expectedPurpose = entry.authorityKind === "BUILDER" ? "BUILD_AGENT" : "FRESH_VERIFIER";
  const profileTools = new Set(profile.toolRefs.map((item) => item.artifactDigest));
  const profileImages = new Set(profile.imageRefs.map((item) => item.imageDigest));
  return execution.purpose === expectedPurpose
    && entry.deliveryProfileFamilyId === profile.profileFamilyId
    && entry.deliveryProfileRevisionId === profile.revisionId
    && entry.deliveryProfileRevisionDigest === profile.revisionDigest
    && entry.executionIsolationProfileRevisionId === execution.revisionId
    && entry.executionIsolationProfileRevisionDigest === execution.revisionDigest
    && execution.deliveryProfileRevisionDigest === profile.revisionDigest
    && profileImages.has(execution.image.imageDigest)
    && execution.tools.every((tool) => profileTools.has(tool.toolDigest))
    && pathScopesMatch(entry, entryMaterials)
    && entry.resourceScopes.every(
      (scope) => scopeClaimMatches(scope, entryMaterials, materials),
    );
}

function recipeBindingsMatch(
  entry: CapabilityCatalogEntry,
  entryMaterials: CapabilityCatalogEntryResolutionMaterials,
): boolean {
  const recipes = entryMaterials.verificationRecipeRevisions;
  if (entry.verificationRecipeRevisions.length !== recipes.length
    || !entry.verificationRecipeRevisions.every((reference, index) =>
      reference.recipeRevisionId === recipes[index]!.revisionId
      && reference.recipeRevisionDigest === recipes[index]!.revisionDigest)) return false;
  return recipes.every((recipe) => admitVerificationRecipeForExecutionProfile(
    recipe, entryMaterials.executionIsolationProfileRevision,
  ).ok)
    && sameStrings(entry.requiredImageDigests,
      sortedUnique(recipes.map((recipe) => recipe.image.imageDigest)))
    && sameStrings(entry.requiredToolDigests,
      sortedUnique(recipes.map((recipe) => recipe.tool.toolDigest)));
}

function exactSelectedMaterialsMatch(
  entries: readonly CapabilityCatalogEntry[],
  materials: CapabilityCatalogResolutionMaterials,
): boolean {
  const expectedIds = entries.map((entry) => entry.capabilityId).sort();
  const suppliedIds = materials.entryMaterials.map((entry) => entry.capabilityId);
  if (!sameStrings(expectedIds, suppliedIds)) return false;
  const byId = new Map(materials.entryMaterials.map((entry) => [entry.capabilityId, entry]));
  return entries.every((entry) => {
    const entryMaterials = byId.get(entry.capabilityId);
    return entryMaterials !== undefined
      && executionBindingsMatch(entry, entryMaterials, materials)
      && recipeBindingsMatch(entry, entryMaterials);
  });
}

export function capabilityCatalogResolutionBindingsMatch(
  builder: CapabilityCatalogEntry,
  verifiers: readonly CapabilityCatalogEntry[],
  request: CapabilityCatalogResolutionRequest,
  materials: CapabilityCatalogResolutionMaterials,
): boolean {
  if (builder.authorityKind !== "BUILDER"
    || !request.requiredCriterionCategories.every((category) =>
      builder.criterionCategories.includes(category)
      && verifiers.some((verifier) => verifier.criterionCategories.includes(category)))) {
    return false;
  }
  const receiptVerifierIds = sortedUnique(
    materials.deliveryProfileQualification.independentVerifierReceipts.map(
      (receipt) => receipt.verifierCapabilityId,
    ),
  );
  return materials.deliveryProfileQualification.builderIdentity.capabilityId
      === builder.capabilityId
    && sameStrings(builder.verifierCapabilityIds, receiptVerifierIds)
    && exactSelectedMaterialsMatch([builder, ...verifiers], materials);
}
