import {
  DELIVERY_PROFILE_VERSION,
  type DeliveryProfileRevisionAdmission, type DeliveryProfileRevisionDraft,
  type DeliveryProfileRevisionDraftAdmission,
} from "./delivery-profile-contract.js";
import { deliveryProfileFamilyDefinition } from "./delivery-profile-family-definitions.js";
import {
  deepFreeze, exact, familyGrammarMismatch, isFamily, malformed, readArtifacts, readImages,
  readDeliveryProfileSnapshot, readText, success, unsupportedFamily, validHex64, type ReadResult,
} from "./delivery-profile-admission-primitives.js";
import {
  matchesFamilyDefinition, profileReferencesValid, readCompose, readSecrets,
} from "./delivery-profile-compose-admission.js";
import { readRecipes, readStack } from "./delivery-profile-execution-admission.js";
import {
  readAllowedCapabilityIds, readBenchmarkCorpus, readModelProviderCapabilities, readPolicyRefs,
  readResourceClasses, readScopeRoster, readSupportedBackendFacts, readSupportedHostFacts,
} from "./delivery-profile-revision-facts-admission.js";

type ParsedProfile = Readonly<{
  body: DeliveryProfileRevisionDraft;
  revisionDigest?: string;
}>;
const PROFILE_DRAFT_KEYS = Object.freeze([
  "allowedCapabilityIds", "composeTopology", "familyDefinitionDigest", "imageRefs", "policyRefs",
  "profileFamilyId", "profileId", "qualificationBenchmarkCorpus", "readScopes", "recipes",
  "requiredModelProviderCapabilities", "resourceClasses", "revisionId", "secretSchema",
  "stackGrammar", "supportedBackendFacts", "supportedHostFacts", "templateRefs", "toolRefs",
  "writeScopes",
]);
const PROFILE_FULL_KEYS = Object.freeze([...PROFILE_DRAFT_KEYS, "revisionDigest", "version"]);

function parseProfile(value: unknown, full: boolean): ReadResult<ParsedProfile> {
  const snapshot = readDeliveryProfileSnapshot(value);
  if (!snapshot.ok) return snapshot;
  if (!exact(snapshot.value, full ? PROFILE_FULL_KEYS : PROFILE_DRAFT_KEYS)) return malformed();
  const record = snapshot.value;
  if (full && record["version"] !== DELIVERY_PROFILE_VERSION) {
    return Object.freeze({
      code: "DELIVERY_PROFILE_VERSION_UNSUPPORTED" as const,
      layer: "DELIVERY_PROFILE_VERSION" as const, ok: false as const,
    });
  }
  const family = record["profileFamilyId"];
  if (!isFamily(family)) return unsupportedFamily();
  if (!validHex64(record["familyDefinitionDigest"])) return malformed();
  const profileId = readText(record["profileId"]); const revisionId = readText(record["revisionId"]);
  const stackGrammar = readStack(record["stackGrammar"]);
  const allowedCapabilityIds = readAllowedCapabilityIds(record["allowedCapabilityIds"]);
  const templateRefs = readArtifacts(record["templateRefs"]);
  const toolRefs = readArtifacts(record["toolRefs"]); const imageRefs = readImages(record["imageRefs"]);
  const recipes = readRecipes(record["recipes"]); const composeTopology = readCompose(record["composeTopology"]);
  const secretSchema = readSecrets(record["secretSchema"]); const policyRefs = readPolicyRefs(record["policyRefs"]);
  const benchmarkCorpus = readBenchmarkCorpus(record["qualificationBenchmarkCorpus"]);
  const readScopes = readScopeRoster(record["readScopes"]);
  const writeScopes = readScopeRoster(record["writeScopes"]);
  const providerCapabilities = readModelProviderCapabilities(
    record["requiredModelProviderCapabilities"],
  );
  const resourceClasses = readResourceClasses(record["resourceClasses"]);
  const backendFacts = readSupportedBackendFacts(record["supportedBackendFacts"]);
  const hostFacts = readSupportedHostFacts(record["supportedHostFacts"]);
  if (!profileId.ok) return profileId; if (!revisionId.ok) return revisionId;
  if (!stackGrammar.ok) return stackGrammar; if (!allowedCapabilityIds.ok) return allowedCapabilityIds;
  if (!templateRefs.ok) return templateRefs;
  if (!toolRefs.ok) return toolRefs; if (!imageRefs.ok) return imageRefs;
  if (!recipes.ok) return recipes; if (!composeTopology.ok) return composeTopology;
  if (!secretSchema.ok) return secretSchema; if (!policyRefs.ok) return policyRefs;
  if (!benchmarkCorpus.ok) return benchmarkCorpus; if (!readScopes.ok) return readScopes;
  if (!writeScopes.ok) return writeScopes; if (!providerCapabilities.ok) return providerCapabilities;
  if (!resourceClasses.ok) return resourceClasses; if (!backendFacts.ok) return backendFacts;
  if (!hostFacts.ok) return hostFacts;
  const body: DeliveryProfileRevisionDraft = Object.freeze({
    allowedCapabilityIds: allowedCapabilityIds.value, composeTopology: composeTopology.value,
    familyDefinitionDigest: record["familyDefinitionDigest"],
    imageRefs: imageRefs.value, policyRefs: policyRefs.value, profileFamilyId: family,
    profileId: profileId.value, qualificationBenchmarkCorpus: benchmarkCorpus.value,
    readScopes: readScopes.value, recipes: recipes.value,
    requiredModelProviderCapabilities: providerCapabilities.value,
    resourceClasses: resourceClasses.value, revisionId: revisionId.value,
    secretSchema: secretSchema.value, stackGrammar: stackGrammar.value,
    supportedBackendFacts: backendFacts.value, supportedHostFacts: hostFacts.value,
    templateRefs: templateRefs.value, toolRefs: toolRefs.value, writeScopes: writeScopes.value,
  });
  if (!profileReferencesValid(body)) return Object.freeze({
    code: "DELIVERY_PROFILE_REFERENCE_INVALID" as const,
    layer: "DELIVERY_PROFILE_REFERENCES" as const, ok: false as const,
  });
  const definition = deliveryProfileFamilyDefinition(family);
  if (definition === undefined || !matchesFamilyDefinition(body, definition)) {
    return familyGrammarMismatch();
  }
  if (!full) return success(Object.freeze({ body }));
  return validHex64(record["revisionDigest"])
    ? success(Object.freeze({ body, revisionDigest: record["revisionDigest"] })) : malformed();
}

export function admitDeliveryProfileRevisionDraft(
  value: unknown,
): DeliveryProfileRevisionDraftAdmission {
  const parsed = parseProfile(value, false);
  return parsed.ok
    ? Object.freeze({ draft: deepFreeze({ ...parsed.value.body }), ok: true as const }) : parsed;
}

export function admitDeliveryProfileRevision(value: unknown): DeliveryProfileRevisionAdmission {
  const parsed = parseProfile(value, true); if (!parsed.ok) return parsed;
  return Object.freeze({ ok: true as const, revision: deepFreeze({
    ...parsed.value.body, revisionDigest: parsed.value.revisionDigest!,
    version: DELIVERY_PROFILE_VERSION,
  }) });
}
