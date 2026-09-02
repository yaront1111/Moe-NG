import type {
  DeliveryProfileBuilderIdentity,
  DeliveryProfileIndependentVerifierReceipt,
  DeliveryProfileOperatorApprovalBinding,
  DeliveryProfileProviderProfileRef,
  DeliveryProfileQualificationEvidenceBinding,
} from "@moe/core";

import { deliveryV2Digest } from "./addresses.js";
import { snapshotDeliveryV2PlainData } from "./snapshot.js";

const HEX64 = /^[a-f0-9]{64}$/u;
const MAX_CANONICAL_BYTES = 1_048_576;
const exact = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const text = (value: unknown): value is string => typeof value === "string" && value !== "";

function stable(value: unknown, depth = 0, count = { value: 0 }): unknown {
  count.value += 1;
  if (depth > 20 || count.value > 100_000) throw new TypeError("authority binding too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
  if (Array.isArray(value)) return value.map((item) => stable(item, depth + 1, count));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("authority binding is not plain data");
  }
  return Object.fromEntries(Object.keys(value).sort().map(
    (key) => [key, stable((value as Record<string, unknown>)[key], depth + 1, count)],
  ));
}

function digest(domain: string, value: unknown): string | undefined {
  try {
    const bytes = JSON.stringify(stable(value));
    return Buffer.byteLength(bytes, "utf8") <= MAX_CANONICAL_BYTES
      ? deliveryV2Digest(domain, bytes) : undefined;
  } catch { return undefined; }
}

const APPROVAL_KEYS = Object.freeze([
  "operatorApprovalRef", "profileFamilyId", "profileId", "profileRevisionDigest",
  "profileRevisionId", "qualificationDigest", "qualificationId",
]);
const EVIDENCE_KEYS = Object.freeze([
  "benchmarkManifest", "benchmarkVerdict", "builderIdentity", "moeSourceCommit",
  "observedDigests", "profileFamilyId", "profileId", "profileRevisionDigest",
  "profileRevisionId", "providerProfileRefs", "qualificationDigest", "qualificationId",
  "requiredModelProviderCapabilities",
]);
const BUILDER_KEYS = Object.freeze(["authorityRef", "capabilityId", "principalRef"]);
const PROVIDER_KEYS = Object.freeze(["profileDigest", "profileRef", "profileRevisionId"]);
const RECEIPT_KEYS = Object.freeze([
  "observedAtEpochMs", "outcome", "profileRevisionDigest", "receiptDigest", "receiptRef",
  "recipeDigest", "recipeRef", "verifierAuthorityRef", "verifierCapabilityId", "verifierRef",
]);

export function deliveryV2OperatorApprovalBindingDigest(
  binding: DeliveryProfileOperatorApprovalBinding,
): string | undefined {
  const value = snapshotDeliveryV2PlainData(binding);
  if (value === undefined || !exact(value, APPROVAL_KEYS)
    || !text(value.operatorApprovalRef) || !text(value.profileId)
    || !text(value.profileRevisionId) || !text(value.qualificationId)
    || !HEX64.test(value.profileRevisionDigest) || !HEX64.test(value.qualificationDigest)) {
    return undefined;
  }
  return digest("moe-delivery-v2-operator-approval-binding/1", value);
}

export function deliveryV2EvidenceBindingDigest(
  binding: DeliveryProfileQualificationEvidenceBinding,
): string | undefined {
  const value = snapshotDeliveryV2PlainData(binding);
  if (value === undefined || !exact(value, EVIDENCE_KEYS)
    || !text(value.profileId) || !text(value.profileRevisionId)
    || !text(value.qualificationId) || !HEX64.test(value.profileRevisionDigest)
    || !HEX64.test(value.qualificationDigest)) return undefined;
  return digest("moe-delivery-v2-qualification-evidence-binding/1", value);
}

export function deliveryV2BuilderIdentityDigest(
  builder: DeliveryProfileBuilderIdentity,
): string | undefined {
  const value = snapshotDeliveryV2PlainData(builder);
  if (value === undefined || !exact(value, BUILDER_KEYS)
    || !text(value.authorityRef) || !text(value.capabilityId) || !text(value.principalRef)) {
    return undefined;
  }
  return digest("moe-delivery-v2-builder-identity/1", value);
}

export function deliveryV2ProviderProfileDigest(
  profile: DeliveryProfileProviderProfileRef,
): string | undefined {
  const value = snapshotDeliveryV2PlainData(profile);
  if (value === undefined || !exact(value, PROVIDER_KEYS)
    || !text(value.profileRef) || !text(value.profileRevisionId)
    || !HEX64.test(value.profileDigest)) return undefined;
  return digest("moe-delivery-v2-provider-profile/1", value);
}

export function deliveryV2VerifierReceiptDigest(
  receipt: DeliveryProfileIndependentVerifierReceipt,
): string | undefined {
  const value = snapshotDeliveryV2PlainData(receipt);
  if (value === undefined || !exact(value, RECEIPT_KEYS)
    || value.outcome !== "PASS" || !Number.isSafeInteger(value.observedAtEpochMs)
    || value.observedAtEpochMs < 0 || !text(value.receiptRef)
    || !HEX64.test(value.receiptDigest) || !HEX64.test(value.profileRevisionDigest)
    || !HEX64.test(value.recipeDigest)) return undefined;
  return digest("moe-delivery-v2-verifier-receipt/1", value);
}
