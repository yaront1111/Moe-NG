/**
 * Canonical bytes for the durable activation ledger.
 *
 * FRAMING follows packages/store/src/recovery-install-codec.ts rather than
 * inventing a second discipline: a version header, one fixed field order built
 * from a VALIDATED record rather than from the caller's object, every
 * variable-length part length-prefixed, a fatal decoder, and trailing bytes
 * refused rather than ignored. The digest is carried in the final frame, so the
 * bytes are self-verifying and the digest is checked BEFORE any framing is
 * parsed — drifted bytes refuse as a mismatch instead of being half-interpreted.
 *
 * The reader that cross-checks a stored event against these bytes lives in
 * activation-ledger-reader.ts; this module only produces and parses them.
 */

import { createHash } from "node:crypto";

import { SUPERVISOR_ACTIVATION_VERSION } from "@moe/runner";
import {
  ACTIVATION_LEDGER_RECORD_KEYS,
  ACTIVATION_LEDGER_RECORD_VERSION,
  activationLedgerRefusal,
  activationLedgerUnknown,
} from "./activation-ledger-contracts.js";
import type {
  ActivationLedgerDecodeResult,
  ActivationLedgerEncodeResult,
  ActivationLedgerRecord,
} from "./activation-ledger-contracts.js";

const HEADER = new TextEncoder().encode(`${ACTIVATION_LEDGER_RECORD_VERSION}\n`);
const LENGTH_BYTES = 4;
const DIGEST_HEX_BYTES = 64;
const DIGEST_FRAME_BYTES = LENGTH_BYTES + DIGEST_HEX_BYTES;
const MAX_RECORD_BYTES = 1_048_576;
const HEX64 = /^[0-9a-f]{64}$/u;
/** Fatal: mis-framed bytes must refuse, never become U+FFFD. */
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function activationLedgerDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Deterministic serialisation: object keys sorted, so two callers holding the
 * same record produce identical bytes regardless of how their objects were
 * built. Arrays keep their order, which is data.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hasExactKeys(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== ACTIVATION_LEDGER_RECORD_KEYS.length) return false;
  return keys.every((key) => (ACTIVATION_LEDGER_RECORD_KEYS as readonly string[]).includes(key));
}

/**
 * Validates only what THIS module reasons about — the literals it pins, the
 * numbers it compares, and the sub-fields it cross-checks. The remaining
 * producer-owned content is preserved verbatim under the digest; re-declaring
 * `@moe/scheduler`'s and `@moe/runner`'s validators here would create a second
 * authority that can disagree with the first.
 */
