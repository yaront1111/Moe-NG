import { types } from "node:util";

import { MAX_FAIRNESS_ID_UTF8_BYTES } from "./fairness-policy.js";

const utf8 = new TextEncoder();

/** Read an own-data-property record without invoking caller code. */
export function readDataRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return null;
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

/** Snapshot a dense data-property array with a caller-provided cardinality cap. */
export function readDataArray(value: unknown, maxLength: number): readonly unknown[] | null {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return null;
  try {
    if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length > maxLength) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) return null;
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return null;
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

/** Inspect only the intrinsic dense-array length, without invoking proxy traps. */
export function arrayLengthExceeds(value: unknown, maxLength: number): boolean {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  try {
    return Array.isArray(value) && value.length > maxLength;
  } catch {
    return false;
  }
}

/** JSON-safe, bounded identity string (well-formed Unicode, non-empty). */
export function isFairnessId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > MAX_FAIRNESS_ID_UTF8_BYTES) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return utf8.encode(value).byteLength <= MAX_FAIRNESS_ID_UTF8_BYTES;
}

export function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
