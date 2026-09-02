import { exact, validHex64, validRef } from "../planning/planning-snapshot.js";
import {
  CAPABILITY_CATALOG_CRITERION_CATEGORIES,
  CAPABILITY_CATALOG_LIMITS,
  CAPABILITY_CATALOG_ROLES,
  capabilityCatalogRefusal,
  type CapabilityCatalogCriterionCategory,
  type CapabilityCatalogLayer,
  type CapabilityCatalogLineage,
  type CapabilityCatalogRefusal,
  type CapabilityCatalogRole,
  type CapabilityCatalogVerificationRecipeRevisionRef,
} from "./capability-catalog-contract.js";

export type CapabilityCatalogReadResult<T> =
  | Readonly<{ ok: true; value: T }>
  | CapabilityCatalogRefusal;
type InputLayer =
  | "CAPABILITY_CATALOG_ADMISSION"
  | "CAPABILITY_CATALOG_REFERENCES"
  | "CAPABILITY_CATALOG_SCOPES";

const LINEAGE_KEYS = Object.freeze(["parentRevisionDigest", "parentRevisionId"]);
const RECIPE_REF_KEYS = Object.freeze(["recipeRevisionDigest", "recipeRevisionId"]);
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });
const vacuous = (layer: CapabilityCatalogLayer) =>
  capabilityCatalogRefusal("CAPABILITY_CATALOG_VACUOUS", layer);
const referenceInvalid = () => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_REFERENCE_INVALID", "CAPABILITY_CATALOG_REFERENCES",
);
const scopeInvalid = () => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_SCOPE_INVALID", "CAPABILITY_CATALOG_SCOPES",
);
const limitExceeded = () => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_LIMIT_EXCEEDED", "CAPABILITY_CATALOG_LIMITS",
);

function invalidFor(layer: InputLayer): CapabilityCatalogRefusal {
  if (layer === "CAPABILITY_CATALOG_REFERENCES") return referenceInvalid();
  if (layer === "CAPABILITY_CATALOG_SCOPES") return scopeInvalid();
  return capabilityCatalogRefusal("CAPABILITY_CATALOG_MALFORMED", layer);
}

export function readCapabilityCatalogText(
  value: unknown,
  layer: InputLayer,
  maximum: number = CAPABILITY_CATALOG_LIMITS.maxIdBytes,
): CapabilityCatalogReadResult<string> {
  if (!validRef(value) || value.includes("\0") || !value.isWellFormed()
    || value.normalize("NFC") !== value) return invalidFor(layer);
  if (value.trim().length === 0) return vacuous(layer);
  if (value.trim() !== value) return invalidFor(layer);
  if (value.length > maximum || encoder.encode(value).byteLength > maximum) {
    return limitExceeded();
  }
  return success(value);
}

export function readCapabilityCatalogLineage(
  value: unknown,
  revisionId: string,
): CapabilityCatalogReadResult<CapabilityCatalogLineage | null> {
  if (value === null) return success(null);
  if (!exact(value, LINEAGE_KEYS) || !validHex64(value["parentRevisionDigest"])) {
    return referenceInvalid();
  }
  const parentId = readCapabilityCatalogText(
    value["parentRevisionId"], "CAPABILITY_CATALOG_REFERENCES",
  );
  if (!parentId.ok) return parentId;
  if (parentId.value === revisionId) return referenceInvalid();
  return success(Object.freeze({
    parentRevisionDigest: value["parentRevisionDigest"],
    parentRevisionId: parentId.value,
  }));
}

export function readCapabilityCatalogCriterionCategories(
  value: unknown,
): CapabilityCatalogReadResult<readonly CapabilityCatalogCriterionCategory[]> {
  if (!Array.isArray(value)) return referenceInvalid();
  if (value.length === 0) return vacuous("CAPABILITY_CATALOG_REFERENCES");
  if (value.length > CAPABILITY_CATALOG_CRITERION_CATEGORIES.length) return limitExceeded();
  const categories: CapabilityCatalogCriterionCategory[] = [];
  for (const candidate of value) {
    if (!CAPABILITY_CATALOG_CRITERION_CATEGORIES.some((entry) => entry === candidate)) {
      return referenceInvalid();
    }
    const category = candidate as CapabilityCatalogCriterionCategory;
    if (categories.at(-1) !== undefined && categories.at(-1)! >= category) {
      return referenceInvalid();
    }
    categories.push(category);
  }
  return success(Object.freeze(categories));
}

