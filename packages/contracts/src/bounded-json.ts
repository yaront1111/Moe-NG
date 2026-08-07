import { types } from "node:util";

import type {
  BoundedJsonDecodeResult,
  BoundedJsonErrorCode,
  JsonValue,
} from "./bounded-json-model.js";
import { BoundedJsonParseError, parseBoundedJsonText } from "./bounded-json-parser.js";
import { MAX_JSON_BODY_BYTES } from "./input-limits.js";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "resizable",
)?.get;
const arrayBufferDetached = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "detached",
)?.get;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const ERROR_MESSAGES: Readonly<Record<BoundedJsonErrorCode, string>> = Object.freeze({
  JSON_BODY_LIMIT_EXCEEDED: `JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes.`,
  JSON_DEPTH_LIMIT_EXCEEDED: "JSON nesting exceeds the supported depth.",
  JSON_DUPLICATE_KEY: "JSON object contains a duplicate decoded key.",
  JSON_INPUT_TYPE_INVALID: "JSON input must be a supported fixed byte array.",
  JSON_NUMBER_RANGE_INVALID: "JSON number is outside the supported finite precision range.",
  JSON_STRING_LIMIT_EXCEEDED: "JSON string exceeds the supported UTF-8 byte limit.",
  JSON_SYNTAX_INVALID: "JSON text is not syntactically valid.",
  JSON_UNICODE_INVALID: "JSON string contains invalid Unicode.",
  JSON_UTF8_INVALID: "JSON input is not valid UTF-8.",
});

function failure(code: BoundedJsonErrorCode): BoundedJsonDecodeResult {
  return Object.freeze({ ok: false, code, message: ERROR_MESSAGES[code] });
}

function snapshotBytes(input: unknown): Uint8Array | BoundedJsonDecodeResult {
  if (types.isProxy(input) || !types.isUint8Array(input)) {
    return failure("JSON_INPUT_TYPE_INVALID");
  }
  if (!typedArrayBuffer || !typedArrayByteLength || !typedArrayByteOffset) {
    return failure("JSON_INPUT_TYPE_INVALID");
  }

  try {
    const buffer = Reflect.apply(typedArrayBuffer, input, []) as ArrayBufferLike;
    if (types.isSharedArrayBuffer(buffer) || !types.isArrayBuffer(buffer)) {
      return failure("JSON_INPUT_TYPE_INVALID");
    }
    if (arrayBufferResizable && Reflect.apply(arrayBufferResizable, buffer, []) === true) {
      return failure("JSON_INPUT_TYPE_INVALID");
    }
    if (arrayBufferDetached && Reflect.apply(arrayBufferDetached, buffer, []) === true) {
      return failure("JSON_INPUT_TYPE_INVALID");
    }

    const byteLength = Reflect.apply(typedArrayByteLength, input, []) as number;
    const byteOffset = Reflect.apply(typedArrayByteOffset, input, []) as number;
    if (byteLength > MAX_JSON_BODY_BYTES) return failure("JSON_BODY_LIMIT_EXCEEDED");

    const source = new Uint8Array(buffer, byteOffset, byteLength);
    const snapshot = new Uint8Array(byteLength);
    snapshot.set(source);
    return snapshot;
  } catch {
    return failure("JSON_INPUT_TYPE_INVALID");
  }
}

function deepFreeze(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
  } else {
    const record = value as Readonly<Record<string, JsonValue>>;
    for (const key of Object.keys(record)) deepFreeze(record[key] as JsonValue);
  }
  return Object.freeze(value);
}

/**
 * Snapshots and decodes a fixed Uint8Array/Buffer without granting schema or
 * command authority. Hostile input returns a frozen stable error; it never
 * escapes as an exception.
 */
export function decodeBoundedJsonBytes(input: unknown): BoundedJsonDecodeResult {
  const snapshot = snapshotBytes(input);
  if (!(snapshot instanceof Uint8Array)) return snapshot;

  let text: string;
  try {
    text = decoder.decode(snapshot);
  } catch {
    return failure("JSON_UTF8_INVALID");
  }

  try {
    const value = deepFreeze(parseBoundedJsonText(text));
    return Object.freeze({ ok: true, value });
  } catch (error) {
    if (error instanceof BoundedJsonParseError) return failure(error.code);
    return failure("JSON_SYNTAX_INVALID");
  }
}
