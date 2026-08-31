import { createHash } from "node:crypto";

export const DELIVERY_V2_MATERIAL_KINDS = Object.freeze([
  "CAPABILITY_CATALOG",
  "DELIVERY_PROFILE",
  "DELIVERY_PROFILE_QUALIFICATION",
  "EXECUTION_ISOLATION_PROFILE",
  "VERIFICATION_RECIPE",
] as const);
export type DeliveryV2MaterialKind = (typeof DELIVERY_V2_MATERIAL_KINDS)[number];

export const DELIVERY_V2_AUTHORITY_KINDS = Object.freeze([
  "QUALIFICATION_STATUS",
  "OPERATOR_APPROVAL",
  "BUILDER_IDENTITY",
  "PROVIDER_PROFILE",
  "VERIFIER_RECEIPT",
] as const);
export type DeliveryV2AuthorityKind = (typeof DELIVERY_V2_AUTHORITY_KINDS)[number];

const namespace = (value: string): string => value.toLowerCase().replaceAll("_", "-");
export function deliveryV2Digest(domain: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256");
  for (const value of [domain, ...parts]) {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(8); length.writeBigUInt64BE(BigInt(encoded.byteLength));
    digest.update(length).update(encoded);
  }
  return digest.digest("hex");
}

export function deriveDeliveryV2MaterialAggregateId(
  projectId: string,
  kind: DeliveryV2MaterialKind,
  digest: string,
): string {
  const project = deliveryV2Digest("moe-delivery-v2-project/1", projectId);
  return `delivery-v2:${namespace(kind)}:${project}:${digest}`;
}

export function deriveDeliveryV2AuthorityAggregateId(
  projectId: string,
  kind: DeliveryV2AuthorityKind,
  subjectAddress: string,
): string {
  return `delivery-v2-authority:${namespace(kind)}:${deliveryV2Digest(
    "moe-delivery-v2-authority-address/1", projectId, subjectAddress,
  )}`;
}

export const DELIVERY_V2_MATERIAL_EVENT_TYPES = Object.freeze({
  CAPABILITY_CATALOG: "DeliveryV2CapabilityCatalogRevisionCommitted",
  DELIVERY_PROFILE: "DeliveryV2DeliveryProfileRevisionCommitted",
  DELIVERY_PROFILE_QUALIFICATION: "DeliveryV2DeliveryProfileQualificationCommitted",
  EXECUTION_ISOLATION_PROFILE: "DeliveryV2ExecutionIsolationProfileRevisionCommitted",
  VERIFICATION_RECIPE: "DeliveryV2VerificationRecipeRevisionCommitted",
} as const);
export const DELIVERY_V2_MATERIAL_COMMAND_KINDS = Object.freeze({
  CAPABILITY_CATALOG: "delivery_v2.capability_catalog.commit",
  DELIVERY_PROFILE: "delivery_v2.delivery_profile.commit",
  DELIVERY_PROFILE_QUALIFICATION: "delivery_v2.delivery_profile_qualification.commit",
  EXECUTION_ISOLATION_PROFILE: "delivery_v2.execution_isolation_profile.commit",
  VERIFICATION_RECIPE: "delivery_v2.verification_recipe.commit",
} as const);
