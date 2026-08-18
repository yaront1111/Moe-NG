/**
 * The sealed Foundation context manifest record.
 *
 * WHY THIS ENVELOPE EXISTS. `digestContextManifest` binds exactly the seven
 * fields of `ContextDigestBinding` — optionalSelection, journalCountLimit,
 * journalTextLimit, ordering, rendererVersion, exclusions, exactBytes. It binds
 * NONE of the authority a Foundation attempt actually needs pinned: project,
 * session, node, attempt, graph revision, graph content, epoch, configuration or
 * input manifest. Two records describing different projects at different epochs
 * can therefore carry an identical inner digest, so reusing that digest as the
 * record's identity would let them collide. `recordDigest` is the outer binding
 * that makes the authority fields part of the identity.
 *
 * THE INNER DIGEST IS RECOMPUTED, NEVER TRUSTED, and never reimplemented — it is
 * `digestContextManifest` from the `@moe/context` root, called on the caller's
 * own binding and compared against the digest they declared.
 *
 * THE OUTER DIGEST IS DERIVED, NEVER ACCEPTED. A caller must submit one, but it
 * is only ever compared: what the encoder returns is the derivation. That turns
 * "a caller cannot supply authority" into a tested behaviour rather than a
 * comment, which is what `FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH` is for.
 *
 * FIVE CODES, DELIBERATELY DISTINCT. MALFORMED, VERSION_UNSUPPORTED,
 * MANIFEST_DIGEST_MISMATCH, RECORD_DIGEST_MISMATCH and NONCANONICAL answer five
 * different operator questions and must never stand in for one another — the
 * same reason `readStoredFoundationAttempt` keeps ABSENT/AMBIGUOUS/DRIFT apart.
 */

import { digestContextManifest, CONTEXT_MANIFEST_VERSION } from "@moe/context";
import type { ContextRenderManifest } from "@moe/context";

import {
  decodeFoundationPayload,
  encodeFoundationPayload,
  exactKeys,
  isRecord,
  sameBytes,
  snapshotFoundationValue,
} from "./foundation-attempt-codec.js";

export const FOUNDATION_CONTEXT_RECORD_VERSION = "foundation-context-manifest.v1" as const;

/** Names the layer that answered; this codec is the only member. */
export const FOUNDATION_CONTEXT_CODEC = "FOUNDATION_CONTEXT_CODEC" as const;

export const FOUNDATION_CONTEXT_MANIFEST_CODES = Object.freeze([
  "FOUNDATION_CONTEXT_MALFORMED",
  "FOUNDATION_CONTEXT_VERSION_UNSUPPORTED",
  "FOUNDATION_CONTEXT_MANIFEST_DIGEST_MISMATCH",
  "FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH",
  "FOUNDATION_CONTEXT_NONCANONICAL",
] as const);

export type FoundationContextManifestCode = (typeof FOUNDATION_CONTEXT_MANIFEST_CODES)[number];
export const FOUNDATION_CONTEXT_RECORD_KEYS = Object.freeze([
  "attemptRef", "configurationDigest", "graphContentHash", "graphEpoch", "graphRevisionRef",
  "inputManifestDigest", "manifest", "nodeKey", "projectId", "recordDigest", "sessionId",
] as const);
/** The ten fields the outer digest binds; `recordDigest` is the binding itself. */
const BOUND_KEYS = Object.freeze(
  FOUNDATION_CONTEXT_RECORD_KEYS.filter((key) => key !== "recordDigest"),
);
const IDENTITY_KEYS = Object.freeze([
  "attemptRef", "configurationDigest", "graphContentHash", "graphRevisionRef",
  "inputManifestDigest", "nodeKey", "projectId", "sessionId",
] as const);
const MANIFEST_KEYS = Object.freeze(["binding", "digest", "version"] as const);
const BINDING_KEYS = Object.freeze([
  "exactBytes", "exclusions", "journalCountLimit", "journalTextLimit", "optionalSelection",
  "ordering", "rendererVersion",
] as const);
const MAX_TEXT = 8_192, MAX_EPOCH = Number.MAX_SAFE_INTEGER;

