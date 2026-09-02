import {
  CAPABILITY_CATALOG_VERSION,
  DELIVERY_PROFILE_QUALIFICATION_VERSION,
  DELIVERY_PROFILE_VERSION,
  EXECUTION_ISOLATION_PROFILE_VERSION,
  VERIFICATION_RECIPE_VERSION,
  decodeCapabilityCatalogRevisionBytes,
  decodeDeliveryProfileQualificationBytes,
  decodeDeliveryProfileRevisionBytes,
  decodeExecutionIsolationProfileRevisionBytes,
  decodeVerificationRecipeRevisionBytes,
  encodeCapabilityCatalogRevision,
  encodeDeliveryProfileQualification,
  encodeDeliveryProfileRevision,
  encodeExecutionIsolationProfileRevision,
  encodeVerificationRecipeRevision,
  type CapabilityCatalogRevision,
  type DeliveryProfileQualification,
  type DeliveryProfileRevision,
  type ExecutionIsolationProfileRevision,
  type VerificationRecipeRevision,
} from "@moe/core";

import type { DeliveryV2MaterialKind } from "./addresses.js";

export type DeliveryV2Material = CapabilityCatalogRevision | DeliveryProfileRevision
  | DeliveryProfileQualification | ExecutionIsolationProfileRevision
  | VerificationRecipeRevision;
export interface DeliveryV2MaterialIdentity {
  readonly digest: string;
  readonly primaryId: string;
  readonly revisionId: string;
}
export interface DeliveryV2EncodedMaterial {
  readonly bytes: Uint8Array;
  readonly domainSchemaVersion: string;
  readonly identity: DeliveryV2MaterialIdentity;
  readonly value: DeliveryV2Material;
}
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

function identity(kind: DeliveryV2MaterialKind, value: DeliveryV2Material): DeliveryV2MaterialIdentity {
  switch (kind) {
    case "CAPABILITY_CATALOG": {
      const item = value as CapabilityCatalogRevision;
      return Object.freeze({ digest: item.revisionDigest,
        primaryId: item.catalogId, revisionId: item.revisionId });
    }
    case "DELIVERY_PROFILE": {
      const item = value as DeliveryProfileRevision;
      return Object.freeze({ digest: item.revisionDigest,
        primaryId: item.profileId, revisionId: item.revisionId });
    }
    case "DELIVERY_PROFILE_QUALIFICATION": {
      const item = value as DeliveryProfileQualification;
      return Object.freeze({ digest: item.qualificationDigest,
        primaryId: item.qualificationId, revisionId: item.qualificationId });
    }
    case "EXECUTION_ISOLATION_PROFILE": {
      const item = value as ExecutionIsolationProfileRevision;
      return Object.freeze({ digest: item.revisionDigest,
        primaryId: item.profileId, revisionId: item.revisionId });
    }
    case "VERIFICATION_RECIPE": {
      const item = value as VerificationRecipeRevision;
      return Object.freeze({ digest: item.revisionDigest,
        primaryId: item.recipeId, revisionId: item.revisionId });
    }
  }
}

function encodedBytes(kind: DeliveryV2MaterialKind, value: unknown): Uint8Array | undefined {
  const result = kind === "CAPABILITY_CATALOG" ? encodeCapabilityCatalogRevision(value)
    : kind === "DELIVERY_PROFILE" ? encodeDeliveryProfileRevision(value)
    : kind === "DELIVERY_PROFILE_QUALIFICATION" ? encodeDeliveryProfileQualification(value)
    : kind === "EXECUTION_ISOLATION_PROFILE"
      ? encodeExecutionIsolationProfileRevision(value)
      : encodeVerificationRecipeRevision(value);
  return result.ok ? result.bytes : undefined;
}

function decodedValue(kind: DeliveryV2MaterialKind, bytes: Uint8Array): DeliveryV2Material | undefined {
  if (kind === "CAPABILITY_CATALOG") {
    const result = decodeCapabilityCatalogRevisionBytes(bytes);
    return result.ok ? result.revision : undefined;
  }
  if (kind === "DELIVERY_PROFILE") {
    const result = decodeDeliveryProfileRevisionBytes(bytes);
    return result.ok ? result.revision : undefined;
  }
  if (kind === "DELIVERY_PROFILE_QUALIFICATION") {
    const result = decodeDeliveryProfileQualificationBytes(bytes);
    return result.ok ? result.qualification : undefined;
  }
  if (kind === "EXECUTION_ISOLATION_PROFILE") {
    const result = decodeExecutionIsolationProfileRevisionBytes(bytes);
    return result.ok ? result.revision : undefined;
  }
  const result = decodeVerificationRecipeRevisionBytes(bytes);
  return result.ok ? result.revision : undefined;
}

function schemaVersion(kind: DeliveryV2MaterialKind): string {
  switch (kind) {
    case "CAPABILITY_CATALOG": return CAPABILITY_CATALOG_VERSION;
    case "DELIVERY_PROFILE": return DELIVERY_PROFILE_VERSION;
    case "DELIVERY_PROFILE_QUALIFICATION": return DELIVERY_PROFILE_QUALIFICATION_VERSION;
    case "EXECUTION_ISOLATION_PROFILE": return EXECUTION_ISOLATION_PROFILE_VERSION;
    case "VERIFICATION_RECIPE": return VERIFICATION_RECIPE_VERSION;
  }
}

/** Encoding then decoding makes writers persist the same admitted snapshot readers later see. */
export function encodeDeliveryV2Material(
  kind: DeliveryV2MaterialKind,
  value: unknown,
): DeliveryV2EncodedMaterial | undefined {
  const bytes = encodedBytes(kind, value); if (bytes === undefined) return undefined;
  const decoded = decodedValue(kind, bytes); if (decoded === undefined) return undefined;
  return Object.freeze({ bytes, domainSchemaVersion: schemaVersion(kind),
    identity: identity(kind, decoded), value: decoded });
}

/** Every read traverses the owning core decoder and proves byte-for-byte canonical re-encoding. */
export function decodeDeliveryV2Material(
  kind: DeliveryV2MaterialKind,
  bytes: Uint8Array,
): DeliveryV2EncodedMaterial | undefined {
  const value = decodedValue(kind, bytes); if (value === undefined) return undefined;
  const canonical = encodedBytes(kind, value);
  if (canonical === undefined || !sameBytes(canonical, bytes)) return undefined;
  return Object.freeze({ bytes: canonical, domainSchemaVersion: schemaVersion(kind),
    identity: identity(kind, value), value });
}
