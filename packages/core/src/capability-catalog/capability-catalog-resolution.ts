import {
  deepFreeze,
  exact,
  snapshotDataBounded,
  validRef,
} from "../planning/planning-snapshot.js";
import type { DeliveryProfileQualificationAuthorityPort } from
  "../delivery-profile/delivery-profile-contract.js";
import { admitCapabilityCatalogRevision } from "./capability-catalog-admission.js";
import { encodeCapabilityCatalogRevision } from "./capability-catalog-codec.js";
import {
  CAPABILITY_CATALOG_CRITERION_CATEGORIES,
  CAPABILITY_CATALOG_LIMITS,
  capabilityCatalogRefusal,
  type CapabilityCatalogCriterionCategory,
  type CapabilityCatalogRefusal,
} from "./capability-catalog-contract.js";
import { capabilityCatalogResolutionBindingsMatch } from
  "./capability-catalog-resolution-bindings.js";
import type {
  CapabilityCatalogResolutionRequest,
  CapabilityCatalogResolutionResult,
} from "./capability-catalog-resolution-contract.js";
import { admitCapabilityCatalogResolutionMaterials } from
  "./capability-catalog-resolution-materials.js";

export type {
  CapabilityCatalogEntryResolutionMaterials,
  CapabilityCatalogResolvedEntryBinding,
  CapabilityCatalogResolutionMaterials,
  CapabilityCatalogResolutionRequest,
  CapabilityCatalogResolutionResult,
  CapabilityCatalogResolutionWitness,
} from "./capability-catalog-resolution-contract.js";

const REQUEST_KEYS = Object.freeze([
  "atEpochMs", "capabilityId", "requiredCriterionCategories",
]);
const encoder = new TextEncoder();
const malformed = (): CapabilityCatalogRefusal => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_MALFORMED", "CAPABILITY_CATALOG_RESOLUTION",
);
const mismatch = (): CapabilityCatalogRefusal => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_BINDING_MISMATCH", "CAPABILITY_CATALOG_RESOLUTION",
);

function validText(value: unknown): value is string {
  return validRef(value) && !value.includes("\0") && value.isWellFormed()
    && value.normalize("NFC") === value && value.trim() === value
    && encoder.encode(value).byteLength <= CAPABILITY_CATALOG_LIMITS.maxIdBytes;
}

function readRequest(value: unknown): CapabilityCatalogResolutionRequest | undefined {
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: CAPABILITY_CATALOG_CRITERION_CATEGORIES.length,
    maxDepth: 2,
    maxNodes: CAPABILITY_CATALOG_CRITERION_CATEGORIES.length + REQUEST_KEYS.length + 1,
  });
  if (!snapshot.ok || !exact(snapshot.value, REQUEST_KEYS)) return undefined;
  const record = snapshot.value;
  const values = record["requiredCriterionCategories"];
  const atEpochMs = record["atEpochMs"];
  if (!Number.isSafeInteger(atEpochMs) || (atEpochMs as number) < 0
    || Object.is(atEpochMs, -0) || !validText(record["capabilityId"]) || !Array.isArray(values)
    || values.length === 0 || values.length > CAPABILITY_CATALOG_CRITERION_CATEGORIES.length) {
    return undefined;
  }
  const categories: CapabilityCatalogCriterionCategory[] = [];
  for (const value of values) {
    if (!CAPABILITY_CATALOG_CRITERION_CATEGORIES.some((candidate) => candidate === value)) {
      return undefined;
    }
    const category = value as CapabilityCatalogCriterionCategory;
    if (categories.at(-1) !== undefined && categories.at(-1)! >= category) return undefined;
    categories.push(category);
  }
  return Object.freeze({
    atEpochMs: atEpochMs as number,
    capabilityId: record["capabilityId"],
    requiredCriterionCategories: Object.freeze(categories),
  });
}

/** Resolves one exact builder and every bound verifier without fallback or partial success. */
export function resolveCapabilityCatalogEntry(
  catalogValue: unknown,
  requestValue: unknown,
  materialsValue: unknown,
  qualificationAuthority: DeliveryProfileQualificationAuthorityPort | undefined,
): CapabilityCatalogResolutionResult {
  const catalog = admitCapabilityCatalogRevision(catalogValue); if (!catalog.ok) return catalog;
  const verifiedCatalog = encodeCapabilityCatalogRevision(catalog.revision);
  if (!verifiedCatalog.ok) return verifiedCatalog;
  const request = readRequest(requestValue); if (request === undefined) return malformed();
  const builder = catalog.revision.entries.find(
    (candidate) => candidate.capabilityId === request.capabilityId,
  );
  if (builder === undefined) return capabilityCatalogRefusal(
    "CAPABILITY_CATALOG_ENTRY_ABSENT", "CAPABILITY_CATALOG_RESOLUTION",
  );
  if (builder.authorityKind !== "BUILDER") return mismatch();
  const byId = new Map(catalog.revision.entries.map((entry) => [entry.capabilityId, entry]));
  const verifiers = builder.verifierCapabilityIds.map((id) => byId.get(id));
  if (verifiers.some((entry) => entry === undefined)) return mismatch();
  const admittedMaterials = admitCapabilityCatalogResolutionMaterials(
    materialsValue, request.atEpochMs, qualificationAuthority,
  );
  if (!admittedMaterials.ok) return admittedMaterials;
  const typedVerifiers = verifiers as Exclude<(typeof verifiers)[number], undefined>[];
  if (!capabilityCatalogResolutionBindingsMatch(
    builder, typedVerifiers, request, admittedMaterials.materials,
  )) return mismatch();

  const materialById = new Map(admittedMaterials.materials.entryMaterials.map(
    (entry) => [entry.capabilityId, entry],
  ));
  const resolvedBinding = (entry: typeof builder) => {
    const material = materialById.get(entry.capabilityId)!;
    return Object.freeze({
      capability: entry,
      executionIsolationProfileRevision: material.executionIsolationProfileRevision,
      verificationRecipeRevisions: material.verificationRecipeRevisions,
    });
  };
  const witness = deepFreeze({
    atEpochMs: request.atEpochMs,
    builderBinding: resolvedBinding(builder),
    catalogId: catalog.revision.catalogId,
    catalogRevisionDigest: catalog.revision.revisionDigest,
    catalogRevisionId: catalog.revision.revisionId,
    deliveryProfileQualification:
      admittedMaterials.materials.deliveryProfileQualification,
    deliveryProfileQualificationStatus: admittedMaterials.qualificationStatus,
    deliveryProfileRevision: admittedMaterials.materials.deliveryProfileRevision,
    requiredCriterionCategories: request.requiredCriterionCategories,
    verifierBindings: Object.freeze(typedVerifiers.map(resolvedBinding)),
  });
  return Object.freeze({ ok: true as const, witness });
}
