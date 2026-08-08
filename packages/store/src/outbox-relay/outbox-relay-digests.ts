import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";

import type { ProjectionState } from "../projections/projection-fold.js";
import { EMPTY_BYTES, textEncoder } from "../store-internals.js";
import { snapshotBytes } from "../store-input-containers.js";
import {
  readOwnDataProperty,
  requireDataRecord,
  requireIdentifier,
} from "../store-input-primitives.js";

/**
 * Deterministic identities for the transactional outbox relay. Both digests are
 * domain-separated by an explicit version tag and length-frame every string and byte
 * run, so no concatenation of one field can be mistaken for another. Everything here
 * is synchronous, pure, and total: an unusable input returns `null` rather than
 * throwing, so the relay can refuse it with its own stable code. The same value always
 * produces the same lowercase SHA-256 on Windows, macOS, and Linux — no locale
 * collation, no host byte order, no JSON.
 */

export const RELAY_INBOX_RECEIPT_VERSION = "moe-relay-inbox-receipt/1" as const;
export const RELAY_PROJECTION_STATE_VERSION = "moe-relay-projection-state/1" as const;

export interface CanonicalProjectionState {
  readonly digest: string;
  readonly state: ProjectionState;
}

export interface RelayInboxIdentity {
  readonly digest: string;
  readonly messageId: string;
}

const INVALID = Symbol("outbox-relay-digest-invalid");
const TAG = Object.freeze({
  array: 6, bigint: 4, false: 1, null: 0, number: 3, object: 7, string: 5, true: 2,
});

function tag(hash: Hash, code: number): void {
  hash.update(Uint8Array.of(code));
}

function frameBytes(hash: Hash, value: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

function frameText(hash: Hash, value: string): void {
  frameBytes(hash, textEncoder.encode(value));
}

/**
 * `String` is the spec's shortest round-trip decimal, so it is stable across engines and
 * platforms — but it maps `-0` onto `"0"` and would let two distinguishable states share
 * a digest. Non-finite values are named explicitly for the same reason.
 */
function encodeNumber(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) {
    return value > 0 ? "Infinity" : "-Infinity";
  }
  return Object.is(value, -0) ? "-0" : String(value);
}

/** Reads through a data descriptor, so an accessor is refused rather than invoked. */
function dataOf(source: object, key: string): PropertyDescriptor | null {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor : null;
}

function encodeScalar(hash: Hash, value: unknown, kind: string): unknown {
  if (kind === "boolean") {
    tag(hash, value === true ? TAG.true : TAG.false);
    return value;
  }
  if (kind === "number") {
    tag(hash, TAG.number);
    frameText(hash, encodeNumber(value as number));
    return value;
  }
  if (kind === "bigint") {
    tag(hash, TAG.bigint);
    frameText(hash, (value as bigint).toString());
    return value;
  }
  tag(hash, TAG.string);
  frameText(hash, value as string);
  return value;
}

/**
 * Hashes and deep-clones in one walk, so the bytes that were hashed are exactly the
 * bytes handed to the fold — a hostile proxy cannot answer differently on a second read.
 * Mirrors the fold's plain-data rules: class instances, functions, symbol keys,
 * `__proto__` keys, accessors, array holes, extra array properties, and cycles are all
 * refused. Object keys are hashed in code-unit order so key insertion order is invisible.
 */
function encodeValue(hash: Hash, value: unknown, path: Set<object>): unknown {
  if (value === null) {
    tag(hash, TAG.null);
    return null;
  }
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "bigint" || kind === "string") {
    return encodeScalar(hash, value, kind);
  }
  if (kind !== "object") {
    return INVALID;
  }
  const source = value as object;
  const isArray = Array.isArray(source);
  const prototype = Object.getPrototypeOf(source) as unknown;
  if (path.has(source) ||
      (prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype))) {
    return INVALID;
  }
  const own = Reflect.ownKeys(source);
  const raw = isArray ? own.slice(0, -1) : own;
  if (isArray && !(own.at(-1) === "length" && raw.length === (source as unknown[]).length)) {
    return INVALID;
  }
  path.add(source);
  const encoded = isArray
    ? encodeArray(hash, source as unknown[], raw, path)
    : encodeRecord(hash, source, raw, path);
  path.delete(source);
  return encoded;
}

