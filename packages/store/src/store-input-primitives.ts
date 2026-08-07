import { types } from "node:util";

import {
  DurableStoreError,
  MAX_PAGE_SIZE,
} from "./store-contracts.js";
import {
  MAX_IDENTIFIER_UTF8_BYTES,
  MAX_SQLITE_INTEGER,
  canonicalTimestampPattern,
  stringIsWellFormed,
  textEncoder,
} from "./store-internals.js";
import type { DataRecord } from "./store-internals.js";

export function invalidInput(message: string): never {
  throw new DurableStoreError("STORE_INPUT_INVALID", message);
}

export function limitExceeded(message: string): never {
  throw new DurableStoreError("STORE_LIMIT_EXCEEDED", message);
}

export function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_UTF8_BYTES ||
    !Reflect.apply(stringIsWellFormed, value, []) ||
    value.includes("\0") ||
    textEncoder.encode(value).byteLength > MAX_IDENTIFIER_UTF8_BYTES
  ) {
    return invalidInput(
      `${field} must be well-formed, non-empty, at most ${MAX_IDENTIFIER_UTF8_BYTES} UTF-8 bytes, and contain no NUL`,
    );
  }
  return value;
}

export function requireSafeNonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidInput(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function requireSafePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidInput(`${field} must be a positive safe integer`);
  }
  return value;
}

export function requireNonnegativeBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_SQLITE_INTEGER) {
    return invalidInput(`${field} must be a non-negative SQLite-range bigint`);
  }
  return value;
}

export function requirePageLimit(value: unknown): number {
  const limit = requireSafePositiveInteger(value, "limit");
  if (limit > MAX_PAGE_SIZE) {
    return limitExceeded(`limit cannot exceed ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

export function requireCanonicalTimestamp(value: unknown, field = "committedAt"): string {
  if (
    typeof value !== "string" ||
    !canonicalTimestampPattern.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return invalidInput(`${field} must be a canonical UTC timestamp with millisecond precision`);
  }
  return value;
}

export function requireDataRecord(value: unknown, field: string): DataRecord {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    return invalidInput(`${field} must be a non-proxy data object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidInput(`${field} must be a plain data object`);
  }
  return value as DataRecord;
}

export function readOwnDataProperty(
  record: DataRecord,
  key: string,
  field: string,
  required = true,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    if (required) {
      return invalidInput(`${field} is required`);
    }
    return undefined;
  }
  if (!("value" in descriptor)) {
    return invalidInput(`${field} must be an own data property`);
  }
  return descriptor.value;
}
