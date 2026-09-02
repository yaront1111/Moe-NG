import { exact, validHex64 } from "../planning/planning-snapshot.js";
import {
  CAPABILITY_CATALOG_AUTHORITY_KINDS,
  CAPABILITY_CATALOG_DELIVERY_PROFILE_FAMILY_IDS,
  CAPABILITY_CATALOG_LIMITS,
  CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES,
  CAPABILITY_CATALOG_ROLES,
  capabilityCatalogRefusal,
  type CapabilityCatalogEntry,
} from "./capability-catalog-contract.js";
import {
  readCapabilityCatalogPathScopes,
  readCapabilityCatalogResourceScopes,
} from "./capability-catalog-scope-readers.js";
import {
  readCapabilityCatalogCriterionCategories,
  readCapabilityCatalogDigestList,
  readCapabilityCatalogIdList,
  readCapabilityCatalogRecipeRefs,
  readCapabilityCatalogRoles,
  readCapabilityCatalogText,
  type CapabilityCatalogReadResult,
} from "./capability-catalog-value-readers.js";

const ENTRY_KEYS = Object.freeze([
  "authorityKind",
  "capabilityId",
  "criterionCategories",
  "deliveryProfileFamilyId",
  "deliveryProfileRevisionDigest",
  "deliveryProfileRevisionId",
  "executionIsolationProfileRevisionDigest",
  "executionIsolationProfileRevisionId",
  "readScopes",
  "requiredImageDigests",
  "requiredToolDigests",
  "resourceScopes",
  "roles",
  "verificationRecipeRevisions",
  "verifierCapabilityIds",
  "writeScopes",
]);

function malformed() {
  return capabilityCatalogRefusal(
    "CAPABILITY_CATALOG_MALFORMED", "CAPABILITY_CATALOG_ADMISSION",
  );
}

function referenceInvalid() {
  return capabilityCatalogRefusal(
    "CAPABILITY_CATALOG_REFERENCE_INVALID", "CAPABILITY_CATALOG_REFERENCES",
  );
}

function verifierBindingInvalid() {
  return capabilityCatalogRefusal(
    "CAPABILITY_CATALOG_VERIFIER_BINDING_INVALID", "CAPABILITY_CATALOG_AUTHORITY",
  );
}

function roleCoverageIncomplete() {
  return capabilityCatalogRefusal(
    "CAPABILITY_CATALOG_ROLE_COVERAGE_INCOMPLETE", "CAPABILITY_CATALOG_AUTHORITY",
  );
}

function readEntry(value: unknown): CapabilityCatalogReadResult<CapabilityCatalogEntry> {
  if (!exact(value, ENTRY_KEYS)) return malformed();
  const capabilityId = readCapabilityCatalogText(
    value["capabilityId"], "CAPABILITY_CATALOG_ADMISSION",
  );
  const categories = readCapabilityCatalogCriterionCategories(value["criterionCategories"]);
  const deliveryRevisionId = readCapabilityCatalogText(
    value["deliveryProfileRevisionId"], "CAPABILITY_CATALOG_REFERENCES",
  );
  const executionRevisionId = readCapabilityCatalogText(
    value["executionIsolationProfileRevisionId"], "CAPABILITY_CATALOG_REFERENCES",
  );
  const read = readCapabilityCatalogPathScopes(value["readScopes"]);
  const write = readCapabilityCatalogPathScopes(value["writeScopes"]);
  const resources = readCapabilityCatalogResourceScopes(value["resourceScopes"]);
  const tools = readCapabilityCatalogDigestList(value["requiredToolDigests"]);
  const images = readCapabilityCatalogDigestList(value["requiredImageDigests"], "OCI_SHA256");
  const roles = readCapabilityCatalogRoles(value["roles"]);
  const recipes = readCapabilityCatalogRecipeRefs(value["verificationRecipeRevisions"]);
  const verifierIds = readCapabilityCatalogIdList(value["verifierCapabilityIds"]);
  const results = [capabilityId, categories, deliveryRevisionId, executionRevisionId,
    read, write, resources, tools, images, roles, recipes, verifierIds];
  const refusal = results.find((candidate) => !candidate.ok);
  if (refusal !== undefined && !refusal.ok) return refusal;
  if (!capabilityId.ok || !categories.ok || !deliveryRevisionId.ok || !executionRevisionId.ok
    || !read.ok || !write.ok || !resources.ok || !tools.ok || !images.ok || !roles.ok
    || !recipes.ok || !verifierIds.ok) {
    return malformed();
  }
  if (!CAPABILITY_CATALOG_AUTHORITY_KINDS.some(
    (candidate) => candidate === value["authorityKind"],
  )) return verifierBindingInvalid();
  if (value["authorityKind"] === "VERIFIER" && write.value.length !== 0) {
    return capabilityCatalogRefusal(
      "CAPABILITY_CATALOG_SCOPE_INVALID", "CAPABILITY_CATALOG_SCOPES",
    );
  }
  if (!CAPABILITY_CATALOG_DELIVERY_PROFILE_FAMILY_IDS.some(
    (candidate) => candidate === value["deliveryProfileFamilyId"],
  ) || !validHex64(value["deliveryProfileRevisionDigest"])
    || !validHex64(value["executionIsolationProfileRevisionDigest"])) {
    return referenceInvalid();
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      authorityKind: value["authorityKind"],
      capabilityId: capabilityId.value,
      criterionCategories: categories.value,
      deliveryProfileFamilyId: value["deliveryProfileFamilyId"],
      deliveryProfileRevisionDigest: value["deliveryProfileRevisionDigest"],
      deliveryProfileRevisionId: deliveryRevisionId.value,
      executionIsolationProfileRevisionDigest:
        value["executionIsolationProfileRevisionDigest"],
      executionIsolationProfileRevisionId: executionRevisionId.value,
      readScopes: read.value,
      requiredImageDigests: images.value,
      requiredToolDigests: tools.value,
      resourceScopes: resources.value,
      roles: roles.value,
      verificationRecipeRevisions: recipes.value,
      verifierCapabilityIds: verifierIds.value,
      writeScopes: write.value,
    } as CapabilityCatalogEntry),
  });
}

