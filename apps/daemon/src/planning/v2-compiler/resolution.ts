import {
  encodeDeliveryProfileQualification,
  encodeDeliveryProfileRevision,
  encodeExecutionIsolationProfileRevision,
} from "@moe/core";
import {
  v2CompilerRefusal,
  type V2CompilerRefusal,
  type V2CriterionCategory,
  type V2CompiledRecipeBinding, type V2CompiledVerificationRecipeBinding,
} from "./contracts.js";
import { resolutionBindingMaterialMismatch } from "./resolution-materials.js";
import {
  resolutionQualificationStatus, resolutionQualificationValid,
} from "./resolution-qualification.js";
import { readBuildRecipe, readVerificationRecipes } from "./resolution-recipes.js";
import { exact, materialDigest, record, text } from "./snapshot.js";

const CATEGORIES = new Set<string>([
  "DEPLOYMENT", "FUNCTIONAL", "NON_FUNCTIONAL", "SECURITY_PRIVACY",
  "TECHNOLOGY", "UX_ACCESSIBILITY",
]);
const WITNESS_KEYS = Object.freeze([
  "atEpochMs", "builderBinding", "catalogId", "catalogRevisionDigest",
  "catalogRevisionId", "deliveryProfileQualification", "deliveryProfileRevision",
  "deliveryProfileQualificationStatus", "requiredCriterionCategories", "verifierBindings",
]);
const BINDING_KEYS = Object.freeze([
  "capability", "executionIsolationProfileRevision", "verificationRecipeRevisions",
]);
export interface AdmittedCapabilityBinding {
  readonly authorityKind: "BUILDER" | "VERIFIER";
  readonly capabilityId: string;
  readonly criterionCategories: readonly V2CriterionCategory[];
  readonly executionIsolationProfileRevisionDigest: string;
  readonly executionIsolationProfileRevisionId: string;
  readonly readScopes: readonly string[];
  readonly requiredImageDigests: readonly string[];
  readonly requiredToolDigests: readonly string[];
  readonly resourceScopes: readonly Readonly<{ kind: string; ref: string }>[];
  readonly roles: readonly string[];
  readonly sourceSnapshotDigest: string;
  readonly verificationRecipes: readonly V2CompiledVerificationRecipeBinding[];
  readonly verifierCapabilityIds: readonly string[];
  readonly writeScopes: readonly string[];
}
export interface AdmittedResolution {
  readonly atEpochMs: number;
  readonly buildRecipe: V2CompiledRecipeBinding;
  readonly builder: AdmittedCapabilityBinding;
  readonly catalogId: string;
  readonly catalogRevisionDigest: string;
  readonly catalogRevisionId: string;
  readonly deliveryProfileQualificationDigest: string;
  readonly deliveryProfileQualificationId: string;
  readonly deliveryProfileQualificationStatusDigest: string;
  readonly deliveryProfileQualificationStatusRef: string;
  readonly deliveryProfileRevisionDigest: string;
  readonly deliveryProfileId: string;
  readonly deliveryProfileRevisionId: string;
  readonly requiredCriterionCategories: readonly V2CriterionCategory[];
  readonly verifiers: readonly AdmittedCapabilityBinding[];
}
type Admission = Readonly<{ fact: AdmittedResolution; ok: true }> | V2CompilerRefusal;
const refuse = (code: Parameters<typeof v2CompilerRefusal>[0],
  layer: Parameters<typeof v2CompilerRefusal>[1]): V2CompilerRefusal =>
  v2CompilerRefusal(code, layer);
function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => !text(item))) return undefined;
  const result = value as string[];
  return new Set(result).size === result.length ? Object.freeze([...result].sort()) : undefined;
}
function categories(value: unknown): readonly V2CriterionCategory[] | undefined {
  const values = strings(value);
  return values !== undefined && values.length > 0 && values.every((item) => CATEGORIES.has(item))
    ? values as readonly V2CriterionCategory[] : undefined;
}

function resourceScopes(value: unknown):
readonly Readonly<{ kind: string; ref: string }>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Readonly<{ kind: string; ref: string }>[] = [];
  for (const item of value) {
    if (!exact(item, ["kind", "ref"]) || !text(item["kind"]) || !text(item["ref"])) {
      return undefined;
    }
    result.push(Object.freeze({ kind: item["kind"], ref: item["ref"] }));
  }
  return Object.freeze(result);
}

function recipeRefs(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const candidate of value) {
    if (!exact(candidate, ["recipeRevisionDigest", "recipeRevisionId"])
      || !text(candidate["recipeRevisionId"])
      || !materialDigest(candidate["recipeRevisionDigest"])) return undefined;
    ids.push(`${candidate["recipeRevisionId"]}\0${candidate["recipeRevisionDigest"]}`);
  }
  return new Set(ids).size === ids.length ? Object.freeze(ids.sort()) : undefined;
}

