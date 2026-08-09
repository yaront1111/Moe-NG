import { types } from "node:util";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "buffer",
)?.get as ((this: Uint8Array) => ArrayBufferLike) | undefined;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "byteLength",
)?.get as ((this: Uint8Array) => number) | undefined;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "byteOffset",
)?.get as ((this: Uint8Array) => number) | undefined;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "resizable",
)?.get as ((this: ArrayBuffer) => boolean) | undefined;
const typedArraySet = Uint8Array.prototype.set;

export function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) return null;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export function exactDataArray(value: unknown): readonly unknown[] | null {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1
    || ownKeys[value.length] !== "length"
  ) return null;
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (ownKeys[index] !== String(index)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

export function copyFixedBytes(value: unknown): Uint8Array | null {
  if (
    typedArrayBuffer === undefined
    || typedArrayByteLength === undefined
    || typedArrayByteOffset === undefined
    || types.isProxy(value)
    || !types.isUint8Array(value)
  ) return null;
  try {
    const source = value as Uint8Array;
    const buffer = typedArrayBuffer.call(source);
    if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) return null;
    if (arrayBufferResizable?.call(buffer) === true) return null;
    const length = typedArrayByteLength.call(source);
    const offset = typedArrayByteOffset.call(source);
    const view = new Uint8Array(buffer, offset, length);
    const copy = new Uint8Array(length);
    typedArraySet.call(copy, view);
    return copy;
  } catch {
    return null;
  }
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
