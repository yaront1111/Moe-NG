import { createHash } from "node:crypto";

import type { V2ReadinessEvidenceKind } from "./v2-readiness-manifest-writer.js";
import { V2_READINESS_MANIFEST_LAYER } from "./v2-readiness-manifest.js";

/**
 * The vocabulary of the v2 readiness EVIDENCE collector: what one evidence kind's
 * production answers with, and the one serialization every produced file uses.
 *
 * The readiness writer digests file BYTES (v2-readiness-manifest-writer.ts), so a produced
 * record is emitted exactly once as canonical JSON — sorted keys, no whitespace, no trailing
 * newline — and never re-serialized after. Two producers that pretty-printed differently
 * would put two digests on one fact. A kind whose producer does not exist in this tree is
 * REFUSED by name (V2_EVIDENCE_PRODUCER_ABSENT), never filled with a placeholder record:
 * the writer refusing on a missing file is the correct outcome, and it names which one.
 */

export const V2_READINESS_EVIDENCE_CODES = Object.freeze([
  "V2_EVIDENCE_SOURCE_COMMIT_INVALID",
  "V2_EVIDENCE_SOURCE_COMMIT_MISMATCH",
  "V2_EVIDENCE_PRODUCER_ABSENT",
  "V2_EVIDENCE_INPUT_UNREADABLE",
  "V2_EVIDENCE_INPUT_INVALID",
  "V2_EVIDENCE_CONTRACT_DIGEST_STALE",
  "V2_EVIDENCE_STORE_REFUSED",
  "V2_EVIDENCE_GATE_RED",
  "V2_EVIDENCE_OUTPUT_CONFLICT",
] as const);
export type V2ReadinessEvidenceCode = (typeof V2_READINESS_EVIDENCE_CODES)[number];

export interface V2EvidenceProduced {
  readonly bytes: Uint8Array;
  readonly kind: V2ReadinessEvidenceKind;
  readonly ok: true;
  readonly sha256: string;
}

export interface V2EvidenceRefused {
  readonly code: V2ReadinessEvidenceCode;
  readonly detail: string;
  readonly kind: V2ReadinessEvidenceKind;
  readonly layer: typeof V2_READINESS_MANIFEST_LAYER;
  readonly ok: false;
  /** The answering authority when this tool forwards rather than decides. */
  readonly upstream: Readonly<{ code: string; layer: string }> | null;
}

export type V2EvidenceOutcome = V2EvidenceProduced | V2EvidenceRefused;

export const COMMIT_HEX = /^[0-9a-f]{40}$/u;

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Sorted-key JSON with no whitespace: the same rule `scripts/release/supply-chain.mjs`
 * seals release evidence with, so a record produced here and one produced there compare
 * as text. `undefined` members are dropped, as JSON.stringify drops them.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const encoder = new TextEncoder();

export function producedRecord(kind: V2ReadinessEvidenceKind, value: unknown): V2EvidenceProduced {
  return producedBytes(kind, encoder.encode(canonicalJson(value)));
}

export function producedBytes(kind: V2ReadinessEvidenceKind, bytes: Uint8Array): V2EvidenceProduced {
  return Object.freeze({ bytes, kind, ok: true as const, sha256: sha256Hex(bytes) });
}

export function refusedEvidence(
  kind: V2ReadinessEvidenceKind,
  code: V2ReadinessEvidenceCode,
  detail: string,
  upstream: Readonly<{ code: string; layer: string }> | null = null,
): V2EvidenceRefused {
  return Object.freeze({
    code, detail, kind, layer: V2_READINESS_MANIFEST_LAYER, ok: false as const, upstream,
  });
}

/** A JSON object read from bytes, or null when the bytes are not one. */
export function parseJsonObject(bytes: Uint8Array): Readonly<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Readonly<Record<string, unknown>>;
}

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
