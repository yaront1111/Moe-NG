import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";

import {
  admitCapabilityCatalogRevision,
  admitCapabilityCatalogRevisionDraft,
} from "./capability-catalog-admission.js";
import {
  CAPABILITY_CATALOG_DIGEST_DOMAIN,
  CAPABILITY_CATALOG_LIMITS,
  CAPABILITY_CATALOG_VERSION,
  capabilityCatalogRefusal,
  type CapabilityCatalogRefusal,
  type CapabilityCatalogRevision,
} from "./capability-catalog-contract.js";

export {
  CAPABILITY_CATALOG_AUTHORITY_KINDS,
  CAPABILITY_CATALOG_CODES,
  CAPABILITY_CATALOG_CRITERION_CATEGORIES,
  CAPABILITY_CATALOG_DELIVERY_PROFILE_FAMILY_IDS,
  CAPABILITY_CATALOG_DIGEST_DOMAIN,
  CAPABILITY_CATALOG_LAYERS,
  CAPABILITY_CATALOG_LIMITS,
  CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES,
  CAPABILITY_CATALOG_RESOURCE_KINDS,
  CAPABILITY_CATALOG_ROLES,
  CAPABILITY_CATALOG_VERSION,
} from "./capability-catalog-contract.js";
export type {
  CapabilityCatalogAuthorityKind,
  CapabilityCatalogCode,
  CapabilityCatalogCriterionCategory,
  CapabilityCatalogDeliveryProfileFamilyId,
  CapabilityCatalogEntry,
  CapabilityCatalogLayer,
  CapabilityCatalogLineage,
  CapabilityCatalogRefusal,
  CapabilityCatalogResourceKind,
  CapabilityCatalogResourceScope,
  CapabilityCatalogRole,
  CapabilityCatalogRevision,
  CapabilityCatalogRevisionDraft,
  CapabilityCatalogVerificationRecipeRevisionRef,
} from "./capability-catalog-contract.js";

export type CapabilityCatalogRevisionCreateResult =
  | Readonly<{ ok: true; revision: CapabilityCatalogRevision }>
  | CapabilityCatalogRefusal;
export type CapabilityCatalogRevisionEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | CapabilityCatalogRefusal;
export type CapabilityCatalogRevisionDecodeResult =
  | Readonly<{ ok: true; revision: CapabilityCatalogRevision }>
  | CapabilityCatalogRefusal;
export type CapabilityCatalogRevisionDigestResult =
  | Readonly<{ ok: true; revisionDigest: string }>
  | CapabilityCatalogRefusal;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST_PLACEHOLDER = "0".repeat(64);

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("CapabilityCatalogRevision canonicalization received unadmitted data");
}

function digestSource(
  revision: CapabilityCatalogRevision,
): Readonly<Record<string, unknown>> {
  const { revisionDigest: _digest, ...source } = revision;
  return Object.freeze(source);
}

function digestOf(revision: CapabilityCatalogRevision): string {
  return createHash("sha256")
    .update(CAPABILITY_CATALOG_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(digestSource(revision))))
    .digest("hex");
}

const codecRefusal = (
  code: Parameters<typeof capabilityCatalogRefusal>[0],
  layer: Parameters<typeof capabilityCatalogRefusal>[1],
): CapabilityCatalogRefusal => capabilityCatalogRefusal(code, layer);

function canonicalBytes(
  revision: CapabilityCatalogRevision,
): CapabilityCatalogRevisionEncodeResult {
  const bytes = encoder.encode(canonicalText(revision));
  return bytes.byteLength > CAPABILITY_CATALOG_LIMITS.maxBytes
    ? codecRefusal("CAPABILITY_CATALOG_LIMIT_EXCEEDED", "CAPABILITY_CATALOG_LIMITS")
    : Object.freeze({ bytes, ok: true as const });
}

export function createCapabilityCatalogRevision(
  value: unknown,
): CapabilityCatalogRevisionCreateResult {
  const admitted = admitCapabilityCatalogRevisionDraft(value); if (!admitted.ok) return admitted;
  const provisional = admitCapabilityCatalogRevision({
    ...admitted.draft,
    revisionDigest: DIGEST_PLACEHOLDER,
    version: CAPABILITY_CATALOG_VERSION,
  });
  if (!provisional.ok) return provisional;
  const final = admitCapabilityCatalogRevision({
    ...admitted.draft,
    revisionDigest: digestOf(provisional.revision),
    version: CAPABILITY_CATALOG_VERSION,
  });
  if (!final.ok) return final;
  const bounded = canonicalBytes(final.revision);
  return bounded.ok ? Object.freeze({ ok: true as const, revision: final.revision }) : bounded;
}

export function deriveCapabilityCatalogRevisionDigest(
  value: unknown,
): CapabilityCatalogRevisionDigestResult {
  const admitted = admitCapabilityCatalogRevision(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return Object.freeze({ ok: true as const, revisionDigest: digestOf(admitted.revision) });
}

export function encodeCapabilityCatalogRevision(
  value: unknown,
): CapabilityCatalogRevisionEncodeResult {
  const admitted = admitCapabilityCatalogRevision(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return digestOf(admitted.revision) === admitted.revision.revisionDigest
    ? bounded
    : codecRefusal("CAPABILITY_CATALOG_DIGEST_MISMATCH", "CAPABILITY_CATALOG_DIGEST");
}

function decodeRefusal(code: string): CapabilityCatalogRefusal {
  if (code === "JSON_DUPLICATE_KEY") {
    return codecRefusal("CAPABILITY_CATALOG_DUPLICATE_KEY", "CAPABILITY_CATALOG_CODEC");
  }
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") {
    return codecRefusal("CAPABILITY_CATALOG_LIMIT_EXCEEDED", "CAPABILITY_CATALOG_LIMITS");
  }
  return codecRefusal("CAPABILITY_CATALOG_BYTES_INVALID", "CAPABILITY_CATALOG_CODEC");
}

export function decodeCapabilityCatalogRevisionBytes(
  bytes: unknown,
): CapabilityCatalogRevisionDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes); if (!decoded.ok) return decodeRefusal(decoded.code);
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitCapabilityCatalogRevision(decoded.value); if (!admitted.ok) return admitted;
  if (digestOf(admitted.revision) !== admitted.revision.revisionDigest) {
    return codecRefusal("CAPABILITY_CATALOG_DIGEST_MISMATCH", "CAPABILITY_CATALOG_DIGEST");
  }
  if (canonicalText(admitted.revision) !== decoder.decode(source)) {
    return codecRefusal(
      "CAPABILITY_CATALOG_NONCANONICAL", "CAPABILITY_CATALOG_CANONICALIZATION",
    );
  }
  return Object.freeze({ ok: true as const, revision: admitted.revision });
}
