import { createHash } from "node:crypto";
import { types } from "node:util";

import { MAX_DECISION_LEGS } from "./decision-legs-contracts.js";
import { DurableStoreError } from "./store-contracts.js";
import {
  INTERNAL_IDENTIFIER_PREFIX,
  LEG_RECEIPT_SEPARATOR,
  MAX_IDENTIFIER_UTF8_BYTES,
  stringIsWellFormed,
  textEncoder,
} from "./store-internals.js";

export const DECISION_LEG_ROSTER_VERSION = "moe-decision-leg-roster/1" as const;
export const DECISION_LEDGER_LAYER = "DECISION_LEDGER" as const;
export const MAX_DECISION_LEG_ROSTER_BYTES = 32_768;

export class DecisionLedgerIntegrityError extends DurableStoreError {
  public readonly layer = DECISION_LEDGER_LAYER;

  public constructor() {
    super("STORE_CORRUPT", "decision leg roster is corrupt");
    this.name = "DecisionLedgerIntegrityError";
  }
}

export interface DecisionLegRosterLeg {
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly index: number;
  readonly receiptCommandId: string | null;
  readonly receiptEffectSha256: string | null;
  readonly receiptRequestSha256: string | null;
}

export interface DecisionLegRoster {
  readonly version: typeof DECISION_LEG_ROSTER_VERSION;
  readonly decisionId: string;
  readonly count: number;
  readonly legs: readonly DecisionLegRosterLeg[];
}

type DataRecord = Record<PropertyKey, unknown>;
const ROSTER_KEYS = Object.freeze(["version", "decisionId", "count", "legs"] as const);
const LEG_KEYS = Object.freeze([
  "aggregateId", "expectedVersion", "index", "receiptCommandId",
  "receiptRequestSha256", "receiptEffectSha256",
] as const);
const SHA256 = /^[0-9a-f]{64}$/u;
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;

function corrupt(): never {
  throw new DecisionLedgerIntegrityError();
}

function exactRecord(value: unknown, keys: readonly string[]): DataRecord {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return corrupt();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return corrupt();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    return corrupt();
  }
  return value as DataRecord;
}

function own(record: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) return corrupt();
  return descriptor.value;
}

function denseArray(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (types.isProxy(value) || !Array.isArray(value)) return corrupt();
  if (Object.getPrototypeOf(value) !== Array.prototype) return corrupt();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (!Number.isSafeInteger(length) || (length as number) < minimum || (length as number) > maximum) {
    return corrupt();
  }
  const expected = new Set(["length", ...Array.from({ length: length as number }, (_, i) => String(i))]);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    return corrupt();
  }
  return Array.from({ length: length as number }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : corrupt();
  });
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_UTF8_BYTES ||
      !Reflect.apply(stringIsWellFormed, value, []) || value.includes("\0") ||
      textEncoder.encode(value).byteLength > MAX_IDENTIFIER_UTF8_BYTES) return corrupt();
  return value;
}

function digest(value: unknown): string {
  return typeof value === "string" && SHA256.test(value) ? value : corrupt();
}

function nonnegative(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : corrupt();
}

export function decisionLegReceiptCommandId(decisionId: string, legIndex: number): string {
  const canonicalDecisionId = digest(decisionId);
  const canonicalIndex = nonnegative(legIndex);
  if (canonicalIndex >= MAX_DECISION_LEGS) return corrupt();
  const base = `${INTERNAL_IDENTIFIER_PREFIX}decision-effect:${canonicalDecisionId}`;
  return canonicalIndex === 0 ? base : `${base}${LEG_RECEIPT_SEPARATOR}${canonicalIndex}`;
}

function snapshotLeg(raw: unknown, decisionId: string, position: number): DecisionLegRosterLeg {
  const leg = exactRecord(raw, LEG_KEYS);
  const index = nonnegative(own(leg, "index"));
  if (index !== position) return corrupt();
  const aggregateId = identifier(own(leg, "aggregateId"));
  const expectedVersion = nonnegative(own(leg, "expectedVersion"));
  const receiptCommandId = own(leg, "receiptCommandId");
  const receiptRequestSha256 = own(leg, "receiptRequestSha256");
  const receiptEffectSha256 = own(leg, "receiptEffectSha256");
  const nullReceipt = receiptCommandId === null && receiptRequestSha256 === null && receiptEffectSha256 === null;
  if (nullReceipt) return Object.freeze({
    aggregateId, expectedVersion, index,
    receiptCommandId: null, receiptEffectSha256: null, receiptRequestSha256: null,
  });
  if (receiptCommandId !== decisionLegReceiptCommandId(decisionId, index)) return corrupt();
  return Object.freeze({
    aggregateId, expectedVersion, index, receiptCommandId,
    receiptEffectSha256: digest(receiptEffectSha256),
    receiptRequestSha256: digest(receiptRequestSha256),
  });
}

