import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import { types } from "node:util";

import { requireIdentifier } from "../store-input-primitives.js";
import { stringIsWellFormed, textEncoder } from "../store-internals.js";
import type { DataRecord } from "../store-internals.js";
import type {
  SnapshotDoc, SnapshotDocFields, SubscriberDoc, SubscriberDocFields,
} from "./subscription-contracts.js";

/**
 * Durable encoding for the two subscription docs. A cursor lives as a versioned JSON doc in
 * `event_subscriptions.filter_json`; the baseline a consumer rebuilds from lives under the
 * reserved `moe-snapshot/` subscriber id. Both carry a length-framed, domain-separated
 * receipt digest, and decoding is the strict inverse of encoding — a stored text that is not
 * the exact canonical encoding of its own fields is refused rather than repaired, so a
 * tampered cursor becomes a reported gap and never a silent reposition. Positions are
 * decimal text and are only ever compared through `parsePosition`.
 */

export const SUBSCRIBER_DOC_VERSION = "moe-subscription/1" as const;
export const SNAPSHOT_DOC_VERSION = "moe-subscription-snapshot/1" as const;
export const MAX_SUBSCRIPTION_DOC_BYTES = 65_536;
export const MAX_SUBSCRIPTION_FILTER_ENTRIES = 64;
const DIGEST_DOMAIN = "moe-subscription-doc/1";
const MAX_DOC_DEPTH = 32;
const MISSING = Symbol("subscription-doc-missing");
const POSITION_PATTERN = /^0$|^[1-9]\d*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type Loose<Fields> = { readonly [Key in keyof Fields]: unknown };

/** The single gate every position comparison goes through: decimal text only, so `"9"` can
 *  never sort above `"10"` and a tampered `"007"` or `"1e3"` fails closed instead of coercing. */
export function parsePosition(value: unknown): bigint | null {
  return typeof value === "string" && POSITION_PATTERN.test(value) ? BigInt(value) : null;
}

export function formatPosition(value: bigint): string {
  return value.toString();
}

function wellFormed(value: string): boolean {
  return Reflect.apply(stringIsWellFormed, value, []) === true;
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

/** Domain-separated and length-framed, so no concatenation of one field can be read as
 *  another: `["ab","c"]` and `["a","bc"]` stay distinguishable identities. */
function digestDoc(version: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  frameText(hash, DIGEST_DOMAIN);
  frameText(hash, version);
  for (const field of fields) {
    frameText(hash, field);
  }
  return hash.digest("hex");
}

function identifier(value: unknown): string | null {
  try {
    return requireIdentifier(value, "subscription field");
  } catch {
    return null;
  }
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function positionText(value: unknown): string | null {
  return parsePosition(value) === null ? null : (value as string);
}

function sha256Text(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

function filterList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIPTION_FILTER_ENTRIES) {
    return null;
  }
  const entries: string[] = [];
  for (const entry of value as readonly unknown[]) {
    const name = identifier(entry);
    if (name === null) {
      return null;
    }
    entries.push(name);
  }
  return entries;
}

export function plainRecord(value: unknown): DataRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    ? (value as DataRecord) : null;
}

/** Reads through a data descriptor, so an accessor or a hole is refused, never invoked. */
function ownValue(source: object, key: string | number): unknown {
  const slot = Object.getOwnPropertyDescriptor(source, key);
  return slot !== undefined && "value" in slot ? (slot.value as unknown) : MISSING;
}

/**
 * Canonical JSON: object keys in code-unit order, no holes, no accessors, no prototypes but
 * the plain ones, and only values that survive a byte-exact round trip. Non-well-formed
 * strings are refused rather than escaped, because a lone surrogate collapses under UTF-8
 * encoding and would let two distinguishable docs share one receipt digest. Proxies are
 * refused at every depth: an encode walks the value twice (once for the digest, once for the
 * stored text) and a proxy that answered differently between them would store a doc whose
 * digest can never verify again.
 */
function canonicalJson(value: unknown, depth: number, seen: Set<object>): string | null {
  if (value === null) {
    return "null";
  }
  const kind = typeof value;
  if (kind === "boolean") {
    return value === true ? "true" : "false";
  }
  if (kind === "number") {
    const numeric = value as number;
    return Number.isFinite(numeric) && !Object.is(numeric, -0) ? String(numeric) : null;
  }
  if (kind === "string") {
    return wellFormed(value as string) ? JSON.stringify(value) : null;
  }
  if (
    kind !== "object" || depth > MAX_DOC_DEPTH || seen.has(value as object) ||
    types.isProxy(value)
  ) {
    return null;
  }
  const source = value as object;
  seen.add(source);
  const encoded = Array.isArray(source)
    ? canonicalArray(source, depth, seen)
    : canonicalRecord(source, depth, seen);
  seen.delete(source);
  return encoded;
}

