/**
 * Canonical, self-verifying bytes for one provider-run record.
 *
 * The digest domain is the canonical record with `recordDigest` excluded. The
 * computed digest is then attached to the body and repeated in the final frame;
 * a caller-supplied digest is never trusted. Undefined, sparse arrays,
 * non-finite numbers, accessors, symbols and cycles refuse rather than being
 * silently collapsed by JSON. Null is data and an absent property stays absent.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import { PROVIDER_RUN_RECORD_VERSION } from "./provider-run-contracts.js";
import type { ProviderRunRecord } from "./provider-run-contracts.js";
import {
  PROVIDER_RUN_LEDGER_CODES,
  PROVIDER_RUN_LEDGER_LAYERS,
  providerRunRefusal,
  providerRunUnknown,
} from "./provider-run-refusals.js";
import type { ProviderRunRefusal } from "./provider-run-refusals.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEADER = encoder.encode(`${PROVIDER_RUN_RECORD_VERSION}\n`);
const LENGTH_BYTES = 4;
const DIGEST_BYTES = 64;
const MAX_RECORD_BYTES = 1_048_576;
const HEX64 = /^[0-9a-f]{64}$/u;
const VERSION_KEY = "recordVersion" satisfies keyof ProviderRunRecord;
const DIGEST_KEY = "recordDigest" satisfies keyof ProviderRunRecord;
const LAYER = PROVIDER_RUN_LEDGER_LAYERS[1];
const CODE = Object.freeze({
  recordMalformed: PROVIDER_RUN_LEDGER_CODES[0],
  fieldInvalid: PROVIDER_RUN_LEDGER_CODES[1],
  versionUnsupported: PROVIDER_RUN_LEDGER_CODES[2],
  bytesMalformed: PROVIDER_RUN_LEDGER_CODES[6],
  digestMismatch: PROVIDER_RUN_LEDGER_CODES[7],
  recordUnreadable: PROVIDER_RUN_LEDGER_CODES[8],
});
export interface ProviderRunEncodeSuccess {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly record: ProviderRunRecord;
}
export interface ProviderRunDecodeSuccess {
  readonly ok: true;
  readonly digest: string;
  readonly record: ProviderRunRecord;
}

export type ProviderRunEncodeResult = ProviderRunEncodeSuccess | ProviderRunRefusal;
export type ProviderRunDecodeResult = ProviderRunDecodeSuccess | ProviderRunRefusal;
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function canonicalArray(value: readonly unknown[], stack: Set<object>): string | null {
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) return null;
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    const part = canonicalJson(descriptor.value, stack);
    if (part === null) return null;
    parts.push(part);
  }
  return `[${parts.join(",")}]`;
}

function canonicalObject(value: Record<string, unknown>, stack: Set<object>): string | null {
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const parts: string[] = [];
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    const part = canonicalJson(descriptor.value, stack);
    if (part === null) return null;
    parts.push(`${JSON.stringify(key)}:${part}`);
  }
  return `{${parts.join(",")}}`;
}

function canonicalJson(value: unknown, stack = new Set<object>()): string | null {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (typeof value !== "object") return null;
  if (types.isProxy(value)) return null;
  if (stack.has(value)) return null;
  stack.add(value);
  try {
    if (Array.isArray(value)) return canonicalArray(value, stack);
    if (isPlainObject(value)) return canonicalObject(value, stack);
    return null;
  } finally {
    stack.delete(value);
  }
}

function withoutDigest(value: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const reduced = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    if (key === DIGEST_KEY) continue;
    reduced[key] = descriptor.value;
  }
  return reduced;
}

function digest(text: string): string {
  return createHash("sha256").update(encoder.encode(text)).digest("hex");
}

function frozenSnapshot(text: string): ProviderRunRecord {
  const record = JSON.parse(text) as ProviderRunRecord;
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  };
  freeze(record);
  return record;
}

function seal(body: Uint8Array, recordDigest: string): Uint8Array | null {
  const total = HEADER.length + LENGTH_BYTES + body.length + LENGTH_BYTES + DIGEST_BYTES;
  if (total > MAX_RECORD_BYTES) return null;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(HEADER, 0);
  view.setUint32(HEADER.length, body.length, false);
  const bodyStart = HEADER.length + LENGTH_BYTES;
  bytes.set(body, bodyStart);
  view.setUint32(bodyStart + body.length, DIGEST_BYTES, false);
  bytes.set(encoder.encode(recordDigest), bodyStart + body.length + LENGTH_BYTES);
  return bytes;
}

export function encodeProviderRunRecord(value: unknown): ProviderRunEncodeResult {
  try {
    if (!isPlainObject(value)) return providerRunRefusal("REFUSED", CODE.recordMalformed, LAYER);
    const reduced = withoutDigest(value);
    if (reduced === null) return providerRunRefusal("REFUSED", CODE.fieldInvalid, LAYER);
    if (reduced[VERSION_KEY] !== PROVIDER_RUN_RECORD_VERSION) {
      return providerRunRefusal("REFUSED", CODE.versionUnsupported, LAYER);
    }
    const domain = canonicalJson(reduced);
    if (domain === null) return providerRunRefusal("REFUSED", CODE.fieldInvalid, LAYER);
    const recordDigest = digest(domain);
    const bodyText = canonicalJson({ ...reduced, [DIGEST_KEY]: recordDigest });
    if (bodyText === null) return providerRunRefusal("REFUSED", CODE.fieldInvalid, LAYER);
    const bytes = seal(encoder.encode(bodyText), recordDigest);
    if (bytes === null) return providerRunRefusal("REFUSED", CODE.fieldInvalid, LAYER);
    const record = frozenSnapshot(bodyText);
    return Object.freeze({ bytes, digest: recordDigest, ok: true as const, record });
  } catch {
    return providerRunRefusal("REFUSED", CODE.fieldInvalid, LAYER);
  }
}

type SplitResult = { readonly body: Uint8Array; readonly digest: string };

function splitSealed(bytes: Uint8Array): SplitResult | null {
  const minimum = HEADER.length + LENGTH_BYTES + 1 + LENGTH_BYTES + DIGEST_BYTES;
  if (bytes.byteLength < minimum || bytes.byteLength > MAX_RECORD_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bodyLength = view.getUint32(HEADER.length, false);
  const bodyStart = HEADER.length + LENGTH_BYTES;
  const tailStart = bodyStart + bodyLength;
  if (tailStart + LENGTH_BYTES + DIGEST_BYTES !== bytes.byteLength) return null;
  if (view.getUint32(tailStart, false) !== DIGEST_BYTES) return null;
  let carried: string;
  try {
    carried = decoder.decode(bytes.subarray(tailStart + LENGTH_BYTES));
  } catch {
    return null;
  }
  if (!HEX64.test(carried)) return null;
  return { body: bytes.subarray(bodyStart, tailStart), digest: carried };
}

function headerStatus(bytes: Uint8Array): "OK" | "BYTES" | "VERSION" {
  const newline = Uint8Array.prototype.indexOf.call(bytes, 10);
  if (newline < 0) return "BYTES";
  let version: string;
  try {
    version = decoder.decode(bytes.subarray(0, newline));
  } catch {
    return "BYTES";
  }
  return version === PROVIDER_RUN_RECORD_VERSION && newline + 1 === HEADER.length ? "OK" : "VERSION";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeProviderRunRecordUnsafe(value: unknown): ProviderRunDecodeResult {
  if (!(value instanceof Uint8Array) || types.isProxy(value) || value.byteLength === 0) {
    return providerRunUnknown(CODE.bytesMalformed, LAYER);
  }
  if (value.byteLength > MAX_RECORD_BYTES) return providerRunUnknown(CODE.bytesMalformed, LAYER);
  const bytes = Uint8Array.from(value);
  const header = headerStatus(bytes);
  if (header === "BYTES") return providerRunUnknown(CODE.bytesMalformed, LAYER);
  if (header === "VERSION") return providerRunUnknown(CODE.versionUnsupported, LAYER);
  const sealed = splitSealed(bytes);
  if (sealed === null) return providerRunUnknown(CODE.bytesMalformed, LAYER);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(sealed.body)) as unknown;
  } catch {
    return providerRunUnknown(CODE.bytesMalformed, LAYER);
  }
  if (!isPlainObject(parsed)) return providerRunUnknown(CODE.recordUnreadable, LAYER);
  if (!(VERSION_KEY in parsed)) return providerRunUnknown(CODE.recordUnreadable, LAYER);
  if (parsed[VERSION_KEY] !== PROVIDER_RUN_RECORD_VERSION) {
    return providerRunUnknown(CODE.versionUnsupported, LAYER);
  }
  const reencoded = encodeProviderRunRecord(parsed);
  if (!reencoded.ok) return providerRunUnknown(CODE.recordUnreadable, LAYER);
  if (reencoded.digest !== sealed.digest) return providerRunUnknown(CODE.digestMismatch, LAYER);
  const canonical = splitSealed(reencoded.bytes);
  if (canonical === null) return providerRunUnknown(CODE.recordUnreadable, LAYER);
  if (!equalBytes(canonical.body, sealed.body)) return providerRunUnknown(CODE.digestMismatch, LAYER);
  return Object.freeze({ digest: reencoded.digest, ok: true as const, record: reencoded.record });
}

export function decodeProviderRunRecord(value: unknown): ProviderRunDecodeResult {
  try {
    return decodeProviderRunRecordUnsafe(value);
  } catch {
    return providerRunUnknown(CODE.bytesMalformed, LAYER);
  }
}