function entryBinding(value: unknown, kind: "BUILDER" | "VERIFIER",
  profile: Readonly<Record<string, unknown>>): AdmittedCapabilityBinding | undefined {
  if (!exact(value, BINDING_KEYS)) return undefined;
  const capability = record(value["capability"]);
  const execution = record(value["executionIsolationProfileRevision"]);
  if (capability === undefined || execution === undefined
    || capability["authorityKind"] !== kind || !text(capability["capabilityId"])
    || !text(execution["revisionId"]) || !materialDigest(execution["revisionDigest"])
    || !materialDigest(execution["sourceSnapshotDigest"])
    || execution["purpose"] !== (kind === "BUILDER" ? "BUILD_AGENT" : "FRESH_VERIFIER")
    || capability["deliveryProfileRevisionDigest"] !== profile["revisionDigest"]
    || capability["deliveryProfileRevisionId"] !== profile["revisionId"]
    || capability["deliveryProfileFamilyId"] !== profile["profileFamilyId"]
    || capability["executionIsolationProfileRevisionDigest"] !== execution["revisionDigest"]
    || capability["executionIsolationProfileRevisionId"] !== execution["revisionId"]
    || execution["deliveryProfileRevisionDigest"] !== profile["revisionDigest"]
    || !encodeExecutionIsolationProfileRevision(execution).ok) return undefined;
  const criterionCategories = categories(capability["criterionCategories"]);
  const verifierCapabilityIds = strings(capability["verifierCapabilityIds"]);
  const readScopes = strings(capability["readScopes"]);
  const writeScopes = strings(capability["writeScopes"]);
  const images = strings(capability["requiredImageDigests"]);
  const tools = strings(capability["requiredToolDigests"]);
  const resources = resourceScopes(capability["resourceScopes"]);
  const roles = strings(capability["roles"]);
  const expectedRecipes = recipeRefs(capability["verificationRecipeRevisions"]);
  const recipes = readVerificationRecipes(value["verificationRecipeRevisions"], execution);
  if (criterionCategories === undefined || verifierCapabilityIds === undefined
    || readScopes === undefined || writeScopes === undefined || images === undefined
    || tools === undefined || resources === undefined || roles === undefined
    || expectedRecipes === undefined || recipes === undefined) return undefined;
  const actualRecipes = recipes.map((item) => `${item.revisionId}\0${item.revisionDigest}`);
  if (expectedRecipes.length !== actualRecipes.length
    || !expectedRecipes.every((item, index) => item === actualRecipes[index])) return undefined;
  return Object.freeze({ authorityKind: kind, capabilityId: capability["capabilityId"],
    criterionCategories, executionIsolationProfileRevisionDigest: execution["revisionDigest"],
    executionIsolationProfileRevisionId: execution["revisionId"], readScopes,
    requiredImageDigests: images, requiredToolDigests: tools, resourceScopes: resources, roles,
    sourceSnapshotDigest: execution["sourceSnapshotDigest"], verificationRecipes: recipes,
    verifierCapabilityIds, writeScopes });
}

