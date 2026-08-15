import { decodeBoundedJsonBytes } from "@moe/contracts";
import { createHash } from "node:crypto";

import {
  FOUNDATION_ATTEMPT_BINDING_KEYS, FOUNDATION_ATTEMPT_INPUT_KEYS,
  FOUNDATION_ATTEMPT_REQUEST_KEYS, FOUNDATION_ATTEMPT_RUNTIME_KEYS, FOUNDATION_ATTEMPT_SCHEMA_VERSION,
  FOUNDATION_ATTEMPT_TEMPLATE_KEYS, refuseLocal,
} from "./foundation-attempt-contracts.js";
import type {
  FoundationAttemptDispatchRequest, FoundationAttemptRefused,
} from "./foundation-attempt-contracts.js";

const MAX_DEPTH = 12, MAX_KEYS = 64, MAX_ITEMS = 512;
const MAX_TEXT = 8_192, MAX_BYTES = 1_048_576;
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
  const keys = array ? (value as unknown[]).map((_, index) => String(index))
    : Object.keys(value as object);
  if (keys.length > (array ? MAX_ITEMS : MAX_KEYS)) return HOSTILE;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return HOSTILE;
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

function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.length > MAX_KEYS || !entries.every(([, item]) => typeof item === "string")) {
      return null;
    }
    return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
  } catch { return null; }
}

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
    inputManifest: slots["inputManifest"], launchTemplate: slots["launchTemplate"],
  });
  if (rest === HOSTILE) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  const safe = rest as Record<string, unknown>;
  const binding = exactKeys(safe["binding"], FOUNDATION_ATTEMPT_BINDING_KEYS);
  const manifest = exactKeys(safe["inputManifest"], FOUNDATION_ATTEMPT_INPUT_KEYS);
  const template = exactKeys(safe["launchTemplate"], FOUNDATION_ATTEMPT_TEMPLATE_KEYS);
  if (binding === null || manifest === null || template === null) {
    return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  }
  const environment = stringRecord(template["environment"]);
  const runtime = exactKeys(template["runtime"], FOUNDATION_ATTEMPT_RUNTIME_KEYS);
  const argv = template["argv"], entries = manifest["entries"];
  if (!text(binding["attemptAggregateId"]) || !text(binding["nodeKey"])
    || !text(binding["sessionId"]) || !text(manifest["baseIdentity"])
    || !Array.isArray(entries) || !Array.isArray(argv) || !argv.every(text)
    || !text(template["cwd"]) || environment === null || runtime === null
    || !text(runtime["installedRoot"]) || !text(runtime["pinRoot"])
    || !isRecord(runtime["quotedObservation"])
    || !text(template["bootstrapCredentialDigest"])) {
    return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
  }
  return Object.freeze({ ok: true as const, request: Object.freeze({
    activationRequestBytes: new Uint8Array(bytes),
    binding: Object.freeze({ attemptAggregateId: binding["attemptAggregateId"],
      nodeKey: binding["nodeKey"], sessionId: binding["sessionId"] }),
    graphSnapshot: safe["graphSnapshot"],
    inputManifest: Object.freeze({ baseIdentity: manifest["baseIdentity"],
      entries: Object.freeze([...entries]) }),
    launchTemplate: Object.freeze({ argv: Object.freeze([...argv]),
      bootstrapCredentialDigest: template["bootstrapCredentialDigest"], cwd: template["cwd"],
      environment, launchSelection: template["launchSelection"], limits: template["limits"],
      runtime: Object.freeze({ installedRoot: runtime["installedRoot"], pinRoot: runtime["pinRoot"],
        quotedObservation: runtime["quotedObservation"] }) }),
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
    graphSnapshot: request.graphSnapshot, inputManifest, launchTemplate: request.launchTemplate,
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
