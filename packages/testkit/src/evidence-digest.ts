import { createHash } from "node:crypto";
import { types } from "node:util";

import { EVIDENCE_IDENTITY_VERSION } from "@moe/contracts";

import { CANONICAL_JSON_VERSION, canonicalize } from "./canonical-json.js";

export { EVIDENCE_IDENTITY_VERSION } from "@moe/contracts";

export interface EvidenceIdentity {
  readonly algorithm: "sha256";
  readonly byteLength: number;
  readonly digest: string;
  readonly identityVersion: typeof EVIDENCE_IDENTITY_VERSION;
  readonly objectPath: string;
}

export interface CanonicalEvidenceIdentity extends EvidenceIdentity {
  readonly canonicalizerVersion: typeof CANONICAL_JSON_VERSION;
}

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

export function snapshotEvidenceBytes(
  bytes: Uint8Array,
  maxByteLength: number = Number.MAX_SAFE_INTEGER,
): Uint8Array {
  if (!Number.isSafeInteger(maxByteLength) || maxByteLength < 0) {
    throw new TypeError("Unsupported evidence byte ceiling");
  }
  if (types.isProxy(bytes)) {
    throw new TypeError("Unsupported evidence bytes: proxy");
  }
  if (!types.isUint8Array(bytes)) {
    throw new TypeError("Unsupported evidence bytes: Uint8Array required");
  }

  let buffer: ArrayBufferLike;
  let byteLength: number;
  let byteOffset: number;
  try {
    buffer = Reflect.apply(typedArrayBufferGetter, bytes, []) as ArrayBufferLike;
    byteLength = Reflect.apply(typedArrayByteLengthGetter, bytes, []) as number;
    byteOffset = Reflect.apply(typedArrayByteOffsetGetter, bytes, []) as number;
  } catch {
    throw new TypeError("Unsupported evidence bytes: Uint8Array required");
  }

  if (types.isSharedArrayBuffer(buffer)) {
    throw new TypeError("Unsupported evidence bytes: shared backing buffer");
  }
  if (byteLength > maxByteLength) {
    throw new RangeError(`Evidence bytes exceed ${maxByteLength} bytes`);
  }

  const snapshot = new Uint8Array(byteLength);
  snapshot.set(new Uint8Array(buffer, byteOffset, byteLength));
  return snapshot;
}

export function identifyEvidence(bytes: Uint8Array): EvidenceIdentity {
  const snapshot = snapshotEvidenceBytes(bytes);
  const digest = createHash("sha256").update(snapshot).digest("hex");

  return {
    algorithm: "sha256",
    byteLength: snapshot.byteLength,
    digest,
    identityVersion: EVIDENCE_IDENTITY_VERSION,
    objectPath: `objects/sha256/${digest.slice(0, 2)}/${digest}`,
  };
}

export function identifyCanonicalEvidence(value: unknown): CanonicalEvidenceIdentity {
  const identity = identifyEvidence(new TextEncoder().encode(canonicalize(value)));
  return {
    ...identity,
    canonicalizerVersion: CANONICAL_JSON_VERSION,
  };
}
