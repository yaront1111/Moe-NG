import { decodeBoundedJsonBytes } from "@moe/contracts";
import { createHash } from "node:crypto";

import {
  FOUNDATION_ATTEMPT_BINDING_KEYS, FOUNDATION_ATTEMPT_INPUT_KEYS,
  FOUNDATION_ATTEMPT_REQUEST_KEYS, FOUNDATION_ATTEMPT_SCHEMA_VERSION, refuseLocal,
} from "./foundation-attempt-contracts.js";
import type {
  FoundationAttemptDispatchRequest, FoundationAttemptRefused,
} from "./foundation-attempt-contracts.js";

const MAX_DEPTH = 12, MAX_KEYS = 64, MAX_ITEMS = 512;
const MAX_TEXT = 8_192, MAX_BYTES = 1_048_576;
/**
 * The ceiling for an array that carries BYTES rather than arbitrary values.
 *
 * It is `MAX_BYTES` itself, not a new number: the same payload bounded at
 * `Uint8Array.byteLength` below must be bounded identically when it arrives as a
 * JSON number array — a rendered context manifest carries its bytes that way.
 * Two independent byte ceilings would drift apart, and the looser one would then
 * be the real bound.
 *
 * Generic arrays keep `MAX_ITEMS`. Widening that constant instead would relax the
 * hostile-input bound for every consumer of this helper — the evidence service and
 * store, goal qualification, journal append and read, and attempt release — to
 * serve one caller.
 */
const MAX_BYTE_ITEMS = MAX_BYTES;

/**
 * A byte, as this codec means it. `-0` is excluded deliberately: `-0 === 0` and
 * `Number.isInteger(-0)` are both true and `JSON.stringify(-0)` is `"0"`, so a
 * negative zero survives a canonical round trip as a DIFFERENT value than the one
 * admitted. `Object.is` is the only check that sees it.
 */
const isByte = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value)
  && value >= 0 && value <= 255 && !Object.is(value, -0);
/** The ceiling the request guard below enforces, published so a transport that
 *  materializes those bytes bounds itself by THIS number rather than a copy. */
export { MAX_BYTES as FOUNDATION_ATTEMPT_MAX_REQUEST_BYTES };
const HOSTILE = Symbol("hostile");
const encoder = new TextEncoder();

function copyValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return HOSTILE;
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "boolean") return value;
  if (kind === "string") return (value as string).length > MAX_TEXT ? HOSTILE : value;
  if (kind === "number") return Number.isFinite(value) ? value : HOSTILE;
  if (kind !== "object") return HOSTILE;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) return HOSTILE;
  // LENGTH BEFORE MATERIALIZATION. Building the key list for an array is itself
  // one string allocation per element, so asking for it first hands a hostile
  // ten-million-element array the very walk this ceiling exists to refuse —
  // measured at 251ms for 5M elements before this check was hoisted.
  if (array && (value as unknown[]).length > MAX_BYTE_ITEMS) return HOSTILE;
  const keys = array ? (value as unknown[]).map((_, index) => String(index))
    : Object.keys(value as object);
  // THE HARD CEILING ANSWERS FIRST, BEFORE ANY TRAVERSAL. Deciding whether an
  // over-length array is "really bytes" costs one visit per element, so asking that
  // question first would let a hostile ten-million-element array buy a full walk —
  // the exact denial this bound exists to refuse. Length alone is checked here;
  // the byte test below runs only inside the walk that was already going to happen.
  if (keys.length > (array ? MAX_BYTE_ITEMS : MAX_KEYS)) return HOSTILE;
  // Past the generic array bound, ONLY a byte vector may continue, and every
  // element has to earn it: a sampled or first-element check would admit an array
  // of bytes carrying one smuggled value.
  const bytesOnly = array && keys.length > MAX_ITEMS;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return HOSTILE;
    if (bytesOnly && !isByte(descriptor.value)) return HOSTILE;
    const copied = copyValue(descriptor.value, depth + 1);
    if (copied === HOSTILE) return HOSTILE;
    out[key] = copied;
  }
  return array ? keys.map((key) => out[key]) : out;
}

