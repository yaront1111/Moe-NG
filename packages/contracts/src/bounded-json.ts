import type {
  BoundedJsonDecodeResult,
  BoundedJsonErrorCode,
  JsonValue,
} from "./bounded-json-model.js";
import { BoundedJsonParseError, parseBoundedJsonText } from "./bounded-json-parser.js";
import { MAX_JSON_BODY_BYTES } from "./input-limits.js";

// Browser-safety invariant: this module must not import any node:* builtin.
// @moe/contracts loads inside browser bundles (apps/control-room), where the
// bundler externalizes node builtins and the import crashes at module load.
// Input classification therefore relies on saved native accessors whose
// internal-slot brand checks are equally hostile-proof in pure ECMAScript:
// internal-slot access never tunnels through Proxy traps, so a Proxy over a
// real Uint8Array fails the brand check exactly as the former isProxy
// refusal did, and forged prototype-only objects fail it too.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
// %TypedArray%.prototype[@@toStringTag] reads [[TypedArrayName]]: it yields
// "Uint8Array" only for genuine Uint8Array instances (subclasses such as
// Buffer included, cross-realm safe) and undefined for proxies, revoked
// proxies, forged objects, DataView, and every other typed-array kind.
const typedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get;
// ArrayBuffer.prototype.byteLength requires [[ArrayBufferData]] and throws a
// TypeError when the receiver is a SharedArrayBuffer or any non-ArrayBuffer,
// replacing both former shared/non-shared util checks without ever naming
// SharedArrayBuffer (which is absent in non-cross-origin-isolated browsers).
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
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
  if (
    !typedArrayTag ||
    !typedArrayBuffer ||
    !typedArrayByteLength ||
    !typedArrayByteOffset ||
    !arrayBufferByteLength
  ) {
    return failure("JSON_INPUT_TYPE_INVALID");
  }

  try {
    if (Reflect.apply(typedArrayTag, input, []) !== "Uint8Array") {
      return failure("JSON_INPUT_TYPE_INVALID");
    }

    const buffer = Reflect.apply(typedArrayBuffer, input, []) as ArrayBufferLike;
    // Brand check: throws for SharedArrayBuffer-backed views and anything
    // else lacking a non-shared [[ArrayBufferData]] internal slot.
    Reflect.apply(arrayBufferByteLength, buffer, []);
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
