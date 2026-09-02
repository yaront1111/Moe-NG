import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";

import {
  admitDeliveryProfileQualification,
  admitDeliveryProfileQualificationDraft,
  admitDeliveryProfileRevision,
  admitDeliveryProfileRevisionDraft,
} from "./delivery-profile-admission.js";
import {
  DELIVERY_PROFILE_DIGEST_DOMAIN,
  DELIVERY_PROFILE_LIMITS,
  DELIVERY_PROFILE_QUALIFICATION_DIGEST_DOMAIN,
  DELIVERY_PROFILE_QUALIFICATION_VERSION,
  DELIVERY_PROFILE_VERSION,
  deliveryProfileRefusal,
  type DeliveryProfileQualification,
  type DeliveryProfileRefusal,
  type DeliveryProfileRevision,
} from "./delivery-profile-contract.js";

export * from "./delivery-profile-codec-surface.js";

export type DeliveryProfileRevisionCreateResult =
  | Readonly<{ ok: true; revision: DeliveryProfileRevision }>
  | DeliveryProfileRefusal;
export type DeliveryProfileRevisionEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | DeliveryProfileRefusal;
export type DeliveryProfileRevisionDecodeResult =
  | Readonly<{ ok: true; revision: DeliveryProfileRevision }>
  | DeliveryProfileRefusal;
export type DeliveryProfileQualificationCreateResult =
  | Readonly<{ ok: true; qualification: DeliveryProfileQualification }>
  | DeliveryProfileRefusal;
export type DeliveryProfileQualificationEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | DeliveryProfileRefusal;
export type DeliveryProfileQualificationDecodeResult =
  | Readonly<{ ok: true; qualification: DeliveryProfileQualification }>
  | DeliveryProfileRefusal;

type BytesResult = Readonly<{ bytes: Uint8Array; ok: true }> | DeliveryProfileRefusal;

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
  throw new TypeError("delivery profile canonicalization received unadmitted data");
}

function withoutKey(
  value: Readonly<Record<string, unknown>>,
  omitted: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== omitted),
  ));
}

function digest(
  domain: string,
  value: Readonly<Record<string, unknown>>,
  omitted: string,
): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(withoutKey(value, omitted))))
    .digest("hex");
}

function profileDigest(revision: DeliveryProfileRevision): string {
  return digest(
    DELIVERY_PROFILE_DIGEST_DOMAIN,
    revision as unknown as Readonly<Record<string, unknown>>,
    "revisionDigest",
  );
}

function qualificationDigest(qualification: DeliveryProfileQualification): string {
  return digest(
    DELIVERY_PROFILE_QUALIFICATION_DIGEST_DOMAIN,
    qualification as unknown as Readonly<Record<string, unknown>>,
    "qualificationDigest",
  );
}

const digestMismatch = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_DIGEST_MISMATCH", "DELIVERY_PROFILE_DIGEST",
);
const limitExceeded = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_LIMIT_EXCEEDED", "DELIVERY_PROFILE_LIMITS",
);
const bytesInvalid = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_BYTES_INVALID", "DELIVERY_PROFILE_CODEC",
);
const duplicateKey = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_DUPLICATE_KEY", "DELIVERY_PROFILE_CODEC",
);
const noncanonical = (): DeliveryProfileRefusal => deliveryProfileRefusal(
  "DELIVERY_PROFILE_NONCANONICAL", "DELIVERY_PROFILE_CANONICALIZATION",
);

function canonicalBytes(value: unknown): BytesResult {
  const bytes = encoder.encode(canonicalText(value));
  return bytes.byteLength > DELIVERY_PROFILE_LIMITS.maxBytes
    ? limitExceeded() : Object.freeze({ bytes, ok: true as const });
}

function decodeRefusal(code: string): DeliveryProfileRefusal {
  if (code === "JSON_DUPLICATE_KEY") return duplicateKey();
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return limitExceeded();
  return bytesInvalid();
}

export function createDeliveryProfileRevision(value: unknown): DeliveryProfileRevisionCreateResult {
  const admitted = admitDeliveryProfileRevisionDraft(value); if (!admitted.ok) return admitted;
  const provisional = admitDeliveryProfileRevision({
    ...admitted.draft, revisionDigest: DIGEST_PLACEHOLDER, version: DELIVERY_PROFILE_VERSION,
  });
  if (!provisional.ok) return provisional;
  const final = admitDeliveryProfileRevision({
    ...admitted.draft, revisionDigest: profileDigest(provisional.revision),
    version: DELIVERY_PROFILE_VERSION,
  });
  if (!final.ok) return final;
  const bounded = canonicalBytes(final.revision);
  return bounded.ok ? Object.freeze({ ok: true as const, revision: final.revision }) : bounded;
}

export function encodeDeliveryProfileRevision(value: unknown): DeliveryProfileRevisionEncodeResult {
  const admitted = admitDeliveryProfileRevision(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return profileDigest(admitted.revision) === admitted.revision.revisionDigest
    ? bounded : digestMismatch();
}

export function decodeDeliveryProfileRevisionBytes(
  bytes: unknown,
): DeliveryProfileRevisionDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes); if (!decoded.ok) return decodeRefusal(decoded.code);
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitDeliveryProfileRevision(decoded.value); if (!admitted.ok) return admitted;
  if (profileDigest(admitted.revision) !== admitted.revision.revisionDigest) return digestMismatch();
  if (canonicalText(admitted.revision) !== decoder.decode(source)) return noncanonical();
  return Object.freeze({ ok: true as const, revision: admitted.revision });
}

export function createDeliveryProfileQualification(
  value: unknown,
): DeliveryProfileQualificationCreateResult {
  const admitted = admitDeliveryProfileQualificationDraft(value); if (!admitted.ok) return admitted;
  const provisional = admitDeliveryProfileQualification({
    ...admitted.draft, qualificationDigest: DIGEST_PLACEHOLDER,
    version: DELIVERY_PROFILE_QUALIFICATION_VERSION,
  });
  if (!provisional.ok) return provisional;
  const final = admitDeliveryProfileQualification({
    ...admitted.draft, qualificationDigest: qualificationDigest(provisional.qualification),
    version: DELIVERY_PROFILE_QUALIFICATION_VERSION,
  });
  if (!final.ok) return final;
  const bounded = canonicalBytes(final.qualification);
  return bounded.ok
    ? Object.freeze({ ok: true as const, qualification: final.qualification }) : bounded;
}

export function encodeDeliveryProfileQualification(
  value: unknown,
): DeliveryProfileQualificationEncodeResult {
  const admitted = admitDeliveryProfileQualification(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.qualification); if (!bounded.ok) return bounded;
  return qualificationDigest(admitted.qualification) === admitted.qualification.qualificationDigest
    ? bounded : digestMismatch();
}

export function decodeDeliveryProfileQualificationBytes(
  bytes: unknown,
): DeliveryProfileQualificationDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes); if (!decoded.ok) return decodeRefusal(decoded.code);
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitDeliveryProfileQualification(decoded.value); if (!admitted.ok) return admitted;
  if (qualificationDigest(admitted.qualification)
    !== admitted.qualification.qualificationDigest) return digestMismatch();
  if (canonicalText(admitted.qualification) !== decoder.decode(source)) return noncanonical();
  return Object.freeze({ ok: true as const, qualification: admitted.qualification });
}