function validate(value: Record<string, unknown>): ActivationLedgerRecord | "VERSION" | "FIELD" {
  if (value["recordVersion"] !== ACTIVATION_LEDGER_RECORD_VERSION) return "VERSION";
  if (value["activationVersion"] !== SUPERVISOR_ACTIVATION_VERSION) return "VERSION";
  const digest = value["activationDigest"];
  if (typeof digest !== "string" || !HEX64.test(digest)) return "FIELD";
  if (!isCount(value["predecessorIntentVersion"]) || !isCount(value["predecessorAttemptVersion"])) {
    return "FIELD";
  }
  const nested = ["attempt", "budgetReservation", "budgetView", "effectIntent", "grant", "lease", "providerSlot"];
  if (!nested.every((key) => isPlainObject(value[key]))) return "FIELD";
  const intent = value["effectIntent"] as Record<string, unknown>;
  const attempt = value["attempt"] as Record<string, unknown>;
  const grant = value["grant"] as Record<string, unknown>;
  if (typeof intent["aggregateId"] !== "string" || typeof intent["idempotencyKey"] !== "string") {
    return "FIELD";
  }
  if (!isCount(intent["version"]) || !isCount(attempt["version"])) return "FIELD";
  if (typeof grant["grantId"] !== "string" || grant["grantId"].length === 0) return "FIELD";
  return value as unknown as ActivationLedgerRecord;
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
 * Serialised in ONE fixed field order taken from the frozen key list, never from
 * the caller's key order, then sealed with a trailing digest over everything
 * before it.
 */
export function encodeActivationLedgerRecord(value: unknown): ActivationLedgerEncodeResult {
  if (!hasExactKeys(value)) {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_RECORD_MALFORMED");
  }
  const validated = validate(value);
  if (validated === "VERSION") {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_VERSION_UNSUPPORTED");
  }
  if (validated === "FIELD") {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_FIELD_INVALID");
  }
  const body = frame(
    ACTIVATION_LEDGER_RECORD_KEYS.map((key) =>
      encoder.encode(canonicalJson((validated as unknown as Record<string, unknown>)[key])),
    ),
  );
  if (body.byteLength + DIGEST_FRAME_BYTES > MAX_RECORD_BYTES) {
    return activationLedgerRefusal("REFUSED", "ACTIVATION_LEDGER_FIELD_INVALID");
  }
  const digest = activationLedgerDigest(body);
  const bytes = new Uint8Array(body.byteLength + DIGEST_FRAME_BYTES);
  bytes.set(body, 0);
  new DataView(bytes.buffer).setUint32(body.byteLength, DIGEST_HEX_BYTES, false);
  bytes.set(encoder.encode(digest), body.byteLength + LENGTH_BYTES);
  return Object.freeze({ bytes, digest, ok: true as const, record: validated });
}

interface FrameCursor {
  offset: number;
}

function readFrame(bytes: Uint8Array, cursor: FrameCursor): Uint8Array | null {
  if (cursor.offset + LENGTH_BYTES > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(cursor.offset, false);
  cursor.offset += LENGTH_BYTES;
  if (length > MAX_RECORD_BYTES || cursor.offset + length > bytes.length) return null;
  const part = bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return part;
}

function parsePart(part: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(decoder.decode(part)) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads the trailing digest frame without parsing anything ahead of it. */
function splitSealed(bytes: Uint8Array): { body: Uint8Array; digest: string } | null {
  if (bytes.byteLength <= HEADER.length + DIGEST_FRAME_BYTES) return null;
  const bodyLength = bytes.byteLength - DIGEST_FRAME_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(bodyLength, false) !== DIGEST_HEX_BYTES) return null;
  let digest: string;
  try {
    digest = decoder.decode(bytes.subarray(bodyLength + LENGTH_BYTES));
  } catch {
    return null;
  }
  if (!HEX64.test(digest)) return null;
  return { body: bytes.subarray(0, bodyLength), digest };
}

/**
 * A bounded exact-shape decode, never a cast and never a repair. The digest is
 * verified before framing is parsed; the parsed record is then RE-ENCODED and
 * required to reproduce the input byte for byte, which is what closes duplicate
 * keys, key-order smuggling and whitespace padding in one check — `JSON.parse`
 * silently keeps the last of two identical keys.
 */
export function decodeActivationLedgerRecord(bytes: unknown): ActivationLedgerDecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_BYTES_MALFORMED");
  }
  const sealed = splitSealed(bytes);
  if (sealed === null) return activationLedgerUnknown("ACTIVATION_LEDGER_BYTES_MALFORMED");
  if (activationLedgerDigest(sealed.body) !== sealed.digest) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_DIGEST_MISMATCH");
  }
  if (sealed.body.length < HEADER.length || !HEADER.every((byte, index) => sealed.body[index] === byte)) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_VERSION_UNSUPPORTED");
  }
  const cursor: FrameCursor = { offset: HEADER.length };
  const draft: Record<string, unknown> = {};
  for (const key of ACTIVATION_LEDGER_RECORD_KEYS) {
    const part = readFrame(sealed.body, cursor);
    if (part === null) return activationLedgerUnknown("ACTIVATION_LEDGER_BYTES_MALFORMED");
    const parsed = parsePart(part);
    if (parsed === undefined) return activationLedgerUnknown("ACTIVATION_LEDGER_BYTES_MALFORMED");
    draft[key] = parsed;
  }
  if (cursor.offset !== sealed.body.byteLength) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_BYTES_MALFORMED");
  }
  const reencoded = encodeActivationLedgerRecord(draft);
  if (!reencoded.ok) {
    return activationLedgerUnknown(
      reencoded.code === "ACTIVATION_LEDGER_VERSION_UNSUPPORTED"
        ? "ACTIVATION_LEDGER_VERSION_UNSUPPORTED"
        : reencoded.code === "ACTIVATION_LEDGER_FIELD_INVALID"
          ? "ACTIVATION_LEDGER_FIELD_INVALID"
          : "ACTIVATION_LEDGER_RECORD_MALFORMED",
    );
  }
  if (reencoded.digest !== sealed.digest) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_RECORD_MALFORMED");
  }
  return Object.freeze({ ok: true as const, record: reencoded.record });
}
