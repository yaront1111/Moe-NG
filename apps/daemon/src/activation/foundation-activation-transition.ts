/**
 * The Foundation launch transitions appended to df298's activation aggregate.
 *
 * IT RESTATES NOTHING: `EffectActivationCommitted`, its codec, its aggregate
 * derivation and its expected-version-0 commit stay where they are. Sequence 1
 * remains that event; this module describes only the ordered tail. A second
 * activation codec here would be a second authority over the same durable bytes,
 * and the two could disagree with nothing to break the tie.
 *
 * THE TUPLES ARE PRIMITIVE AND TAG-SPECIFIC: each tag names a fixed ordered list
 * of strings, framed length-first and sealed with a trailing SHA-256 over
 * everything before it, so a stored payload is comparable to a fresh encoding
 * BYTE FOR BYTE. No JSON, so no key order, no duplicate key, no number to round.
 *
 * NO SECRET IS COPIED: the registration tags carry the bootstrap credential's
 * DIGEST, all the launch-lock protocol itself handles, and no tag carries
 * `leaseToken` or the lease proof. These bytes outlive the process.
 */

import { createHash } from "node:crypto";

const RECORD_VERSION = "moe-foundation-activation-transition/1" as const;
export const FOUNDATION_TRANSITION_RECORD_VERSION = RECORD_VERSION;

export const FOUNDATION_TRANSITION_TAGS = Object.freeze([
  "GRANT_CONSUMED", "PREFLIGHT_REGISTERED", "PROCESS_OBSERVED",
] as const);
export type FoundationTransitionTag = (typeof FOUNDATION_TRANSITION_TAGS)[number];

/** The durable event type per tag, ordered exactly as the tags are ordered. */
export const FOUNDATION_TRANSITION_EVENT_TYPES = Object.freeze({
  GRANT_CONSUMED: "FoundationActivationGrantConsumed",
  PREFLIGHT_REGISTERED: "FoundationLaunchPreflightRegistered",
  PROCESS_OBSERVED: "FoundationLaunchProcessObserved",
} as const);

const GRANT_TUPLE = Object.freeze([
  "tag", "activationDigest", "grantId", "intentId", "attemptId", "wrapperIdentity",
] as const);
const REGISTRATION_TUPLE = Object.freeze([
  ...GRANT_TUPLE, "lockIdentity", "processIdentity", "bootstrapCredentialDigest", "registeredAt",
] as const);

/** Every key a transition may carry, so a sweep is bounded by the record. */
export const FOUNDATION_TRANSITION_KEYS = REGISTRATION_TUPLE;

export interface FoundationTransition {
  readonly tag: FoundationTransitionTag;
  readonly activationDigest: string;
  readonly grantId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly wrapperIdentity: string;
  /** Carried by the two registration tags; explicitly null on GRANT_CONSUMED. */
  readonly lockIdentity: string | null; readonly processIdentity: string | null;
  readonly bootstrapCredentialDigest: string | null; readonly registeredAt: string | null;
}

export const FOUNDATION_TRANSITION_CODES = Object.freeze([
  "FOUNDATION_TRANSITION_MALFORMED", "FOUNDATION_TRANSITION_BYTES_MALFORMED",
  "FOUNDATION_TRANSITION_DIGEST_MISMATCH",
] as const);
export type FoundationTransitionCode = (typeof FOUNDATION_TRANSITION_CODES)[number];

export interface FoundationTransitionRefusal {
  readonly ok: false; readonly code: FoundationTransitionCode;
}
export type FoundationTransitionEncodeResult =
  | { readonly ok: true; readonly transition: FoundationTransition;
      readonly bytes: Uint8Array; readonly digest: string }
  | FoundationTransitionRefusal;
export type FoundationTransitionDecodeResult =
  | { readonly ok: true; readonly transition: FoundationTransition }
  | FoundationTransitionRefusal;

const refuse = (code: FoundationTransitionCode): FoundationTransitionRefusal =>
  Object.freeze({ code, ok: false as const });

/**
 * The binding vocabulary, at its own layer so a caller can tell a Foundation
 * refusal apart from the store's, the activation ledger's and the coordination
 * service's. ABSENT is a durable fact. UNKNOWN is epic rail 4: unverifiable
 * evidence confers nothing and is never reported as an absence.
 */
