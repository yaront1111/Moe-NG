import type {
  DeliveryProfileDurableQualificationStatus,
  DeliveryProfileQualificationAuthorityPort,
} from
  "../delivery-profile/delivery-profile-contract.js";
import { resolveQualifiedDeliveryProfile } from
  "../delivery-profile/delivery-profile-qualification.js";
import { admitExecutionIsolationProfileRevision } from
  "../execution-profile/execution-isolation-profile-admission.js";
import { encodeExecutionIsolationProfileRevision } from
  "../execution-profile/execution-isolation-profile-codec.js";
import type { VerificationRecipeRevision } from
  "../execution-profile/verification-recipe-contract.js";
import { admitVerificationRecipeRevision } from
  "../execution-profile/verification-recipe-admission.js";
import { encodeVerificationRecipeRevision } from
  "../execution-profile/verification-recipe-codec.js";
import { exact, snapshotDataBounded } from "../planning/planning-snapshot.js";
import {
  CAPABILITY_CATALOG_LIMITS,
  capabilityCatalogRefusal,
  type CapabilityCatalogRefusal,
} from "./capability-catalog-contract.js";
import type {
  CapabilityCatalogEntryResolutionMaterials,
  CapabilityCatalogResolutionMaterials,
} from "./capability-catalog-resolution-contract.js";
import { readCapabilityCatalogText } from "./capability-catalog-value-readers.js";

type MaterialsAdmission =
  | Readonly<{
    materials: CapabilityCatalogResolutionMaterials;
    ok: true;
    qualificationStatus: DeliveryProfileDurableQualificationStatus;
  }>
  | CapabilityCatalogRefusal;

const MATERIAL_KEYS = Object.freeze([
  "deliveryProfileQualification", "deliveryProfileRevision", "entryMaterials",
]);
const ENTRY_KEYS = Object.freeze([
  "capabilityId", "executionIsolationProfileRevision", "verificationRecipeRevisions",
]);
const mismatch = (): CapabilityCatalogRefusal => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_BINDING_MISMATCH", "CAPABILITY_CATALOG_RESOLUTION",
);

function readRecipes(value: unknown): readonly VerificationRecipeRevision[] | undefined {
  if (!Array.isArray(value) || value.length === 0
    || value.length > CAPABILITY_CATALOG_LIMITS.maxRefsPerEntry) return undefined;
  const recipes: VerificationRecipeRevision[] = [];
  const digests = new Set<string>();
  for (const candidate of value) {
    const admitted = admitVerificationRecipeRevision(candidate);
    if (!admitted.ok || !encodeVerificationRecipeRevision(admitted.revision).ok) {
      return undefined;
    }
    const previous = recipes.at(-1);
    if (previous !== undefined && previous.revisionId >= admitted.revision.revisionId) {
      return undefined;
    }
    if (digests.has(admitted.revision.revisionDigest)) return undefined;
    digests.add(admitted.revision.revisionDigest);
    recipes.push(admitted.revision);
  }
  return Object.freeze(recipes);
}

function readEntryMaterials(
  value: unknown,
): CapabilityCatalogEntryResolutionMaterials | undefined {
  if (!exact(value, ENTRY_KEYS)) return undefined;
  const capabilityId = readCapabilityCatalogText(
    value["capabilityId"], "CAPABILITY_CATALOG_REFERENCES",
  );
  const execution = admitExecutionIsolationProfileRevision(
    value["executionIsolationProfileRevision"],
  );
  const recipes = readRecipes(value["verificationRecipeRevisions"]);
  if (!capabilityId.ok || !execution.ok || recipes === undefined
    || !encodeExecutionIsolationProfileRevision(execution.revision).ok) return undefined;
  return Object.freeze({
    capabilityId: capabilityId.value,
    executionIsolationProfileRevision: execution.revision,
    verificationRecipeRevisions: recipes,
  });
}

/** Resolves durable current qualification, then admits exact per-capability execution material. */
export function admitCapabilityCatalogResolutionMaterials(
  value: unknown,
  atEpochMs: number,
  authority: DeliveryProfileQualificationAuthorityPort | undefined,
): MaterialsAdmission {
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: CAPABILITY_CATALOG_LIMITS.maxEntries,
    maxDepth: 16,
    maxNodes: CAPABILITY_CATALOG_LIMITS.maxSnapshotNodes,
  });
  if (!snapshot.ok || !exact(snapshot.value, MATERIAL_KEYS)) return mismatch();
  const record = snapshot.value;
  const qualified = resolveQualifiedDeliveryProfile(
    record["deliveryProfileRevision"], record["deliveryProfileQualification"],
    atEpochMs, authority,
  );
  if (!qualified.ok) return mismatch();

  const candidates = record["entryMaterials"];
  if (!Array.isArray(candidates) || candidates.length === 0
    || candidates.length > CAPABILITY_CATALOG_LIMITS.maxEntries) return mismatch();
  const entries: CapabilityCatalogEntryResolutionMaterials[] = [];
  for (const candidate of candidates) {
    const entry = readEntryMaterials(candidate); if (entry === undefined) return mismatch();
    if (entries.at(-1) !== undefined
      && entries.at(-1)!.capabilityId >= entry.capabilityId) return mismatch();
    entries.push(entry);
  }
  return Object.freeze({
    materials: Object.freeze({
      deliveryProfileQualification: qualified.qualification,
      deliveryProfileRevision: qualified.profile,
      entryMaterials: Object.freeze(entries),
    }),
    ok: true as const,
    qualificationStatus: qualified.qualificationStatus,
  });
}
