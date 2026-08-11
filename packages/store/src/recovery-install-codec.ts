import { createHash } from "node:crypto";

import { MAX_BLOB_BYTES } from "./store-contracts.js";
import { canonicalTimestampPattern, textEncoder } from "./store-internals.js";
import {
  RECOVERY_BINDING_BYTES_MALFORMED,
  RECOVERY_BINDING_CODEC_VERSION,
  RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED,
  RECOVERY_BINDING_DIGEST_MISMATCH,
  RECOVERY_BINDING_FIELD_INVALID,
  RECOVERY_BINDING_SHAPE_INVALID,
  RECOVERY_BINDING_SLOTS,
} from "./recovery-install-contracts.js";
import type {
  RecoveryBindingDecodeResult,
  RecoveryBindingEncodeResult,
  RecoveryBindingRecord,
  RecoveryBindingSlot,
} from "./recovery-install-contracts.js";

const HEADER = textEncoder.encode(`${RECOVERY_BINDING_CODEC_VERSION}\n`);
const LENGTH_BYTES = 4;
const HEX64 = /^[0-9a-f]{64}$/u;
/** Fatal decoding: mis-framed bytes must refuse, never become U+FFFD. */
const decoder = new TextDecoder("utf-8", { fatal: true });

const BINDING_KEYS = Object.freeze([
  "bindingCodecVersion",
  "incarnationRef",
  "installedAt",
  "keyEpochRef",
  "payload",
  "slot",
]);

export function recoveryBindingDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isRecoveryBindingSlot(value: unknown): value is RecoveryBindingSlot {
  return typeof value === "string" && RECOVERY_BINDING_SLOTS.includes(value as RecoveryBindingSlot);
}

function hasExactKeys(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === BINDING_KEYS.length && keys.every((key) => BINDING_KEYS.includes(key));
}

function isDigestRef(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function frame(parts: readonly Uint8Array[]): Uint8Array {
  let total = HEADER.length;
  for (const part of parts) total += LENGTH_BYTES + part.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(HEADER, 0);
  let offset = HEADER.length;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += LENGTH_BYTES;
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * Serialized in ONE fixed field order, never from the caller's object, so two
 * callers holding the same binding produce the same bytes and the same digest.
 * Every variable-length field is length-prefixed: without framing, two adjacent
 * fields could be re-split and a caller able to choose one could steer the
 * other.
 */
export function encodeRecoveryBinding(value: unknown): RecoveryBindingEncodeResult {
  if (!hasExactKeys(value)) return RECOVERY_BINDING_SHAPE_INVALID;
  if (value["bindingCodecVersion"] !== RECOVERY_BINDING_CODEC_VERSION) {
    return RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED;
  }
  const slot: unknown = value["slot"];
  const incarnationRef: unknown = value["incarnationRef"];
  const keyEpochRef: unknown = value["keyEpochRef"];
  const installedAt: unknown = value["installedAt"];
  const payload: unknown = value["payload"];
  if (!isRecoveryBindingSlot(slot)) return RECOVERY_BINDING_FIELD_INVALID;
  if (!isDigestRef(incarnationRef) || !isDigestRef(keyEpochRef)) {
    return RECOVERY_BINDING_FIELD_INVALID;
  }
  if (typeof installedAt !== "string" || !canonicalTimestampPattern.test(installedAt)) {
    return RECOVERY_BINDING_FIELD_INVALID;
  }
  if (!(payload instanceof Uint8Array)) return RECOVERY_BINDING_FIELD_INVALID;
  if (payload.byteLength === 0 || payload.byteLength > MAX_BLOB_BYTES) {
    return RECOVERY_BINDING_FIELD_INVALID;
  }

  // Copied, so a caller mutating its buffer after the call cannot move the
  // bytes the digest already covers.
  const binding: RecoveryBindingRecord = Object.freeze({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef,
    installedAt,
    keyEpochRef,
    payload: Uint8Array.from(payload),
    slot,
  });
  const bytes = frame([
    textEncoder.encode(slot),
    textEncoder.encode(incarnationRef),
    textEncoder.encode(keyEpochRef),
    textEncoder.encode(installedAt),
    binding.payload,
  ]);
  return Object.freeze({
    binding,
    bytes,
    digest: recoveryBindingDigest(bytes),
    ok: true as const,
  });
}

function hasHeader(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER.length) return false;
  return HEADER.every((byte, index) => bytes[index] === byte);
}

interface FrameCursor {
  offset: number;
}

function readFrame(bytes: Uint8Array, cursor: FrameCursor): Uint8Array | null {
  if (cursor.offset + LENGTH_BYTES > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(cursor.offset, false);
  cursor.offset += LENGTH_BYTES;
  if (length > MAX_BLOB_BYTES || cursor.offset + length > bytes.length) return null;
  const part = bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return part;
}

function decodeText(part: Uint8Array): string | null {
  try {
    return decoder.decode(part);
  } catch {
    return null;
  }
}

/**
 * A bounded exact-shape decode, not a cast, and never a repair. The digest is
 * checked BEFORE any framing is parsed, so bytes that have drifted are refused
 * as a mismatch rather than half-interpreted; trailing bytes are refused rather
 * than ignored.
 */
export function decodeRecoveryBinding(
  bytes: unknown,
  expectedDigest: unknown,
): RecoveryBindingDecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return RECOVERY_BINDING_BYTES_MALFORMED;
  }
  if (!isDigestRef(expectedDigest) || recoveryBindingDigest(bytes) !== expectedDigest) {
    return RECOVERY_BINDING_DIGEST_MISMATCH;
  }
  if (!hasHeader(bytes)) return RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED;

  const cursor: FrameCursor = { offset: HEADER.length };
  const slotPart = readFrame(bytes, cursor);
  const incarnationPart = readFrame(bytes, cursor);
  const keyEpochPart = readFrame(bytes, cursor);
  const installedAtPart = readFrame(bytes, cursor);
  const payloadPart = readFrame(bytes, cursor);
  if (
    slotPart === null ||
    incarnationPart === null ||
    keyEpochPart === null ||
    installedAtPart === null ||
    payloadPart === null ||
    cursor.offset !== bytes.byteLength
  ) {
    return RECOVERY_BINDING_BYTES_MALFORMED;
  }

  const slot = decodeText(slotPart);
  const incarnationRef = decodeText(incarnationPart);
  const keyEpochRef = decodeText(keyEpochPart);
  const installedAt = decodeText(installedAtPart);
  if (!isRecoveryBindingSlot(slot)) return RECOVERY_BINDING_FIELD_INVALID;
  if (!isDigestRef(incarnationRef) || !isDigestRef(keyEpochRef)) {
    return RECOVERY_BINDING_FIELD_INVALID;
  }
  if (installedAt === null || !canonicalTimestampPattern.test(installedAt)) {
    return RECOVERY_BINDING_FIELD_INVALID;
  }
  if (payloadPart.byteLength === 0) return RECOVERY_BINDING_FIELD_INVALID;

  return Object.freeze({
    binding: Object.freeze({
      bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
      incarnationRef,
      installedAt,
      keyEpochRef,
      payload: Uint8Array.from(payloadPart),
      slot,
    }),
    ok: true as const,
  });
}
