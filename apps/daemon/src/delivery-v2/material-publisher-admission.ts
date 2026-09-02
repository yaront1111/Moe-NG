import { CAPABILITY_CATALOG_LIMITS } from "@moe/core";

import type { DeliveryV2MaterialPublisherPrincipalBindings } from "./contracts.js";
import { snapshotDeliveryV2PlainData } from "./snapshot.js";

const KEYS = Object.freeze([
  "capabilityCatalogPrincipalId", "deliveryProfilePrincipalId",
  "deliveryProfileQualificationPrincipalId", "executionIsolationProfilePrincipalId",
  "verificationRecipePrincipalId",
]);
const encoder = new TextEncoder();
const principal = (value: unknown): value is string => typeof value === "string" && value !== ""
  && encoder.encode(value).byteLength <= CAPABILITY_CATALOG_LIMITS.maxIdBytes;

export const admitDeliveryV2MaterialPublisherPrincipalId = (
  value: unknown,
): string | undefined => principal(value) ? value : undefined;

/** Captures the exact trusted issuer for each independently persisted material kind. */
export function admitDeliveryV2MaterialPublisherPrincipals(
  value: unknown,
): DeliveryV2MaterialPublisherPrincipalBindings | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (safe === undefined || safe === null || typeof safe !== "object" || Array.isArray(safe)
    || Object.keys(safe).length !== KEYS.length
    || !KEYS.every((key) => Object.hasOwn(safe, key)
      && principal((safe as Record<string, unknown>)[key]))) return undefined;
  return safe as DeliveryV2MaterialPublisherPrincipalBindings;
}
