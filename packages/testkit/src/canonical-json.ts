import { Buffer } from "node:buffer";
import { types } from "node:util";

import { MAX_JSON_DEPTH, MAX_JSON_STRING_UTF8_BYTES } from "@moe/contracts";

export { CANONICAL_JSON_VERSION } from "@moe/contracts";

function unsupported(reason: string): never {
  throw new TypeError(`Unsupported canonical JSON value: ${reason}`);
}

function assertCanonicalString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        unsupported("lone surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      unsupported("lone surrogate");
    }
  }

  if (Buffer.byteLength(value, "utf8") > MAX_JSON_STRING_UTF8_BYTES) {
    unsupported(`string exceeds ${MAX_JSON_STRING_UTF8_BYTES} UTF-8 bytes`);
  }
}

function assertArrayKey(key: string | symbol, length: number): void {
  if (typeof key === "symbol") {
    unsupported("symbol-keyed property");
  }
  if (key === "length") {
    return;
  }
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    unsupported("non-index array property");
  }
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
    unsupported("non-index array property");
  }
}

function encodeArray(value: readonly unknown[], ancestors: Set<object>, depth: number): string {
  const encoded: string[] = [];
  const length = value.length;

  for (const key of Reflect.ownKeys(value)) {
    assertArrayKey(key, length);
  }

  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      unsupported("sparse array");
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      unsupported("accessor property");
    }
    encoded.push(encode(descriptor.value, ancestors, depth + 1));
  }

  return `[${encoded.join(",")}]`;
}

function encodeObject(value: object, ancestors: Set<object>, depth: number): string {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    unsupported("non-plain object");
  }

  const keys = Reflect.ownKeys(value).map((key): string => {
    if (typeof key === "symbol") {
      return unsupported("symbol-keyed property");
    }
    assertCanonicalString(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      throw new TypeError(`Canonical JSON property disappeared during encoding: ${key}`);
    }
    if (!descriptor.enumerable) {
      return unsupported("non-enumerable property");
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return unsupported("accessor property");
    }
    return key;
  });

  const entries = keys
    .sort()
    .map((key): string => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        throw new TypeError(`Canonical JSON property disappeared during encoding: ${key}`);
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        unsupported("accessor property");
      }
      return `${JSON.stringify(key)}:${encode(descriptor.value, ancestors, depth + 1)}`;
    });

  return `{${entries.join(",")}}`;
}

function encode(value: unknown, ancestors: Set<object>, depth: number): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return JSON.stringify(value);
    case "string":
      assertCanonicalString(value);
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        unsupported("non-finite number");
      }
      return JSON.stringify(value);
    case "undefined":
      return unsupported("undefined");
    case "bigint":
      return unsupported("bigint");
    case "symbol":
      return unsupported("symbol");
    case "function":
      return unsupported("function");
    case "object":
      if (types.isProxy(value)) {
        return unsupported("proxy");
      }
      if (depth >= MAX_JSON_DEPTH) {
        return unsupported(`maximum depth ${MAX_JSON_DEPTH} exceeded`);
      }
      if (ancestors.has(value)) {
        return unsupported("cyclic reference");
      }
      ancestors.add(value);
      try {
        return Array.isArray(value)
          ? encodeArray(value, ancestors, depth)
          : encodeObject(value, ancestors, depth);
      } finally {
        ancestors.delete(value);
      }
    default:
      return unsupported(`unknown type ${typeof value}`);
  }
}

export function canonicalize(value: unknown): string {
  return encode(value, new Set<object>(), 0);
}
