import { CAPABILITY_CATALOG_LIMITS } from "@moe/core";

import type {
  CapabilityCatalogRevisionRef,
  DeliveryProfileQualificationRef,
  DeliveryProfileRevisionRef,
  DeliveryV2ResolutionMaterialRefs,
  ExecutionIsolationProfileRevisionRef,
  VerificationRecipeRevisionRef,
} from "./contracts.js";
import { snapshotDeliveryV2PlainData } from "./snapshot.js";

const HEX64 = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const REVISION_KEYS = Object.freeze(["projectId", "revisionDigest", "revisionId"]);
const TOP_KEYS = Object.freeze([
  "catalog", "deliveryProfile", "entries", "projectId", "qualification",
]);
const ENTRY_KEYS = Object.freeze([
  "capabilityId", "executionIsolationProfile", "verificationRecipes",
]);

type RecordValue = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is RecordValue =>
  record(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value !== ""
  && encoder.encode(value).byteLength <= CAPABILITY_CATALOG_LIMITS.maxIdBytes;
const digest = (value: unknown): value is string => typeof value === "string" && HEX64.test(value);

function revisionRef(value: unknown, idKey: string, project: boolean): value is RecordValue {
  const keys = project ? [...REVISION_KEYS, idKey] : REVISION_KEYS.slice(1).concat(idKey);
  return exact(value, keys) && text(value[idKey]) && text(value["revisionId"])
    && digest(value["revisionDigest"]) && (!project || text(value["projectId"]));
}

function qualificationRef(value: unknown, project: boolean): value is RecordValue {
  const keys = project
    ? ["projectId", "qualificationDigest", "qualificationId"]
    : ["qualificationDigest", "qualificationId"];
  return exact(value, keys) && text(value["qualificationId"])
    && digest(value["qualificationDigest"]) && (!project || text(value["projectId"]));
}

function admitted<T>(value: unknown, valid: (safe: unknown) => boolean): T | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  return safe !== undefined && valid(safe) ? safe as T : undefined;
}

export const admitCapabilityCatalogRevisionRef = (value: unknown) => admitted<
CapabilityCatalogRevisionRef>(value, (safe) => revisionRef(safe, "catalogId", true));
export const admitDeliveryProfileRevisionRef = (value: unknown) => admitted<
DeliveryProfileRevisionRef>(value, (safe) => revisionRef(safe, "profileId", true));
export const admitExecutionIsolationProfileRevisionRef = (value: unknown) => admitted<
ExecutionIsolationProfileRevisionRef>(value, (safe) => revisionRef(safe, "profileId", true));
export const admitVerificationRecipeRevisionRef = (value: unknown) => admitted<
VerificationRecipeRevisionRef>(value, (safe) => revisionRef(safe, "recipeId", true));
export const admitDeliveryProfileQualificationRef = (value: unknown) => admitted<
DeliveryProfileQualificationRef>(value, (safe) => qualificationRef(safe, true));

function canonicalEntries(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0
    || value.length > CAPABILITY_CATALOG_LIMITS.maxEntries) return false;
  let previousCapabilityId: string | undefined;
  for (const candidate of value) {
    if (!exact(candidate, ENTRY_KEYS) || !text(candidate["capabilityId"])
      || !revisionRef(candidate["executionIsolationProfile"], "profileId", false)) return false;
    if (previousCapabilityId !== undefined && previousCapabilityId >= candidate["capabilityId"]) {
      return false;
    }
    previousCapabilityId = candidate["capabilityId"];
    const recipes = candidate["verificationRecipes"];
    if (!Array.isArray(recipes) || recipes.length === 0
      || recipes.length > CAPABILITY_CATALOG_LIMITS.maxRefsPerEntry) return false;
    let previousRevisionId: string | undefined;
    const digests = new Set<string>();
    for (const recipe of recipes) {
      if (!revisionRef(recipe, "recipeId", false)) return false;
      const revisionId = recipe["revisionId"] as string;
      const revisionDigest = recipe["revisionDigest"] as string;
      if ((previousRevisionId !== undefined && previousRevisionId >= revisionId)
        || digests.has(revisionDigest)) return false;
      previousRevisionId = revisionId;
      digests.add(revisionDigest);
    }
  }
  return true;
}

/** Snapshots once and admits the complete, canonical, bounded planning reference graph. */
export function admitDeliveryV2ResolutionMaterialRefs(
  value: unknown,
): DeliveryV2ResolutionMaterialRefs | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (!exact(safe, TOP_KEYS) || !text(safe["projectId"])
    || !revisionRef(safe["catalog"], "catalogId", false)
    || !revisionRef(safe["deliveryProfile"], "profileId", false)
    || !qualificationRef(safe["qualification"], false)
    || !canonicalEntries(safe["entries"])) return undefined;
  return safe as unknown as DeliveryV2ResolutionMaterialRefs;
}
