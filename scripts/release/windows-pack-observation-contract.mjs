import { createHash } from "node:crypto";

export const WINDOWS_PACK_OBSERVATION_SCHEMA_VERSION = "moe-pack-observation/1";
export const WINDOWS_RELEASE_AUTHORITY_LAYER = "WINDOWS_RELEASE_AUTHORITY";

export const WINDOWS_RELEASE_AUTHORITY_CODES = Object.freeze({
  ARTIFACT_MISMATCH: "WINDOWS_RELEASE_ARTIFACT_MISMATCH",
  INPUT_INVALID: "WINDOWS_RELEASE_INPUT_INVALID",
  PUBLICATION_CONFLICT: "WINDOWS_RELEASE_PUBLICATION_CONFLICT",
  SOURCE_MISMATCH: "WINDOWS_RELEASE_SOURCE_MISMATCH",
});

export class WindowsReleaseAuthorityError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "WindowsReleaseAuthorityError";
    this.code = code;
    this.layer = WINDOWS_RELEASE_AUTHORITY_LAYER;
  }
}

/** @param {string} code @returns {never} */
export function refuseWindowsRelease(code) {
  throw new WindowsReleaseAuthorityError(code);
}

/** @param {unknown} value */
export function isPlainRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {readonly string[]} expected */
export function exactDataRecordSnapshot(value, expected) {
  try {
    if (!isPlainRecord(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const keys = /** @type {string[]} */ (ownKeys).sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
    const valid = Object.values(descriptors).every((descriptor) =>
      descriptor.enumerable === true && "value" in descriptor && !("get" in descriptor) && !("set" in descriptor));
    if (!valid) return null;
    return Object.freeze(Object.fromEntries(expected.map((key) => [key, descriptors[key]?.value])));
  } catch {
    return null;
  }
}

/** @param {unknown} value @param {readonly string[]} expected */
export function exactDataRecord(value, expected) {
  return exactDataRecordSnapshot(value, expected) !== null;
}

/** @param {unknown} value @returns {string} */
export function canonicalWindowsReleaseValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalWindowsReleaseValue).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalWindowsReleaseValue(record[key])}`).join(",")}}`;
  }
  const primitive = JSON.stringify(value);
  if (primitive === undefined) refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  return primitive;
}

/** @param {string | Uint8Array} bytes */
export function windowsReleaseSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @template T @param {T} value @returns {T} */
export function deepFreezeWindowsRelease(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeWindowsRelease(child);
    Object.freeze(value);
  }
  return value;
}

/** @param {unknown} receipt */
export function canonicalWindowsPackObservationBytes(receipt) {
  return new TextEncoder().encode(canonicalWindowsReleaseValue(receipt));
}
