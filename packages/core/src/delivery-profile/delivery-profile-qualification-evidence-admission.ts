import {
  DELIVERY_PROFILE_LIMITS,
  type DeliveryProfileBenchmarkManifestRef,
  type DeliveryProfileBuilderIdentity,
  type DeliveryProfileIndependentVerifierReceipt,
  type DeliveryProfileObservedDigests,
  type DeliveryProfileProviderProfileRef,
  type DeliveryProfileQualificationInvalidation,
} from "./delivery-profile-contract.js";
import {
  exact, malformed, readNullableRef, readSortedItems, readSortedRefs, readText, success,
  validHex64, type ReadResult,
} from "./delivery-profile-admission-primitives.js";

const RECEIPT_KEYS = Object.freeze([
  "observedAtEpochMs", "outcome", "profileRevisionDigest", "receiptDigest", "receiptRef",
  "recipeDigest", "recipeRef", "verifierAuthorityRef", "verifierCapabilityId", "verifierRef",
]);
const BUILDER_KEYS = Object.freeze(["authorityRef", "capabilityId", "principalRef"]);
const MANIFEST_KEYS = Object.freeze([
  "benchmarkCorpusDigest", "benchmarkCorpusRef", "manifestDigest", "manifestRef",
]);
const OBSERVED_KEYS = Object.freeze([
  "browserDigest", "composeDigest", "dockerDigest", "gitDigest", "imageDigests",
  "nodeDigest", "pnpmDigest",
]);
const PROVIDER_KEYS = Object.freeze(["profileDigest", "profileRef", "profileRevisionId"]);
const INVALIDATION_KEYS = Object.freeze([
  "invalidatedAtEpochMs", "invalidatedByAuthorityRef", "invalidationDigest",
  "invalidationReason", "invalidationRef", "supersedingQualificationId",
]);
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;

export const validEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);

function readReceipt(value: unknown): ReadResult<DeliveryProfileIndependentVerifierReceipt> {
  if (!exact(value, RECEIPT_KEYS) || value["outcome"] !== "PASS"
    || !validHex64(value["receiptDigest"]) || !validHex64(value["recipeDigest"])
    || !validHex64(value["profileRevisionDigest"]) || !validEpoch(value["observedAtEpochMs"])) {
    return malformed();
  }
  const receiptRef = readText(value["receiptRef"]); const recipeRef = readText(value["recipeRef"]);
  const verifierAuthority = readText(value["verifierAuthorityRef"]);
  const verifierCapability = readText(value["verifierCapabilityId"]);
  const verifierRef = readText(value["verifierRef"]);
  if (!receiptRef.ok) return receiptRef; if (!recipeRef.ok) return recipeRef;
  if (!verifierAuthority.ok) return verifierAuthority;
  if (!verifierCapability.ok) return verifierCapability;
  if (!verifierRef.ok) return verifierRef;
  return success(Object.freeze({
    observedAtEpochMs: value["observedAtEpochMs"], outcome: "PASS" as const,
    profileRevisionDigest: value["profileRevisionDigest"], receiptDigest: value["receiptDigest"],
    receiptRef: receiptRef.value, recipeDigest: value["recipeDigest"],
    recipeRef: recipeRef.value, verifierAuthorityRef: verifierAuthority.value,
    verifierCapabilityId: verifierCapability.value, verifierRef: verifierRef.value,
  }));
}

export function readBuilderIdentity(value: unknown): ReadResult<DeliveryProfileBuilderIdentity> {
  if (!exact(value, BUILDER_KEYS)) return malformed();
  const authorityRef = readText(value["authorityRef"]);
  const capabilityId = readText(value["capabilityId"]);
  const principalRef = readText(value["principalRef"]);
  if (!authorityRef.ok) return authorityRef; if (!capabilityId.ok) return capabilityId;
  if (!principalRef.ok) return principalRef;
  return success(Object.freeze({
    authorityRef: authorityRef.value, capabilityId: capabilityId.value,
    principalRef: principalRef.value,
  }));
}

