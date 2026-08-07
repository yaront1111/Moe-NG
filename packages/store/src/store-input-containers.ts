import { types } from "node:util";

import {
  MAX_BLOB_BYTES,
  MAX_COMMIT_BYTES,
} from "./store-contracts.js";
import type { ByteBudget } from "./store-internals.js";
import {
  invalidInput,
  limitExceeded,
} from "./store-input-primitives.js";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;

function requireTypedArrayGetter(name: "buffer" | "byteLength" | "byteOffset"): () => unknown {
  const getter = Object.getOwnPropertyDescriptor(typedArrayPrototype, name)?.get;
  if (getter === undefined) {
    throw new Error(`Node runtime lacks intrinsic typed-array ${name} accessor`);
  }
  return getter;
}

const typedArrayBufferGetter = requireTypedArrayGetter("buffer");
const typedArrayByteLengthGetter = requireTypedArrayGetter("byteLength");
const typedArrayByteOffsetGetter = requireTypedArrayGetter("byteOffset");

export function snapshotDenseArray(
  value: unknown,
  field: string,
  maximumLength?: number,
): readonly unknown[] {
  if (types.isProxy(value) || !Array.isArray(value)) {
    return invalidInput(`${field} must be a non-proxy array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return invalidInput(`${field} must be a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    return invalidInput(`${field} has an invalid length`);
  }
  if (maximumLength !== undefined && length > maximumLength) {
    return limitExceeded(`${field} cannot exceed ${maximumLength} elements`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidInput(`${field} must be dense and contain only data elements`);
    }
    snapshot.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (
      key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)
    ) {
      return invalidInput(`${field} cannot contain non-index properties`);
    }
  }
  return snapshot;
}

export function snapshotBytes(
  value: unknown,
  field: string,
  budget?: ByteBudget,
): Uint8Array {
  if (types.isProxy(value) || !types.isUint8Array(value)) {
    return invalidInput(`${field} must be a non-proxy Uint8Array`);
  }

  let buffer: ArrayBufferLike;
  let byteLength: number;
  let byteOffset: number;
  try {
    buffer = Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBufferLike;
    byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
    byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as number;
  } catch {
    return invalidInput(`${field} must be a Uint8Array`);
  }
  if (types.isSharedArrayBuffer(buffer)) {
    return invalidInput(`${field} cannot use a shared backing buffer`);
  }
  if (byteLength > MAX_BLOB_BYTES) {
    return limitExceeded(`${field} exceeds ${MAX_BLOB_BYTES} bytes`);
  }
  if (budget !== undefined) {
    if (byteLength > budget.remaining) {
      return limitExceeded(`commit byte total cannot exceed ${MAX_COMMIT_BYTES}`);
    }
    budget.remaining -= byteLength;
  }

  try {
    const snapshot = new Uint8Array(byteLength);
    snapshot.set(new Uint8Array(buffer, byteOffset, byteLength));
    return snapshot;
  } catch {
    return invalidInput(`${field} must reference attached, stable bytes`);
  }
}
