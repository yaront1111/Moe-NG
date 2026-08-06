import { types } from "node:util";

export type DataPropertyRead =
  | { readonly ok: false }
  | { readonly ok: true; readonly present: false }
  | { readonly ok: true; readonly present: true; readonly value: unknown };

function isProxy(value: object): boolean {
  try {
    return types.isProxy(value);
  } catch {
    return true;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || isProxy(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function isPlainArray(value: unknown): value is unknown[] {
  if (typeof value !== "object" || value === null || isProxy(value)) {
    return false;
  }
  try {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    return false;
  }
}

export function readOwnDataProperty(
  value: object,
  key: string,
): DataPropertyRead {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return { ok: true, present: false };
    }
    if (!("value" in descriptor)) {
      return { ok: false };
    }
    return { ok: true, present: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

export function hasOnlyOwnStringKeys(
  value: object,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  try {
    return Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowed.has(key),
    );
  } catch {
    return false;
  }
}

export function readPlainArrayLength(value: unknown[]): number | null {
  const result = readOwnDataProperty(value, "length");
  if (
    !result.ok ||
    !result.present ||
    typeof result.value !== "number" ||
    !Number.isSafeInteger(result.value) ||
    result.value < 0
  ) {
    return null;
  }
  return result.value;
}

/**
 * Accept only canonical dense array indices plus the built-in length property.
 * Callers must first cap `length`; this helper then rejects holes, accessors,
 * expando fields, and symbol keys without reading any element value.
 */
export function hasExactDenseArrayShape(
  value: unknown[],
  length: number,
): boolean {
  if (!Number.isSafeInteger(length) || length < 0) {
    return false;
  }
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) {
      return false;
    }
    for (const key of keys) {
      if (key === "length") {
        continue;
      }
      if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
        return false;
      }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= length) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function readOwnArrayElement(
  value: unknown[],
  index: number,
): DataPropertyRead {
  return readOwnDataProperty(value, String(index));
}