export const FOUNDATION_ACTIVATION_BINDING_LAYER = "FOUNDATION_ACTIVATION_BINDING" as const;
export const FOUNDATION_BINDING_ABSENT_CODES = Object.freeze([
  "FOUNDATION_BINDING_NOT_FOUND", "FOUNDATION_BINDING_QUERY_MISMATCH",
  "FOUNDATION_BINDING_TERMINAL", "FOUNDATION_BINDING_LEASE_INACTIVE",
  "FOUNDATION_BINDING_LEASE_EXPIRED",
] as const);
export const FOUNDATION_BINDING_UNKNOWN_CODES = Object.freeze([
  "FOUNDATION_BINDING_QUERY_INVALID", "FOUNDATION_BINDING_PROJECT_MISMATCH",
  "FOUNDATION_BINDING_ACTIVATION_INCOHERENT", "FOUNDATION_BINDING_EVIDENCE_MALFORMED",
  "FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS", "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
  "FOUNDATION_BINDING_SCAN_INCOMPLETE",
] as const);
export type FoundationBindingAbsentCode = (typeof FOUNDATION_BINDING_ABSENT_CODES)[number];
export type FoundationBindingUnknownCode = (typeof FOUNDATION_BINDING_UNKNOWN_CODES)[number];

export type FoundationBindingResult =
  | { readonly status: "BOUND"; readonly effectId: string; readonly sessionId: string;
      readonly activationDigest: string }
  | { readonly status: "ABSENT"; readonly code: FoundationBindingAbsentCode;
      readonly layer: typeof FOUNDATION_ACTIVATION_BINDING_LAYER }
  | { readonly status: "UNKNOWN"; readonly code: FoundationBindingUnknownCode;
      readonly layer: typeof FOUNDATION_ACTIVATION_BINDING_LAYER };

export const foundationBindingAbsent = (code: FoundationBindingAbsentCode): FoundationBindingResult =>
  Object.freeze({ code, layer: FOUNDATION_ACTIVATION_BINDING_LAYER, status: "ABSENT" as const });
export const foundationBindingUnknown = (code: FoundationBindingUnknownCode): FoundationBindingResult =>
  Object.freeze({ code, layer: FOUNDATION_ACTIVATION_BINDING_LAYER, status: "UNKNOWN" as const });

const HEADER = new TextEncoder().encode(`${RECORD_VERSION}\n`);
const LENGTH_BYTES = 4, DIGEST_HEX_BYTES = 64;
const DIGEST_FRAME_BYTES = LENGTH_BYTES + DIGEST_HEX_BYTES;
const MAX_TRANSITION_BYTES = 65_536, MAX_TEXT_CHARS = 400;
const HEX64 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
/** Fatal: mis-framed bytes must refuse, never become U+FFFD. */
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * A bounded, well-formed, control-free identifier. The control sweep is a
 * code-point walk, not a regex range: an escape sequence written into this file
 * is one editing accident away from becoming the literal byte it describes.
 */
function isText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_CHARS) return false;
  if (!value.isWellFormed()) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

/**
 * An exact own-DATA-property snapshot. `Reflect.ownKeys` sees the symbol keys an
 * `Object.keys` sweep misses, and an accessor- or proxy-backed slot fails closed
 * rather than being invoked: a getter run inside a refuse-only guard would hand
 * the caller's code the decision.
 */
