import {
  PHASE0_AUTHORIZATION_ASSURANCE,
  PHASE0_AUTHORIZATION_CLAIM_VERSION,
  PHASE0_FREEZE_SUBJECT,
  PHASE0_MAX_AUTHORIZATION_BYTES,
  PHASE0_MAX_MANIFEST_BYTES,
  PHASE0_MAX_REVIEW_RECEIPT_BYTES,
  PHASE0_TARGET_REPOSITORY,
  type Phase0FreezeAuthorizationClaim,
} from "@moe/contracts";

import { canonicalize } from "./canonical-json.js";
import { snapshotEvidenceBytes } from "./evidence-digest.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_CANONICAL_INPUT_BYTES = Object.freeze({
  authorization: PHASE0_MAX_AUTHORIZATION_BYTES,
  manifest: PHASE0_MAX_MANIFEST_BYTES,
  "review-receipt": PHASE0_MAX_REVIEW_RECEIPT_BYTES,
});

export function freezeError(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function countLines(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) {
    return 0;
  }
  let lineFeeds = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lineFeeds += 1;
    }
  }
  return bytes[bytes.byteLength - 1] === 0x0a ? lineFeeds : lineFeeds + 1;
}

export function requireRecord(value: unknown, code: string, detail: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return freezeError(code, detail);
  }
  return value as Record<string, unknown>;
}

export function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  code: string,
  detail: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    freezeError(code, detail);
  }
}

export function requireString(
  value: unknown,
  code: string,
  detail: string,
): string {
  if (typeof value !== "string") {
    return freezeError(code, detail);
  }
  return value;
}

export function requireSafeNonnegativeInteger(
  value: unknown,
  code: string,
  detail: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return freezeError(code, detail);
  }
  return value as number;
}

export function requireSha256(value: unknown, code: string, detail: string): string {
  const digest = requireString(value, code, detail);
  if (!SHA256_PATTERN.test(digest)) {
    return freezeError(code, detail);
  }
  return digest;
}

export function requireCanonicalInstant(value: unknown, code: string, detail: string): string {
  const instant = requireString(value, code, detail);
  if (!CANONICAL_INSTANT_PATTERN.test(instant)) {
    return freezeError(code, detail);
  }
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== instant) {
    return freezeError(code, detail);
  }
  return instant;
}

export function parseCanonicalJsonRecord(
  input: Uint8Array,
  label: "authorization" | "manifest" | "review-receipt",
): { readonly bytes: Uint8Array; readonly record: Record<string, unknown> } {
  let bytes: Uint8Array;
  try {
    bytes = snapshotEvidenceBytes(input, MAX_CANONICAL_INPUT_BYTES[label]);
  } catch (error) {
    if (error instanceof RangeError) {
      return freezeError(
        `PHASE0_${label.toUpperCase().replace("-", "_")}_BYTES_LIMIT_EXCEEDED`,
        label,
      );
    }
    return freezeError(`PHASE0_${label.toUpperCase().replace("-", "_")}_BYTES_INVALID`, label);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return freezeError(`PHASE0_${label.toUpperCase().replace("-", "_")}_UTF8_INVALID`, label);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return freezeError(`PHASE0_${label.toUpperCase().replace("-", "_")}_JSON_INVALID`, label);
  }
  const record = requireRecord(
    value,
    `PHASE0_${label.toUpperCase().replace("-", "_")}_SHAPE_INVALID`,
    label,
  );
  let canonicalBytes: Uint8Array;
  try {
    canonicalBytes = new TextEncoder().encode(canonicalize(record));
  } catch {
    return freezeError(
      `PHASE0_${label.toUpperCase().replace("-", "_")}_NOT_CANONICAL`,
      label,
    );
  }
  if (!equalBytes(bytes, canonicalBytes)) {
    freezeError(`PHASE0_${label.toUpperCase().replace("-", "_")}_NOT_CANONICAL`, label);
  }
  return Object.freeze({ bytes, record });
}

export function decodeFreezeAuthorizationClaim(bytes: Uint8Array): Phase0FreezeAuthorizationClaim {
  const { record } = parseCanonicalJsonRecord(bytes, "authorization");
  requireExactKeys(
    record,
    [
      "assurance",
      "benchmarkSha256",
      "claimedActor",
      "claimedAt",
      "claimedDecision",
      "designSha256",
      "manifestSha256",
      "reviewSha256",
      "schemaVersion",
      "subject",
      "targetRepository",
    ],
    "PHASE0_AUTHORIZATION_SHAPE_INVALID",
    "keys",
  );
  if (
    record.assurance !== PHASE0_AUTHORIZATION_ASSURANCE ||
    record.claimedActor !== "yaron" ||
    record.claimedDecision !== "GO" ||
    record.schemaVersion !== PHASE0_AUTHORIZATION_CLAIM_VERSION ||
    record.subject !== PHASE0_FREEZE_SUBJECT
  ) {
    freezeError("PHASE0_AUTHORIZATION_SHAPE_INVALID", "fixed fields");
  }
  if (record.targetRepository !== PHASE0_TARGET_REPOSITORY) {
    freezeError("PHASE0_TARGET_REPOSITORY_MISMATCH", "authorization claim");
  }
  return Object.freeze({
    assurance: PHASE0_AUTHORIZATION_ASSURANCE,
    claimedAt: requireCanonicalInstant(
      record.claimedAt,
      "PHASE0_AUTHORIZATION_TIME_INVALID",
      "claimedAt",
    ),
    benchmarkSha256: requireSha256(
      record.benchmarkSha256,
      "PHASE0_AUTHORIZATION_SHAPE_INVALID",
      "benchmarkSha256",
    ),
    claimedActor: "yaron",
    claimedDecision: "GO",
    designSha256: requireSha256(
      record.designSha256,
      "PHASE0_AUTHORIZATION_SHAPE_INVALID",
      "designSha256",
    ),
    manifestSha256: requireSha256(
      record.manifestSha256,
      "PHASE0_AUTHORIZATION_SHAPE_INVALID",
      "manifestSha256",
    ),
    reviewSha256: requireSha256(
      record.reviewSha256,
      "PHASE0_AUTHORIZATION_SHAPE_INVALID",
      "reviewSha256",
    ),
    schemaVersion: PHASE0_AUTHORIZATION_CLAIM_VERSION,
    subject: PHASE0_FREEZE_SUBJECT,
    targetRepository: PHASE0_TARGET_REPOSITORY,
  });
}
