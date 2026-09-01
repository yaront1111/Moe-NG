import { types } from "node:util";

import { MAX_IDENTIFIER_UTF8_BYTES, stringIsWellFormed } from "./store-internals.js";

export const MAX_RECOVERY_SLOT_MANIFEST_BYTES = 65_536;
export const RECOVERY_SLOT_SHA256 = /^[0-9a-f]{64}$/u;

const textEncoder = new TextEncoder();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;

export function isPlainRecord(value: unknown): value is object {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!isPlainRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string")) return null;
  if (expectedKeys.some((key) => !keys.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

export function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_UTF8_BYTES &&
    Reflect.apply(stringIsWellFormed, value, []) &&
    !value.includes("\0") &&
    textEncoder.encode(value).byteLength <= MAX_IDENTIFIER_UTF8_BYTES
  );
}

export function safePayloadPath(value: string): boolean {
  if (!boundedIdentifier(value) || value.startsWith("/") || value.includes("\\")) return false;
  if (/^[a-zA-Z]:\//u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function readPayloadDigests(
  value: unknown,
  requireNonempty: boolean,
  sortPaths: boolean,
): Readonly<Record<string, string>> | null {
  if (!isPlainRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (requireNonempty && keys.length === 0) return null;
  if (keys.some((key) => typeof key !== "string" || !safePayloadPath(key))) return null;
  const copy: Record<string, string> = Object.create(null) as Record<string, string>;
  const paths = keys as string[];
  for (const key of sortPaths ? [...paths].sort() : paths) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    if (typeof descriptor.value !== "string" || !RECOVERY_SLOT_SHA256.test(descriptor.value)) {
      return null;
    }
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

export function snapshotBytes(value: unknown): Uint8Array | null {
  if (value === null || typeof value !== "object" || types.isProxy(value) || !types.isUint8Array(value)) {
    return null;
  }
  if (bufferGetter === undefined || byteLengthGetter === undefined || byteOffsetGetter === undefined) {
    return null;
  }
  const buffer = Reflect.apply(bufferGetter, value, []) as ArrayBufferLike;
  if (!types.isAnyArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) return null;
  const byteLength = Reflect.apply(byteLengthGetter, value, []) as number;
  const byteOffset = Reflect.apply(byteOffsetGetter, value, []) as number;
  if (byteLength === 0 || byteLength > MAX_RECOVERY_SLOT_MANIFEST_BYTES) return null;
  const snapshot = new Uint8Array(byteLength);
  snapshot.set(new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength));
  return snapshot;
}