export interface FoundationContextManifestRecord {
  readonly attemptRef: string;
  readonly configurationDigest: string;
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly graphRevisionRef: string;
  readonly inputManifestDigest: string;
  readonly manifest: ContextRenderManifest;
  readonly nodeKey: string;
  readonly projectId: string;
  readonly recordDigest: string;
  readonly sessionId: string;
}

export interface FoundationContextRefusal {
  readonly code: FoundationContextManifestCode;
  readonly layer: typeof FOUNDATION_CONTEXT_CODEC;
  readonly ok: false;
}

export type FoundationContextEncodeResult =
  | { readonly bytes: Uint8Array; readonly ok: true;
    readonly record: FoundationContextManifestRecord }
  | FoundationContextRefusal;

export type FoundationContextDecodeResult =
  | { readonly ok: true; readonly record: FoundationContextManifestRecord }
  | FoundationContextRefusal;

function refuse(code: FoundationContextManifestCode): FoundationContextRefusal {
  return Object.freeze({ code, layer: FOUNDATION_CONTEXT_CODEC, ok: false as const });
}

/** Bounded, non-empty text. */
function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

/**
 * A safe integer that is not negative zero.
 *
 * `Object.is` is the only check that sees `-0`: `JSON.stringify(-0)` is `"0"`,
 * so a canonical round-trip normalises it away and every byte comparison and
 * every digest over those bytes is identical to the `+0` case. A `>= 0` or
 * `=== 0` guard cannot distinguish them.
 */
function boundedInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && !Object.is(value, -0)
    && value >= 0 && value <= max;
}

/** Deep-freeze what we return; a shallow freeze leaves the arrays writable. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

/**
 * The outer digest, over the CANONICAL BYTES of the ten bound fields.
 *
 * Hashing canonical bytes rather than a reference or a coerced string is what
 * makes the digest actually depend on every field's value: `String(object)` is
 * `"[object Object]"` for every distinct record, so a reference-based digest
 * would collide across records that differ in any nested field.
 */
export function deriveFoundationContextRecordDigest(fields: unknown): string {
  const source = isRecord(fields) ? fields : {};
  const bound: Record<string, unknown> = { version: FOUNDATION_CONTEXT_RECORD_VERSION };
  for (const key of BOUND_KEYS) bound[key] = source[key];
  const encoded = encodeFoundationPayload(bound);
  return encoded.ok ? encoded.digest : "";
}

function admitManifest(value: unknown): ContextRenderManifest | FoundationContextRefusal {
  const manifest = exactKeys(value, MANIFEST_KEYS);
  if (manifest === null) return refuse("FOUNDATION_CONTEXT_MALFORMED");
  if (manifest["version"] !== CONTEXT_MANIFEST_VERSION) {
    return refuse("FOUNDATION_CONTEXT_VERSION_UNSUPPORTED");
  }
  const binding = exactKeys(manifest["binding"], BINDING_KEYS);
  if (binding === null || !boundedText(manifest["digest"])) {
    return refuse("FOUNDATION_CONTEXT_MALFORMED");
  }
  const bytes = binding["exactBytes"];
  if (!Array.isArray(bytes) || bytes.length === 0
    || !bytes.every((byte) => boundedInteger(byte, 255))) {
    return refuse("FOUNDATION_CONTEXT_MALFORMED");
  }
  if (!boundedText(binding["ordering"]) || !boundedText(binding["rendererVersion"])
    || !boundedInteger(binding["journalCountLimit"], MAX_EPOCH)
    || !boundedInteger(binding["journalTextLimit"], MAX_EPOCH)
    || !Array.isArray(binding["exclusions"]) || !Array.isArray(binding["optionalSelection"])) {
    return refuse("FOUNDATION_CONTEXT_MALFORMED");
  }
  const snapshot = snapshotFoundationValue(value);
  if (!isRecord(snapshot)) return refuse("FOUNDATION_CONTEXT_MALFORMED");
  // Recomputed from the caller's own binding, never trusted as declared.
  if (digestContextManifest(binding as never) !== manifest["digest"]) {
    return refuse("FOUNDATION_CONTEXT_MANIFEST_DIGEST_MISMATCH");
  }
  return snapshot as unknown as ContextRenderManifest;
}