export function admitResolutionFact(value: unknown): Admission {
  if (!exact(value, WITNESS_KEYS) || !Number.isSafeInteger(value["atEpochMs"])
    || (value["atEpochMs"] as number) < 0 || Object.is(value["atEpochMs"], -0)
    || !text(value["catalogId"]) || !text(value["catalogRevisionId"])) return refuse(
    "V2_COMPILER_CAPABILITY_UNRESOLVED", "V2_COMPILER_CAPABILITY_BINDING",
  );
  if (!materialDigest(value["catalogRevisionDigest"])) return refuse(
    "V2_COMPILER_MATERIAL_DIGEST_UNBOUND", "V2_COMPILER_MATERIAL_BINDING",
  );
  const profile = record(value["deliveryProfileRevision"]);
  const qualification = record(value["deliveryProfileQualification"]);
  if (profile === undefined || qualification === undefined || !text(profile["profileFamilyId"])
    || !text(profile["profileId"]) || !text(profile["revisionId"])
    || !materialDigest(profile["revisionDigest"])) return refuse(
    "V2_COMPILER_MATERIAL_DIGEST_UNBOUND", "V2_COMPILER_MATERIAL_BINDING",
  );
  const build = readBuildRecipe(record(profile["recipes"])?.["build"]);
  if (build === undefined) return refuse(
    "V2_COMPILER_BUILD_RECIPE_MISSING", "V2_COMPILER_RECIPE_BINDING",
  );
  if (!encodeDeliveryProfileRevision(profile).ok) return refuse(
    "V2_COMPILER_MATERIAL_DIGEST_UNBOUND", "V2_COMPILER_MATERIAL_BINDING",
  );
  const verifierValues = Array.isArray(value["verifierBindings"])
    ? value["verifierBindings"] : [];
  if ([value["builderBinding"], ...verifierValues].some(
    (binding) => resolutionBindingMaterialMismatch(binding, profile),
  )) return refuse("V2_COMPILER_MATERIAL_DIGEST_UNBOUND", "V2_COMPILER_MATERIAL_BINDING");
  const builder = entryBinding(value["builderBinding"], "BUILDER", profile);
  const required = categories(value["requiredCriterionCategories"]);
  if (builder === undefined || required === undefined) return refuse(
    "V2_COMPILER_CAPABILITY_UNRESOLVED", "V2_COMPILER_CAPABILITY_BINDING",
  );
  for (const candidate of verifierValues) {
    const binding = record(candidate); const capability = record(binding?.["capability"]);
    if (capability?.["capabilityId"] === builder.capabilityId) return refuse(
      "V2_COMPILER_IDENTITY_COLLISION", "V2_COMPILER_CAPABILITY_BINDING",
    );
  }
  if (!resolutionQualificationValid(qualification, value["atEpochMs"] as number,
    profile, builder.capabilityId) || !encodeDeliveryProfileQualification(qualification).ok) return refuse(
    "V2_COMPILER_DELIVERY_PROFILE_UNQUALIFIED", "V2_COMPILER_CAPABILITY_BINDING",
  );
  const qualificationStatus = resolutionQualificationStatus(
    value["deliveryProfileQualificationStatus"], qualification,
  );
  if (qualificationStatus === undefined) return refuse(
    "V2_COMPILER_DELIVERY_PROFILE_UNQUALIFIED", "V2_COMPILER_CAPABILITY_BINDING",
  );
  if (!Array.isArray(value["verifierBindings"]) || value["verifierBindings"].length === 0) {
    return refuse("V2_COMPILER_VERIFICATION_RECIPE_MISSING", "V2_COMPILER_RECIPE_BINDING");
  }
  const verifiers: AdmittedCapabilityBinding[] = [];
  for (const candidate of value["verifierBindings"]) {
    const verifier = entryBinding(candidate, "VERIFIER", profile);
    if (verifier === undefined) return refuse(
      "V2_COMPILER_VERIFICATION_RECIPE_MISSING", "V2_COMPILER_RECIPE_BINDING",
    );
    if (verifier.capabilityId === builder.capabilityId) return refuse(
      "V2_COMPILER_IDENTITY_COLLISION", "V2_COMPILER_CAPABILITY_BINDING",
    );
    verifiers.push(verifier);
  }
  const verifierIds = verifiers.map((item) => item.capabilityId).sort();
  const receipts = qualification["independentVerifierReceipts"];
  if (!Array.isArray(receipts) || receipts.length === 0) return refuse(
    "V2_COMPILER_DELIVERY_PROFILE_UNQUALIFIED", "V2_COMPILER_CAPABILITY_BINDING",
  );
  const receiptIds = [...new Set(receipts.map((item) => record(item)?.["verifierCapabilityId"]))];
  if (receiptIds.some((id) => !text(id)) || verifierIds.length !== builder.verifierCapabilityIds.length
    || verifierIds.some((id, index) => id !== builder.verifierCapabilityIds[index])
    || receiptIds.length !== verifierIds.length
    || !verifierIds.every((id) => receiptIds.includes(id))
    || verifiers.some((item) => item.verifierCapabilityIds.length !== 0)) return refuse(
    "V2_COMPILER_IDENTITY_COLLISION", "V2_COMPILER_CAPABILITY_BINDING",
  );
  return Object.freeze({ fact: Object.freeze({
    atEpochMs: value["atEpochMs"] as number, buildRecipe: build, builder,
    catalogId: value["catalogId"], catalogRevisionDigest: value["catalogRevisionDigest"],
    catalogRevisionId: value["catalogRevisionId"],
    deliveryProfileQualificationDigest: qualification.qualificationDigest,
    deliveryProfileQualificationId: qualification.qualificationId,
    deliveryProfileQualificationStatusDigest:
      qualificationStatus.statusDigest,
    deliveryProfileQualificationStatusRef:
      qualificationStatus.statusRef,
    deliveryProfileRevisionDigest: profile["revisionDigest"],
    deliveryProfileId: profile["profileId"],
    deliveryProfileRevisionId: profile["revisionId"],
    requiredCriterionCategories: required, verifiers: Object.freeze(verifiers),
  }), ok: true as const });
}