export function snapshotFoundationRecord(
  value: unknown, keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  let own: (string | symbol)[];
  try {
    own = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (own.length !== keys.length || own.some((key) => typeof key !== "string")) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function tupleFor(tag: unknown): readonly string[] | null {
  if (tag === "GRANT_CONSUMED") return GRANT_TUPLE;
  return tag === "PREFLIGHT_REGISTERED" || tag === "PROCESS_OBSERVED" ? REGISTRATION_TUPLE : null;
}

/** Validates the tuple this tag declares AND that every other slot is null. */
function validate(raw: Record<string, unknown>): FoundationTransition | null {
  const tuple = tupleFor(raw["tag"]);
  if (tuple === null) return null;
  if (!isHex(raw["activationDigest"]) || !isHex(raw["grantId"])) return null;
  if (!isText(raw["intentId"]) || !isText(raw["attemptId"]) || !isText(raw["wrapperIdentity"])) {
    return null;
  }
  if (tuple === REGISTRATION_TUPLE) {
    if (!isText(raw["lockIdentity"]) || !isText(raw["processIdentity"])) return null;
    if (!isHex(raw["bootstrapCredentialDigest"])) return null;
    const registeredAt = raw["registeredAt"];
    if (!isText(registeredAt) || !TIMESTAMP.test(registeredAt)) return null;
  } else if (REGISTRATION_TUPLE.slice(GRANT_TUPLE.length).some((key) => raw[key] !== null)) {
    return null;
  }
  return Object.freeze({ ...raw }) as unknown as FoundationTransition;
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

export function encodeFoundationTransition(value: unknown): FoundationTransitionEncodeResult {
  const raw = snapshotFoundationRecord(value, FOUNDATION_TRANSITION_KEYS);
  if (raw === null) return refuse("FOUNDATION_TRANSITION_MALFORMED");
  const transition = validate(raw);
  if (transition === null) return refuse("FOUNDATION_TRANSITION_MALFORMED");
  const tuple = tupleFor(transition.tag);
  if (tuple === null) return refuse("FOUNDATION_TRANSITION_MALFORMED");
  // Framed from the VALIDATED transition, never the caller's object: every slot
  // named by the tuple is already proven to be a bounded string.
  const fields = transition as unknown as Record<string, string>;
  const body = frame(tuple.map((key) => encoder.encode(fields[key] ?? "")));
  if (body.byteLength + DIGEST_FRAME_BYTES > MAX_TRANSITION_BYTES) {
    return refuse("FOUNDATION_TRANSITION_MALFORMED");
  }
  const digest = sha256(body);
  const bytes = new Uint8Array(body.byteLength + DIGEST_FRAME_BYTES);
  bytes.set(body, 0);
  new DataView(bytes.buffer).setUint32(body.byteLength, DIGEST_HEX_BYTES, false);
  bytes.set(encoder.encode(digest), body.byteLength + LENGTH_BYTES);
  return Object.freeze({ bytes, digest, ok: true as const, transition });
}

interface Cursor { offset: number }

function readFrame(bytes: Uint8Array, cursor: Cursor): string | null {
  if (cursor.offset + LENGTH_BYTES > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(cursor.offset, false);
  cursor.offset += LENGTH_BYTES;
  if (length > MAX_TRANSITION_BYTES || cursor.offset + length > bytes.length) return null;
  const part = bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  try {
    return decoder.decode(part);
  } catch {
    return null;
  }
}

/**
 * Digest first, framing second, validation third — and the validated tuple is
 * RE-ENCODED and required to reproduce the sealed digest, so a payload can be
 * compared to a fresh encoding without trusting the framing that produced it.
 */
export function decodeFoundationTransition(bytes: unknown): FoundationTransitionDecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength <= HEADER.length + DIGEST_FRAME_BYTES) {
    return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
  }
  const bodyLength = bytes.byteLength - DIGEST_FRAME_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(bodyLength, false) !== DIGEST_HEX_BYTES) {
    return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
  }
  let sealed: string;
  try {
    sealed = decoder.decode(bytes.subarray(bodyLength + LENGTH_BYTES));
  } catch {
    return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
  }
  if (!HEX64.test(sealed)) return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
  const body = bytes.subarray(0, bodyLength);
  if (sha256(body) !== sealed) return refuse("FOUNDATION_TRANSITION_DIGEST_MISMATCH");
  if (!HEADER.every((byte, index) => body[index] === byte)) {
    return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
  }
  const cursor: Cursor = { offset: HEADER.length };
  const tag = readFrame(body, cursor);
  const tuple = tupleFor(tag);
  if (tuple === null) return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
  const draft: Record<string, unknown> = {};
  for (const key of FOUNDATION_TRANSITION_KEYS) draft[key] = null;
  draft["tag"] = tag;
  for (const key of tuple.slice(1)) {
    const part = readFrame(body, cursor);
    if (part === null) return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
    draft[key] = part;
  }
  if (cursor.offset !== bodyLength) return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
  const reencoded = encodeFoundationTransition(draft);
  if (!reencoded.ok) return refuse("FOUNDATION_TRANSITION_BYTES_MALFORMED");
  if (reencoded.digest !== sealed) return refuse("FOUNDATION_TRANSITION_DIGEST_MISMATCH");
  return Object.freeze({ ok: true as const, transition: reencoded.transition });
}