/** One contained hostile-safe snapshot; reflection failures never escape. */
export function snapshotFoundationValue(value: unknown): unknown {
  try { return copyValue(value, 0); } catch { return HOSTILE; }
}

export function exactKeys(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== allowed.length) return null;
    const set = new Set(allowed);
    return keys.every((key) => set.has(key)) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;

export type FoundationAttemptDecodeResult =
  | { readonly ok: true; readonly request: FoundationAttemptDispatchRequest }
  | FoundationAttemptRefused;

export function decodeFoundationAttemptRequest(input: unknown): FoundationAttemptDecodeResult {
  const outer = exactKeys(input, FOUNDATION_ATTEMPT_REQUEST_KEYS);
  if (outer === null) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  const slots: Record<string, unknown> = {};
  try {
    for (const key of FOUNDATION_ATTEMPT_REQUEST_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(outer, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
      }
      slots[key] = descriptor.value;
    }
  } catch { return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED"); }
  const bytes = slots["activationRequestBytes"];
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  }
  const rest = snapshotFoundationValue({
    binding: slots["binding"], graphSnapshot: slots["graphSnapshot"],
    inputManifest: slots["inputManifest"],
  });
  if (rest === HOSTILE) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  const safe = rest as Record<string, unknown>;
  const binding = exactKeys(safe["binding"], FOUNDATION_ATTEMPT_BINDING_KEYS);
  const manifest = exactKeys(safe["inputManifest"], FOUNDATION_ATTEMPT_INPUT_KEYS);
  if (binding === null || manifest === null) {
    return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  }
  const entries = manifest["entries"];
  if (!text(binding["attemptAggregateId"]) || !text(binding["nodeKey"])
    || !text(binding["sessionId"]) || !text(manifest["baseIdentity"])
    || !Array.isArray(entries)) {
    return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  }
  return Object.freeze({ ok: true as const, request: Object.freeze({
    activationRequestBytes: new Uint8Array(bytes),
    binding: Object.freeze({ attemptAggregateId: binding["attemptAggregateId"],
      nodeKey: binding["nodeKey"], sessionId: binding["sessionId"] }),
    graphSnapshot: safe["graphSnapshot"],
    inputManifest: Object.freeze({ baseIdentity: manifest["baseIdentity"],
      entries: Object.freeze([...entries]) }),
  }) });
}

function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new TypeError("canonical depth");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("canonical type");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`;
}

export type FoundationCodecResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly digest: string }
  | FoundationAttemptRefused;
export function encodeFoundationPayload(value: unknown): FoundationCodecResult {
  let bytes: Uint8Array;
  try { bytes = encoder.encode(canonical(value)); }
  catch { return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT"); }
  if (bytes.byteLength > MAX_BYTES) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  return Object.freeze({ bytes, digest: sha256Hex(bytes), ok: true as const });
}

export type FoundationDecodedPayload =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | FoundationAttemptRefused;
export function decodeFoundationPayload(bytes: unknown): FoundationDecodedPayload {
  if (!(bytes instanceof Uint8Array)) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || decoded.value === null || typeof decoded.value !== "object"
    || Array.isArray(decoded.value)) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  return Object.freeze({ ok: true as const, value: decoded.value as Record<string, unknown> });
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => right[index] === byte);
export function deriveDispatchAggregateId(attemptAggregateId: string): string {
  const framed = `${FOUNDATION_ATTEMPT_SCHEMA_VERSION}\n${attemptAggregateId.length}\n${attemptAggregateId}`;
  return `foundation-dispatch-${sha256Hex(encoder.encode(framed))}`;
}

export function identifyFoundationDispatch(
  request: FoundationAttemptDispatchRequest, inputManifest: Record<string, unknown>,
): FoundationCodecResult {
  return encodeFoundationPayload({
    activationRequestDigest: sha256Hex(request.activationRequestBytes), binding: request.binding,
    graphSnapshot: request.graphSnapshot, inputManifest,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  try { return typeof value === "object" && value !== null && !Array.isArray(value); }
  catch { return false; }
}
export function textOf(value: unknown, key: string): string | null {
  try { return isRecord(value) && typeof value[key] === "string" ? value[key] as string : null; }
  catch { return null; }
}