export const readIndependentVerifierReceipts = (
  value: unknown,
): ReadResult<readonly DeliveryProfileIndependentVerifierReceipt[]> => readSortedItems(
  value, DELIVERY_PROFILE_LIMITS.maxVerifierReceipts, true, readReceipt,
  (item) => item.receiptRef,
);

export function readBenchmarkManifest(
  value: unknown,
): ReadResult<DeliveryProfileBenchmarkManifestRef> {
  if (!exact(value, MANIFEST_KEYS) || !validHex64(value["benchmarkCorpusDigest"])
    || !validHex64(value["manifestDigest"])) return malformed();
  const corpusRef = readText(value["benchmarkCorpusRef"]);
  const manifestRef = readText(value["manifestRef"]);
  if (!corpusRef.ok) return corpusRef; if (!manifestRef.ok) return manifestRef;
  return success(Object.freeze({
    benchmarkCorpusDigest: value["benchmarkCorpusDigest"], benchmarkCorpusRef: corpusRef.value,
    manifestDigest: value["manifestDigest"], manifestRef: manifestRef.value,
  }));
}

export function readObservedDigests(value: unknown): ReadResult<DeliveryProfileObservedDigests> {
  if (!exact(value, OBSERVED_KEYS) || ![
    value["browserDigest"], value["composeDigest"], value["dockerDigest"],
    value["gitDigest"], value["nodeDigest"], value["pnpmDigest"],
  ].every(validHex64)) return malformed();
  const images = readSortedRefs(value["imageDigests"], DELIVERY_PROFILE_LIMITS.maxRefsPerKind, false);
  if (!images.ok) return images;
  if (!images.value.every((digest) => OCI_DIGEST.test(digest))) return malformed();
  return success(Object.freeze({
    browserDigest: value["browserDigest"] as string,
    composeDigest: value["composeDigest"] as string,
    dockerDigest: value["dockerDigest"] as string, gitDigest: value["gitDigest"] as string,
    imageDigests: images.value, nodeDigest: value["nodeDigest"] as string,
    pnpmDigest: value["pnpmDigest"] as string,
  }));
}

function readProvider(value: unknown): ReadResult<DeliveryProfileProviderProfileRef> {
  if (!exact(value, PROVIDER_KEYS) || !validHex64(value["profileDigest"])) return malformed();
  const profileRef = readText(value["profileRef"]);
  const revisionId = readText(value["profileRevisionId"]);
  if (!profileRef.ok) return profileRef; if (!revisionId.ok) return revisionId;
  return success(Object.freeze({
    profileDigest: value["profileDigest"], profileRef: profileRef.value,
    profileRevisionId: revisionId.value,
  }));
}

export const readProviderProfileRefs = (
  value: unknown,
): ReadResult<readonly DeliveryProfileProviderProfileRef[]> => readSortedItems(
  value, DELIVERY_PROFILE_LIMITS.maxRefsPerKind, false, readProvider, (item) => item.profileRef,
);

export function readInvalidation(
  value: unknown,
): ReadResult<DeliveryProfileQualificationInvalidation | null> {
  if (value === null) return success(null);
  if (!exact(value, INVALIDATION_KEYS) || !validEpoch(value["invalidatedAtEpochMs"])
    || !validHex64(value["invalidationDigest"])) return malformed();
  const authority = readText(value["invalidatedByAuthorityRef"]);
  const reason = readText(value["invalidationReason"], DELIVERY_PROFILE_LIMITS.maxStatementBytes);
  const invalidationRef = readText(value["invalidationRef"]);
  const superseding = readNullableRef(value["supersedingQualificationId"]);
  if (!authority.ok) return authority; if (!reason.ok) return reason;
  if (!invalidationRef.ok) return invalidationRef; if (!superseding.ok) return superseding;
  return success(Object.freeze({
    invalidatedAtEpochMs: value["invalidatedAtEpochMs"],
    invalidatedByAuthorityRef: authority.value, invalidationDigest: value["invalidationDigest"],
    invalidationReason: reason.value, invalidationRef: invalidationRef.value,
    supersedingQualificationId: superseding.value,
  }));
}