export function readCapabilityCatalogEntries(
  value: unknown,
): CapabilityCatalogReadResult<readonly CapabilityCatalogEntry[]> {
  if (!Array.isArray(value)) return malformed();
  if (value.length === 0) {
    return capabilityCatalogRefusal(
      "CAPABILITY_CATALOG_VACUOUS", "CAPABILITY_CATALOG_ADMISSION",
    );
  }
  if (value.length > CAPABILITY_CATALOG_LIMITS.maxEntries) {
    return capabilityCatalogRefusal(
      "CAPABILITY_CATALOG_LIMIT_EXCEEDED", "CAPABILITY_CATALOG_LIMITS",
    );
  }
  const entries: CapabilityCatalogEntry[] = [];
  for (const candidate of value) {
    const entry = readEntry(candidate);
    if (!entry.ok) return entry;
    if (entries.at(-1) !== undefined
      && entries.at(-1)!.capabilityId >= entry.value.capabilityId) return malformed();
    entries.push(entry.value);
  }
  const recipeIds = new Map<string, string>();
  const recipeDigests = new Map<string, string>();
  for (const entry of entries) {
    for (const recipe of entry.verificationRecipeRevisions) {
      const knownDigest = recipeIds.get(recipe.recipeRevisionId);
      const knownId = recipeDigests.get(recipe.recipeRevisionDigest);
      if ((knownDigest !== undefined && knownDigest !== recipe.recipeRevisionDigest)
        || (knownId !== undefined && knownId !== recipe.recipeRevisionId)) {
        return referenceInvalid();
      }
      recipeIds.set(recipe.recipeRevisionId, recipe.recipeRevisionDigest);
      recipeDigests.set(recipe.recipeRevisionDigest, recipe.recipeRevisionId);
    }
  }
  const coveredRoles = new Set(entries.flatMap((entry) => entry.roles));
  if (CAPABILITY_CATALOG_ROLES.some((role) => !coveredRoles.has(role))) {
    return roleCoverageIncomplete();
  }
  const verifiers = entries.filter((entry) => entry.authorityKind === "VERIFIER");
  if (CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES.some(
    (role) => !verifiers.some((entry) => entry.roles.includes(role)),
  )) return roleCoverageIncomplete();
  const byId = new Map(entries.map((entry) => [entry.capabilityId, entry]));
  for (const entry of entries) {
    if (entry.authorityKind === "VERIFIER") {
      if (entry.verifierCapabilityIds.length !== 0) return verifierBindingInvalid();
      continue;
    }
    if (entry.verifierCapabilityIds.length === 0 || entry.verifierCapabilityIds.some(
      (id) => id === entry.capabilityId || byId.get(id)?.authorityKind !== "VERIFIER",
    )) return verifierBindingInvalid();
    const boundVerifiers = entry.verifierCapabilityIds.map((id) => byId.get(id)!);
    if (CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES.some(
      (role) => !boundVerifiers.some((verifier) => verifier.roles.includes(role)),
    )) return roleCoverageIncomplete();
  }
  return Object.freeze({ ok: true as const, value: Object.freeze(entries) });
}