export function readCapabilityCatalogDigestList(
  value: unknown,
  format: "OCI_SHA256" | "SHA256" = "SHA256",
): CapabilityCatalogReadResult<readonly string[]> {
  if (!Array.isArray(value)) return referenceInvalid();
  if (value.length > CAPABILITY_CATALOG_LIMITS.maxRefsPerEntry) return limitExceeded();
  const digests: string[] = [];
  for (const candidate of value) {
    if (!(format === "SHA256" ? validHex64(candidate)
      : typeof candidate === "string" && OCI_DIGEST.test(candidate))
      || (digests.at(-1) !== undefined && digests.at(-1)! >= candidate)) {
      return referenceInvalid();
    }
    digests.push(candidate);
  }
  return success(Object.freeze(digests));
}

export function readCapabilityCatalogRoles(
  value: unknown,
): CapabilityCatalogReadResult<readonly CapabilityCatalogRole[]> {
  if (!Array.isArray(value)) return referenceInvalid();
  if (value.length === 0) return vacuous("CAPABILITY_CATALOG_AUTHORITY");
  if (value.length > CAPABILITY_CATALOG_ROLES.length) return limitExceeded();
  const roles: CapabilityCatalogRole[] = [];
  for (const candidate of value) {
    if (!CAPABILITY_CATALOG_ROLES.some((role) => role === candidate)) {
      return referenceInvalid();
    }
    const role = candidate as CapabilityCatalogRole;
    if (roles.at(-1) !== undefined && roles.at(-1)! >= role) return referenceInvalid();
    roles.push(role);
  }
  return success(Object.freeze(roles));
}

export function readCapabilityCatalogIdList(
  value: unknown,
): CapabilityCatalogReadResult<readonly string[]> {
  if (!Array.isArray(value)) return referenceInvalid();
  if (value.length > CAPABILITY_CATALOG_LIMITS.maxRefsPerEntry) return limitExceeded();
  const ids: string[] = [];
  for (const candidate of value) {
    const id = readCapabilityCatalogText(candidate, "CAPABILITY_CATALOG_REFERENCES");
    if (!id.ok) return id;
    if (ids.at(-1) !== undefined && ids.at(-1)! >= id.value) return referenceInvalid();
    ids.push(id.value);
  }
  return success(Object.freeze(ids));
}

function readRecipeRef(
  value: unknown,
): CapabilityCatalogReadResult<CapabilityCatalogVerificationRecipeRevisionRef> {
  if (!exact(value, RECIPE_REF_KEYS) || !validHex64(value["recipeRevisionDigest"])) {
    return referenceInvalid();
  }
  const id = readCapabilityCatalogText(
    value["recipeRevisionId"], "CAPABILITY_CATALOG_REFERENCES",
  );
  if (!id.ok) return id;
  return success(Object.freeze({
    recipeRevisionDigest: value["recipeRevisionDigest"],
    recipeRevisionId: id.value,
  }));
}

export function readCapabilityCatalogRecipeRefs(
  value: unknown,
): CapabilityCatalogReadResult<readonly CapabilityCatalogVerificationRecipeRevisionRef[]> {
  if (!Array.isArray(value)) return referenceInvalid();
  if (value.length === 0) return vacuous("CAPABILITY_CATALOG_REFERENCES");
  if (value.length > CAPABILITY_CATALOG_LIMITS.maxRefsPerEntry) return limitExceeded();
  const refs: CapabilityCatalogVerificationRecipeRevisionRef[] = [];
  const digests = new Set<string>();
  for (const candidate of value) {
    const reference = readRecipeRef(candidate);
    if (!reference.ok) return reference;
    if (refs.at(-1) !== undefined
      && refs.at(-1)!.recipeRevisionId >= reference.value.recipeRevisionId) {
      return referenceInvalid();
    }
    if (digests.has(reference.value.recipeRevisionDigest)) return referenceInvalid();
    digests.add(reference.value.recipeRevisionDigest);
    refs.push(reference.value);
  }
  return success(Object.freeze(refs));
}
