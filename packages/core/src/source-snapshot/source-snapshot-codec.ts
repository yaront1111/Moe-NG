import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";

import {
  admitSourceSnapshot, admitSourceSnapshotDraft,
} from "./source-snapshot-admission.js";
import {
  SOURCE_SNAPSHOT_DIGEST_DOMAIN, SOURCE_SNAPSHOT_LIMITS, SOURCE_SNAPSHOT_VERSION,
  sourceSnapshotRefusal,
} from "./source-snapshot-contract.js";
import type {
  SourceSnapshot, SourceSnapshotRefusal,
} from "./source-snapshot-contract.js";

export {
  SOURCE_SNAPSHOT_CODES, SOURCE_SNAPSHOT_DIGEST_DOMAIN, SOURCE_SNAPSHOT_LAYERS,
  SOURCE_SNAPSHOT_LIMITS, SOURCE_SNAPSHOT_REF_KEYS, SOURCE_SNAPSHOT_VERSION,
} from "./source-snapshot-contract.js";
export type {
  SourceSnapshot, SourceSnapshotAdmission, SourceSnapshotCode, SourceSnapshotDraft,
  SourceSnapshotDraftAdmission, SourceSnapshotLayer, SourceSnapshotRef,
  SourceSnapshotRefAdmission, SourceSnapshotRefusal,
} from "./source-snapshot-contract.js";
export { admitSourceSnapshotRef } from "./source-snapshot-admission.js";

export type SourceSnapshotCreateResult =
  | Readonly<{ ok: true; snapshot: SourceSnapshot }> | SourceSnapshotRefusal;
export type SourceSnapshotEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }> | SourceSnapshotRefusal;
export type SourceSnapshotDecodeResult =
  | Readonly<{ ok: true; snapshot: SourceSnapshot }> | SourceSnapshotRefusal;
export type SourceSnapshotDigestResult =
  | Readonly<{ ok: true; sourceSnapshotDigest: string }> | SourceSnapshotRefusal;

const encoder = new TextEncoder();

function canonicalText(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("SourceSnapshot canonicalization received unadmitted data");
}

function digestOf(snapshot: SourceSnapshot): string {
  const { sourceSnapshotDigest: _digest, ...source } = snapshot;
  return createHash("sha256")
    .update(SOURCE_SNAPSHOT_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(source)))
    .digest("hex");
}

function canonicalBytes(snapshot: SourceSnapshot): SourceSnapshotEncodeResult {
  const bytes = encoder.encode(canonicalText(snapshot));
  return bytes.byteLength > SOURCE_SNAPSHOT_LIMITS.maxBytes
    ? sourceSnapshotRefusal("SOURCE_SNAPSHOT_LIMIT_EXCEEDED", "SOURCE_SNAPSHOT_LIMITS")
    : Object.freeze({ bytes, ok: true as const });
}

export function createSourceSnapshot(value: unknown): SourceSnapshotCreateResult {
  const admitted = admitSourceSnapshotDraft(value); if (!admitted.ok) return admitted;
  const provisional = {
    ...admitted.draft, sourceSnapshotDigest: "0".repeat(64), version: SOURCE_SNAPSHOT_VERSION,
  } as const;
  const final = admitSourceSnapshot({
    ...admitted.draft, sourceSnapshotDigest: digestOf(provisional), version: SOURCE_SNAPSHOT_VERSION,
  });
  if (!final.ok) return final;
  const bounded = canonicalBytes(final.snapshot);
  return bounded.ok ? Object.freeze({ ok: true as const, snapshot: final.snapshot }) : bounded;
}

export function deriveSourceSnapshotDigest(value: unknown): SourceSnapshotDigestResult {
  const admitted = admitSourceSnapshot(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.snapshot); if (!bounded.ok) return bounded;
  return Object.freeze({ ok: true as const,
    sourceSnapshotDigest: digestOf(admitted.snapshot) });
}

export function encodeSourceSnapshot(value: unknown): SourceSnapshotEncodeResult {
  const admitted = admitSourceSnapshot(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.snapshot); if (!bounded.ok) return bounded;
  return digestOf(admitted.snapshot) === admitted.snapshot.sourceSnapshotDigest
    ? bounded
    : sourceSnapshotRefusal("SOURCE_SNAPSHOT_DIGEST_MISMATCH", "SOURCE_SNAPSHOT_DIGEST");
}

function decodeRefusal(code: string): SourceSnapshotRefusal {
  if (code === "JSON_DUPLICATE_KEY") {
    return sourceSnapshotRefusal("SOURCE_SNAPSHOT_DUPLICATE_KEY", "SOURCE_SNAPSHOT_CODEC");
  }
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") {
    return sourceSnapshotRefusal("SOURCE_SNAPSHOT_LIMIT_EXCEEDED", "SOURCE_SNAPSHOT_LIMITS");
  }
  return sourceSnapshotRefusal("SOURCE_SNAPSHOT_BYTES_INVALID", "SOURCE_SNAPSHOT_CODEC");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

export function decodeSourceSnapshotBytes(value: unknown): SourceSnapshotDecodeResult {
  const decoded = decodeBoundedJsonBytes(value); if (!decoded.ok) return decodeRefusal(decoded.code);
  const source = new Uint8Array(value as Uint8Array);
  const admitted = admitSourceSnapshot(decoded.value); if (!admitted.ok) return admitted;
  if (digestOf(admitted.snapshot) !== admitted.snapshot.sourceSnapshotDigest) {
    return sourceSnapshotRefusal("SOURCE_SNAPSHOT_DIGEST_MISMATCH", "SOURCE_SNAPSHOT_DIGEST");
  }
  const canonical = canonicalBytes(admitted.snapshot); if (!canonical.ok) return canonical;
  if (!sameBytes(canonical.bytes, source)) {
    return sourceSnapshotRefusal(
      "SOURCE_SNAPSHOT_NONCANONICAL", "SOURCE_SNAPSHOT_CANONICALIZATION");
  }
  return Object.freeze({ ok: true as const, snapshot: admitted.snapshot });
}
