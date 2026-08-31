import {
  CAPABILITY_CATALOG_LIMITS,
  type DeliveryProfileBuilderIdentity,
  type DeliveryProfileIndependentVerifierReceipt,
  type DeliveryProfileOperatorApprovalBinding,
  type DeliveryProfileProviderProfileRef,
  type DeliveryProfileQualificationEvidenceBinding,
  type DeliveryProfileQualificationStatusBinding,
} from "@moe/core";

import {
  deliveryV2BuilderIdentityDigest,
  deliveryV2EvidenceBindingDigest,
  deliveryV2OperatorApprovalBindingDigest,
  deliveryV2ProviderProfileDigest,
  deliveryV2VerifierReceiptDigest,
} from "./authority-binding-digests.js";
import type {
  DeliveryV2AuthorityPrincipalBindings,
  DeliveryV2BuilderIdentityPrincipalBinding,
  DeliveryV2ProviderProfilePrincipalBinding,
  DeliveryV2QualificationStatusInput,
  DeliveryV2VerifierReceiptPrincipalBinding,
} from "./contracts.js";
import { snapshotDeliveryV2PlainData } from "./snapshot.js";

const CONFIG_KEYS = Object.freeze([
  "builderIdentityPrincipals", "operatorApprovalPrincipalId", "providerProfilePrincipals",
  "qualificationStatusPrincipalId", "verifierReceiptPrincipals",
]);
const BUILDER_KEYS = Object.freeze(["authorityRef", "capabilityId", "principalId"]);
const PROVIDER_KEYS = Object.freeze(["principalId", "profileRef"]);
const STATUS_KEYS = Object.freeze(["qualificationDigest", "qualificationId"]);
const STATUS_INPUT_KEYS = Object.freeze([
  "qualificationDigest", "qualificationId", "status", "statusRef",
]);
const VERIFIER_KEYS = BUILDER_KEYS;
const HEX64 = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
type RecordValue = Readonly<Record<string, unknown>>;
const exact = (value: unknown, keys: readonly string[]): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value !== ""
  && encoder.encode(value).byteLength <= CAPABILITY_CATALOG_LIMITS.maxIdBytes;

function snapshotClaim<T>(value: unknown, digest: (safe: T) => string | undefined): T | undefined {
  const safe = snapshotDeliveryV2PlainData(value) as T | undefined;
  return safe !== undefined && digest(safe) !== undefined ? safe : undefined;
}

export const admitDeliveryV2OperatorApprovalBinding = (value: unknown) => snapshotClaim<
DeliveryProfileOperatorApprovalBinding>(value, deliveryV2OperatorApprovalBindingDigest);
export const admitDeliveryV2EvidenceBinding = (value: unknown) => snapshotClaim<
DeliveryProfileQualificationEvidenceBinding>(value, deliveryV2EvidenceBindingDigest);
export const admitDeliveryV2BuilderIdentity = (value: unknown) => snapshotClaim<
DeliveryProfileBuilderIdentity>(value, deliveryV2BuilderIdentityDigest);
export const admitDeliveryV2ProviderProfile = (value: unknown) => snapshotClaim<
DeliveryProfileProviderProfileRef>(value, deliveryV2ProviderProfileDigest);
export const admitDeliveryV2VerifierReceipt = (value: unknown) => snapshotClaim<
DeliveryProfileIndependentVerifierReceipt>(value, deliveryV2VerifierReceiptDigest);

export function admitDeliveryV2QualificationStatusBinding(
  value: unknown,
): DeliveryProfileQualificationStatusBinding | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  return exact(safe, STATUS_KEYS) && text(safe["qualificationId"])
    && typeof safe["qualificationDigest"] === "string" && HEX64.test(safe["qualificationDigest"])
    ? safe as unknown as DeliveryProfileQualificationStatusBinding : undefined;
}

export function admitDeliveryV2QualificationStatusInput(
  value: unknown,
): DeliveryV2QualificationStatusInput | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  return exact(safe, STATUS_INPUT_KEYS) && text(safe["qualificationId"])
    && text(safe["statusRef"]) && (safe["status"] === "CURRENT" || safe["status"] === "REVOKED")
    && typeof safe["qualificationDigest"] === "string" && HEX64.test(safe["qualificationDigest"])
    ? safe as unknown as DeliveryV2QualificationStatusInput : undefined;
}

function tupleCompare(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

function canonicalList(value: unknown, keys: readonly string[], order: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length > CAPABILITY_CATALOG_LIMITS.maxEntries) return false;
  let previous: readonly string[] | undefined;
  for (const item of value) {
    if (!exact(item, keys) || !keys.every((key) => text(item[key]))) return false;
    const current = order.map((key) => item[key] as string);
    if (previous !== undefined && tupleCompare(previous, current) >= 0) return false;
    previous = current;
  }
  return true;
}

function principal<T>(value: unknown, keys: readonly string[]): T | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  return exact(safe, keys) && keys.every((key) => text(safe[key])) ? safe as T : undefined;
}

export const admitDeliveryV2BuilderPrincipal = (value: unknown) => principal<
DeliveryV2BuilderIdentityPrincipalBinding>(value, BUILDER_KEYS);
export const admitDeliveryV2ProviderPrincipal = (value: unknown) => principal<
DeliveryV2ProviderProfilePrincipalBinding>(value, PROVIDER_KEYS);
export const admitDeliveryV2VerifierPrincipal = (value: unknown) => principal<
DeliveryV2VerifierReceiptPrincipalBinding>(value, VERIFIER_KEYS);

export function admitDeliveryV2AuthorityPrincipalBindings(
  value: unknown,
): DeliveryV2AuthorityPrincipalBindings | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (!exact(safe, CONFIG_KEYS) || !text(safe["operatorApprovalPrincipalId"])
    || !text(safe["qualificationStatusPrincipalId"])
    || !canonicalList(safe["builderIdentityPrincipals"], BUILDER_KEYS, BUILDER_KEYS)
    || !canonicalList(safe["providerProfilePrincipals"], PROVIDER_KEYS,
      ["profileRef", "principalId"])
    || !canonicalList(safe["verifierReceiptPrincipals"], VERIFIER_KEYS, VERIFIER_KEYS)) {
    return undefined;
  }
  const builderPrincipalIds = new Set(
    (safe["builderIdentityPrincipals"] as readonly DeliveryV2BuilderIdentityPrincipalBinding[])
      .map((binding) => binding.principalId),
  );
  if ((safe["verifierReceiptPrincipals"] as readonly DeliveryV2VerifierReceiptPrincipalBinding[])
    .some((binding) => builderPrincipalIds.has(binding.principalId))) return undefined;
  return safe as unknown as DeliveryV2AuthorityPrincipalBindings;
}

export const admitDeliveryV2ProjectId = (value: unknown): string | undefined =>
  text(value) ? value : undefined;
export const admitDeliveryV2PrincipalId = admitDeliveryV2ProjectId;