function admitRecord(input: unknown): FoundationContextManifestRecord | FoundationContextRefusal {
  const record = exactKeys(input, FOUNDATION_CONTEXT_RECORD_KEYS);
  if (record === null) return refuse("FOUNDATION_CONTEXT_MALFORMED");
  const snapshot = snapshotFoundationValue(input);
  if (!isRecord(snapshot)) return refuse("FOUNDATION_CONTEXT_MALFORMED");
  for (const key of IDENTITY_KEYS) {
    if (!boundedText(snapshot[key])) return refuse("FOUNDATION_CONTEXT_MALFORMED");
  }
  if (!boundedInteger(snapshot["graphEpoch"], MAX_EPOCH)
    || !boundedText(snapshot["recordDigest"])) {
    return refuse("FOUNDATION_CONTEXT_MALFORMED");
  }
  const manifest = admitManifest(record["manifest"]);
  if ("ok" in manifest) return manifest;
  const admitted = { ...snapshot, manifest } as unknown as FoundationContextManifestRecord;
  if (deriveFoundationContextRecordDigest(admitted) !== admitted.recordDigest) {
    return refuse("FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH");
  }
  return deepFreeze(admitted);
}

/** Admit, derive, and canonically encode. Nothing is returned on a refusal. */
export function encodeFoundationContextManifestRecord(
  input: unknown,
): FoundationContextEncodeResult {
  const record = admitRecord(input);
  if ("ok" in record) return record;
  const encoded = encodeFoundationPayload(record);
  if (!encoded.ok) return refuse("FOUNDATION_CONTEXT_MALFORMED");
  return Object.freeze({ bytes: encoded.bytes, ok: true as const, record });
}

/**
 * Rebuild parsed values on `Object.prototype`.
 *
 * The bounded JSON parser builds every object with `Object.create(null)`
 * (bounded-json-parser.ts:87), and the shared descriptor-safe snapshot
 * deliberately refuses any non-array object whose prototype is not
 * `Object.prototype` — so a decoded payload can never be re-admitted as-is. This
 * is a prototype adapter over bytes THIS module already produced, not a second
 * canonical layer: it changes no key, no value and no ordering. A null-prototype
 * object arriving from a CALLER is still refused, because callers enter through
 * the encoder and never through here.
 */
function plainify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainify);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) out[key] = plainify(source[key]);
  return out;
}

/**
 * Bounded decode, full re-admission, then RE-ENCODE and byte-compare before any
 * authority is returned. The re-encode is what separates "these bytes parse to a
 * valid record" from "these bytes ARE the record" — an alternate encoding of the
 * same value parses identically and is refused here as NONCANONICAL.
 */
export function decodeFoundationContextManifestRecord(
  bytes: unknown,
): FoundationContextDecodeResult {
  const decoded = decodeFoundationPayload(bytes);
  if (!decoded.ok) return refuse("FOUNDATION_CONTEXT_MALFORMED");
  const encoded = encodeFoundationContextManifestRecord(plainify(decoded.value));
  if (!encoded.ok) return encoded;
  if (!(bytes instanceof Uint8Array) || !sameBytes(encoded.bytes, bytes)) {
    return refuse("FOUNDATION_CONTEXT_NONCANONICAL");
  }
  return Object.freeze({ ok: true as const, record: encoded.record });
}