function encodeArray(
  hash: Hash, source: unknown[], keys: readonly PropertyKey[], path: Set<object>,
): unknown {
  tag(hash, TAG.array);
  frameText(hash, String(keys.length));
  const items: unknown[] = [];
  for (const key of keys) {
    const slot = typeof key === "string" ? dataOf(source, key) : null;
    const item = slot === null ? INVALID : encodeValue(hash, slot.value, path);
    if (item === INVALID) {
      return INVALID;
    }
    items.push(item);
  }
  return Object.freeze(items);
}

function encodeRecord(
  hash: Hash, source: object, keys: readonly PropertyKey[], path: Set<object>,
): unknown {
  for (const key of keys) {
    if (typeof key !== "string" || key === "__proto__") {
      return INVALID;
    }
  }
  const sorted = (keys as readonly string[]).slice().sort();
  tag(hash, TAG.object);
  frameText(hash, String(sorted.length));
  const draft: Record<string, unknown> = {};
  for (const key of sorted) {
    const slot = dataOf(source, key);
    frameText(hash, key);
    const item = slot === null ? INVALID : encodeValue(hash, slot.value, path);
    if (item === INVALID) {
      return INVALID;
    }
    draft[key] = item;
  }
  return Object.freeze(draft);
}

/**
 * Canonicalizes recursively plain projection state into a detached frozen clone plus its
 * digest. Returns `null` when the value is not a plain record the fold would accept.
 */
export function canonicalProjectionState(value: unknown): CanonicalProjectionState | null {
  const hash = createHash("sha256");
  frameText(hash, RELAY_PROJECTION_STATE_VERSION);
  let state: unknown;
  try {
    state = typeof value === "object" && value !== null && !Array.isArray(value)
      ? encodeValue(hash, value, new Set())
      : INVALID;
  } catch {
    return null;
  }
  if (state === INVALID) {
    return null;
  }
  return Object.freeze({ digest: hash.digest("hex"), state: state as ProjectionState });
}

/**
 * Binds the durable inbox receipt to the consumer plus the immutable envelope the
 * consumer actually saw. `deliveryAttempts` and `deliveredAt` are deliberately excluded:
 * they vary between retries of the same message, and a redelivery must dedupe, not
 * conflict. The messageId is returned alongside the digest so the relay never has to read
 * the envelope a second time. Returns `null` when it is not usable identity material.
 */
export function digestInboxReceipt(
  consumerId: unknown, message: unknown,
): RelayInboxIdentity | null {
  const hash = createHash("sha256");
  frameText(hash, RELAY_INBOX_RECEIPT_VERSION);
  let messageId: string;
  try {
    const envelope = requireDataRecord(message, "message");
    frameText(hash, requireIdentifier(consumerId, "consumerId"));
    messageId = requireIdentifier(
      readOwnDataProperty(envelope, "messageId", "message.messageId"), "message.messageId",
    );
    frameText(hash, messageId);
    frameText(hash, requireIdentifier(
      readOwnDataProperty(envelope, "topic", "message.topic"), "message.topic",
    ));
    frameBytes(hash, snapshotBytes(
      readOwnDataProperty(envelope, "payload", "message.payload"), "message.payload",
    ));
    frameBytes(hash, snapshotBytes(
      readOwnDataProperty(envelope, "headers", "message.headers", false) ?? EMPTY_BYTES,
      "message.headers",
    ));
  } catch {
    return null;
  }
  return Object.freeze({ digest: hash.digest("hex"), messageId });
}