function canonicalArray(
  source: readonly unknown[], depth: number, seen: Set<object>,
): string | null {
  if (Object.getPrototypeOf(source) !== Array.prototype) {
    return null;
  }
  const parts: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const slot = ownValue(source, index);
    const item = slot === MISSING ? null : canonicalJson(slot, depth + 1, seen);
    if (item === null) {
      return null;
    }
    parts.push(item);
  }
  return `[${parts.join(",")}]`;
}

function canonicalRecord(source: object, depth: number, seen: Set<object>): string | null {
  const keys = Reflect.ownKeys(source);
  if (
    Object.getPrototypeOf(source) !== Object.prototype ||
    keys.some((key) => typeof key !== "string" || key === "__proto__" || !wellFormed(key))
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const key of (keys as readonly string[]).slice().sort()) {
    const slot = ownValue(source, key);
    const item = slot === MISSING ? null : canonicalJson(slot, depth + 1, seen);
    if (item === null) {
      return null;
    }
    parts.push(`${JSON.stringify(key)}:${item}`);
  }
  return `{${parts.join(",")}}`;
}

function docText(record: DataRecord): string | null {
  const text = canonicalJson(record, 0, new Set());
  if (text === null || textEncoder.encode(text).byteLength > MAX_SUBSCRIPTION_DOC_BYTES) {
    return null;
  }
  return text;
}

function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
}

export function encodeSubscriberDoc(input: Loose<SubscriberDocFields>): string | null {
  const projection = identifier(input.projection);
  const filter = filterList(input.filter);
  const position = positionText(input.position);
  const { generation } = input;
  if (projection === null || filter === null || position === null || !isGeneration(generation)) {
    return null;
  }
  const receiptDigest = digestDoc(SUBSCRIBER_DOC_VERSION, [
    projection, String(filter.length), ...filter, String(generation), position,
  ]);
  return docText({
    cursor: { generation, position }, filter, projection, receiptDigest,
    version: SUBSCRIBER_DOC_VERSION,
  });
}

export function encodeSnapshotDoc(input: Loose<SnapshotDocFields>): string | null {
  const projection = identifier(input.projection);
  const checkpoint = positionText(input.checkpoint);
  const stateDigest = sha256Text(input.stateDigest);
  const record = plainRecord(input.state);
  const state = record === null ? null : canonicalJson(record, 0, new Set());
  const { generation } = input;
  if (
    projection === null || checkpoint === null || stateDigest === null || state === null ||
    !isGeneration(generation)
  ) {
    return null;
  }
  const receiptDigest = digestDoc(SNAPSHOT_DOC_VERSION, [
    projection, String(generation), checkpoint, stateDigest, state,
  ]);
  return docText({
    checkpoint, generation, projection, receiptDigest, state: record, stateDigest,
    version: SNAPSHOT_DOC_VERSION,
  });
}

export function decodeSubscriberDoc(text: string): SubscriberDoc | null {
  const raw = plainRecord(jsonValue(text));
  const cursor = raw === null ? null : plainRecord(raw["cursor"]);
  if (raw === null || cursor === null) {
    return null;
  }
  const fields = {
    filter: raw["filter"], generation: cursor["generation"],
    position: cursor["position"], projection: raw["projection"],
  };
  if (encodeSubscriberDoc(fields) !== text) {
    return null;
  }
  return Object.freeze({
    cursor: Object.freeze({
      generation: cursor["generation"] as number, position: cursor["position"] as string,
    }),
    filter: Object.freeze([...(raw["filter"] as readonly string[])]),
    projection: raw["projection"] as string, receiptDigest: raw["receiptDigest"] as string,
    version: SUBSCRIBER_DOC_VERSION,
  });
}

export function decodeSnapshotDoc(text: string): SnapshotDoc | null {
  const raw = plainRecord(jsonValue(text));
  if (raw === null) {
    return null;
  }
  const fields = {
    checkpoint: raw["checkpoint"], generation: raw["generation"], projection: raw["projection"],
    state: raw["state"], stateDigest: raw["stateDigest"],
  };
  if (encodeSnapshotDoc(fields) !== text) {
    return null;
  }
  return Object.freeze({
    checkpoint: raw["checkpoint"] as string, generation: raw["generation"] as number,
    projection: raw["projection"] as string, receiptDigest: raw["receiptDigest"] as string,
    state: deepFreeze(raw["state"]) as DataRecord, stateDigest: raw["stateDigest"] as string,
    version: SNAPSHOT_DOC_VERSION,
  });
}
