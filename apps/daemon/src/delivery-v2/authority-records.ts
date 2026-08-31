import { decodeBoundedJsonBytes } from "@moe/contracts";

import { deliveryV2Digest, type DeliveryV2AuthorityKind } from "./addresses.js";

export const DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION =
  "moe-delivery-v2-authority-evidence/1" as const;
export const DELIVERY_V2_QUALIFICATION_STATUS_VERSION =
  "moe-delivery-v2-qualification-status/1" as const;

export type EvidenceAuthorityKind = Exclude<DeliveryV2AuthorityKind, "QUALIFICATION_STATUS">;
export interface DeliveryV2AuthorityEvidenceRecord {
  readonly bindingDigest: string;
  readonly kind: EvidenceAuthorityKind;
  readonly projectId: string;
  readonly qualificationId: string;
  readonly recordDigest: string;
  readonly subjectDigest: string;
  readonly subjectRef: string;
  readonly version: typeof DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION;
}
export interface DeliveryV2QualificationStatusRecord {
  readonly projectId: string;
  readonly qualificationDigest: string;
  readonly qualificationId: string;
  readonly status: "CURRENT" | "REVOKED";
  readonly statusDigest: string;
  readonly statusRef: string;
  readonly version: typeof DELIVERY_V2_QUALIFICATION_STATUS_VERSION;
}
const EVIDENCE_KEYS = Object.freeze([
  "bindingDigest", "kind", "projectId", "qualificationId", "recordDigest",
  "subjectDigest", "subjectRef", "version",
]);
const STATUS_KEYS = Object.freeze([
  "projectId", "qualificationDigest", "qualificationId", "status", "statusDigest",
  "statusRef", "version",
]);
const HEX64 = /^[a-f0-9]{64}$/u;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value !== "";
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

function evidenceBody(input: Omit<DeliveryV2AuthorityEvidenceRecord, "recordDigest" | "version">) {
  return {
    bindingDigest: input.bindingDigest, kind: input.kind, projectId: input.projectId,
    qualificationId: input.qualificationId, subjectDigest: input.subjectDigest,
    subjectRef: input.subjectRef, version: DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION,
  };
}
export function createDeliveryV2AuthorityEvidenceRecord(
  input: Omit<DeliveryV2AuthorityEvidenceRecord, "recordDigest" | "version">,
): DeliveryV2AuthorityEvidenceRecord {
  const body = evidenceBody(input);
  return Object.freeze({ ...body, recordDigest: deliveryV2Digest(
    "moe-delivery-v2-authority-evidence-digest/1", JSON.stringify(body),
  ) });
}
function statusBody(input: Omit<DeliveryV2QualificationStatusRecord, "statusDigest" | "version">) {
  return {
    projectId: input.projectId, qualificationDigest: input.qualificationDigest,
    qualificationId: input.qualificationId, status: input.status, statusRef: input.statusRef,
    version: DELIVERY_V2_QUALIFICATION_STATUS_VERSION,
  };
}
export function createDeliveryV2QualificationStatusRecord(
  input: Omit<DeliveryV2QualificationStatusRecord, "statusDigest" | "version">,
): DeliveryV2QualificationStatusRecord {
  const body = statusBody(input);
  return Object.freeze({ ...body, statusDigest: deliveryV2Digest(
    "moe-delivery-v2-qualification-status-digest/1", JSON.stringify(body),
  ) });
}

export const encodeDeliveryV2AuthorityEvidenceRecord =
  (value: DeliveryV2AuthorityEvidenceRecord): Uint8Array => bytes({
    bindingDigest: value.bindingDigest, kind: value.kind, projectId: value.projectId,
    qualificationId: value.qualificationId, recordDigest: value.recordDigest,
    subjectDigest: value.subjectDigest, subjectRef: value.subjectRef, version: value.version,
  });
export const encodeDeliveryV2QualificationStatusRecord =
  (value: DeliveryV2QualificationStatusRecord): Uint8Array => bytes({
    projectId: value.projectId, qualificationDigest: value.qualificationDigest,
    qualificationId: value.qualificationId, status: value.status,
    statusDigest: value.statusDigest, statusRef: value.statusRef, version: value.version,
  });

export function decodeDeliveryV2AuthorityEvidenceRecord(
  input: unknown,
): DeliveryV2AuthorityEvidenceRecord | undefined {
  const decoded = decodeBoundedJsonBytes(input); if (!decoded.ok || decoded.value === null
    || typeof decoded.value !== "object" || Array.isArray(decoded.value)) return undefined;
  const value = decoded.value as Record<string, unknown>;
  if (!exact(value, EVIDENCE_KEYS) || value["version"] !== DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION
    || !["OPERATOR_APPROVAL", "BUILDER_IDENTITY", "PROVIDER_PROFILE", "VERIFIER_RECEIPT"]
      .includes(value["kind"] as string)
    || ![value["projectId"], value["qualificationId"], value["subjectRef"]].every(text)
    || ![value["bindingDigest"], value["recordDigest"], value["subjectDigest"]]
      .every((item) => typeof item === "string" && HEX64.test(item))) return undefined;
  const record = createDeliveryV2AuthorityEvidenceRecord({
    bindingDigest: value["bindingDigest"] as string,
    kind: value["kind"] as EvidenceAuthorityKind,
    projectId: value["projectId"] as string, qualificationId: value["qualificationId"] as string,
    subjectDigest: value["subjectDigest"] as string, subjectRef: value["subjectRef"] as string,
  });
  const encoded = encodeDeliveryV2AuthorityEvidenceRecord(record);
  return record.recordDigest === value["recordDigest"] && input instanceof Uint8Array
    && sameBytes(encoded, input) ? record : undefined;
}

export function decodeDeliveryV2QualificationStatusRecord(
  input: unknown,
): DeliveryV2QualificationStatusRecord | undefined {
  const decoded = decodeBoundedJsonBytes(input); if (!decoded.ok || decoded.value === null
    || typeof decoded.value !== "object" || Array.isArray(decoded.value)) return undefined;
  const value = decoded.value as Record<string, unknown>;
  if (!exact(value, STATUS_KEYS) || value["version"] !== DELIVERY_V2_QUALIFICATION_STATUS_VERSION
    || (value["status"] !== "CURRENT" && value["status"] !== "REVOKED")
    || ![value["projectId"], value["qualificationId"], value["statusRef"]].every(text)
    || ![value["qualificationDigest"], value["statusDigest"]]
      .every((item) => typeof item === "string" && HEX64.test(item))) return undefined;
  const record = createDeliveryV2QualificationStatusRecord({
    projectId: value["projectId"] as string,
    qualificationDigest: value["qualificationDigest"] as string,
    qualificationId: value["qualificationId"] as string,
    status: value["status"] as "CURRENT" | "REVOKED", statusRef: value["statusRef"] as string,
  });
  const encoded = encodeDeliveryV2QualificationStatusRecord(record);
  return record.statusDigest === value["statusDigest"] && input instanceof Uint8Array
    && sameBytes(encoded, input) ? record : undefined;
}
