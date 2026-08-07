export const BOUNDED_JSON_ERROR_CODES = Object.freeze([
  "JSON_INPUT_TYPE_INVALID",
  "JSON_BODY_LIMIT_EXCEEDED",
  "JSON_UTF8_INVALID",
  "JSON_SYNTAX_INVALID",
  "JSON_DEPTH_LIMIT_EXCEEDED",
  "JSON_STRING_LIMIT_EXCEEDED",
  "JSON_DUPLICATE_KEY",
  "JSON_UNICODE_INVALID",
  "JSON_NUMBER_RANGE_INVALID",
] as const);

export type BoundedJsonErrorCode = (typeof BOUNDED_JSON_ERROR_CODES)[number];

export type JsonPrimitive = null | boolean | number | string;

/**
 * Decoder-created objects have a null prototype and are recursively frozen.
 * Consumers must use `Object.hasOwn(value, key)`, not prototype methods.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** A deeply frozen, safely snapshotted JSON value. */
export interface BoundedJsonDecodeOk {
  readonly ok: true;
  readonly value: JsonValue;
}

export interface BoundedJsonDecodeError {
  readonly ok: false;
  readonly code: BoundedJsonErrorCode;
  readonly message: string;
}

export type BoundedJsonDecodeResult = BoundedJsonDecodeOk | BoundedJsonDecodeError;