function snapshotRoster(raw: unknown): DecisionLegRoster {
  const roster = exactRecord(raw, ROSTER_KEYS);
  if (own(roster, "version") !== DECISION_LEG_ROSTER_VERSION) return corrupt();
  const decisionId = digest(own(roster, "decisionId"));
  const count = nonnegative(own(roster, "count"));
  const rawLegs = denseArray(own(roster, "legs"), 1, MAX_DECISION_LEGS);
  if (count !== rawLegs.length) return corrupt();
  const aggregates = new Set<string>();
  const receipts = new Set<string>();
  const legs = rawLegs.map((rawLeg, position) => {
    const leg = snapshotLeg(rawLeg, decisionId, position);
    if (aggregates.has(leg.aggregateId)) return corrupt();
    aggregates.add(leg.aggregateId);
    if (leg.receiptCommandId !== null) {
      if (receipts.has(leg.receiptCommandId)) return corrupt();
      receipts.add(leg.receiptCommandId);
    }
    return leg;
  });
  return Object.freeze({ version: DECISION_LEG_ROSTER_VERSION, decisionId, count, legs: Object.freeze(legs) });
}

export function snapshotDecisionLegRoster(raw: unknown): DecisionLegRoster {
  try { return snapshotRoster(raw); } catch { return corrupt(); }
}

type LegTuple = readonly [number, string, number, string | null, string | null, string | null];
type RosterTuple = readonly [typeof DECISION_LEG_ROSTER_VERSION, string, number, readonly LegTuple[]];

function rosterTuple(roster: DecisionLegRoster): RosterTuple {
  return [roster.version, roster.decisionId, roster.count, roster.legs.map((leg) => [
    leg.index, leg.aggregateId, leg.expectedVersion, leg.receiptCommandId,
    leg.receiptRequestSha256, leg.receiptEffectSha256,
  ])];
}

function rosterFromTuple(raw: unknown): unknown {
  const tuple = denseArray(raw, 4, 4);
  const legs = denseArray(tuple[3], 1, MAX_DECISION_LEGS).map((rawLeg) => {
    const leg = denseArray(rawLeg, 6, 6);
    return {
      index: leg[0], aggregateId: leg[1], expectedVersion: leg[2],
      receiptCommandId: leg[3], receiptRequestSha256: leg[4], receiptEffectSha256: leg[5],
    };
  });
  return { version: tuple[0], decisionId: tuple[1], count: tuple[2], legs };
}

function snapshotEncodedBytes(raw: unknown): Uint8Array {
  if (types.isProxy(raw) || !types.isUint8Array(raw) ||
      bufferGetter === undefined || byteLengthGetter === undefined || byteOffsetGetter === undefined) {
    return corrupt();
  }
  try {
    const buffer = Reflect.apply(bufferGetter, raw, []) as ArrayBufferLike;
    const byteLength = Reflect.apply(byteLengthGetter, raw, []) as number;
    const byteOffset = Reflect.apply(byteOffsetGetter, raw, []) as number;
    if (types.isSharedArrayBuffer(buffer) || byteLength < 1 || byteLength > MAX_DECISION_LEG_ROSTER_BYTES) {
      return corrupt();
    }
    const bytes = new Uint8Array(byteLength);
    bytes.set(new Uint8Array(buffer, byteOffset, byteLength));
    return bytes;
  } catch { return corrupt(); }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

export function encodeDecisionLegRoster(raw: DecisionLegRoster): Uint8Array {
  const roster = snapshotDecisionLegRoster(raw);
  const bytes = textEncoder.encode(JSON.stringify(rosterTuple(roster)));
  return bytes.byteLength <= MAX_DECISION_LEG_ROSTER_BYTES ? bytes : corrupt();
}

export function decodeDecisionLegRoster(raw: unknown): DecisionLegRoster {
  try {
    const bytes = snapshotEncodedBytes(raw);
    const roster = snapshotDecisionLegRoster(rosterFromTuple(JSON.parse(fatalDecoder.decode(bytes))));
    return bytesEqual(bytes, encodeDecisionLegRoster(roster)) ? roster : corrupt();
  } catch { return corrupt(); }
}

export function identifyDecisionLegRoster(roster: DecisionLegRoster): string {
  return createHash("sha256").update(encodeDecisionLegRoster(roster)).digest("hex");
}
