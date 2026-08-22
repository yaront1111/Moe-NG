import type { DatabaseSync } from "node:sqlite";

import { DurableStoreError } from "./store-contracts.js";
import type {
  CommandDecisionRecord,
  CommandDecisionResponse,
  CommitResult,
  StoreHealth,
} from "./store-contracts.js";
import { snapshotBytes } from "./store-input.js";
import {
  MAX_IDENTIFIER_UTF8_BYTES,
  MAX_SQLITE_INTEGER,
  canonicalTimestampPattern,
  stringIsWellFormed,
  textEncoder,
} from "./store-internals.js";
import type {
  StoredCommandDecision,
  StoredCommitResult,
} from "./store-internals.js";

export function requireRowString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new DurableStoreError("STORE_CORRUPT", `${column} is not text`);
  }
  return value;
}

export function requireStoredIdentifier(
  row: Record<string, unknown>,
  column: string,
): string {
  const value = requireRowString(row, column);
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_UTF8_BYTES ||
    !Reflect.apply(stringIsWellFormed, value, []) ||
    value.includes("\0") ||
    textEncoder.encode(value).byteLength > MAX_IDENTIFIER_UTF8_BYTES
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `${column} is not a valid durable identifier`,
    );
  }
  return value;
}

export function requireNullableStoredIntegerAtLeast(
  row: Record<string, unknown>,
  column: string,
  minimum: number,
): number | null {
  if (row[column] === null) {
    return null;
  }
  return requireStoredIntegerAtLeast(row, column, minimum);
}

export function requireNullableStoredIdentifier(
  row: Record<string, unknown>,
  column: string,
): string | null {
  if (row[column] === null) {
    return null;
  }
  return requireStoredIdentifier(row, column);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

export function requireRowInteger(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DurableStoreError("STORE_CORRUPT", `${column} is not a safe integer`);
  }
  return value;
}

export function requireStoredIntegerAtLeast(
  row: Record<string, unknown>,
  column: string,
  minimum: number,
): number {
  const value = requireRowInteger(row, column);
  if (value < minimum) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `${column} is below its durable minimum ${minimum}`,
    );
  }
  return value;
}

export function requireStoredTimestamp(
  row: Record<string, unknown>,
  column: string,
): string {
  const value = requireRowString(row, column);
  if (
    !canonicalTimestampPattern.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `${column} is not a canonical UTC timestamp`,
    );
  }
  return value;
}

export function requireStoredSha256(
  row: Record<string, unknown>,
  column: string,
): string {
  const value = requireRowString(row, column);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `${column} is not a lowercase SHA-256 digest`,
    );
  }
  return value;
}

export function requireStoredPositiveBigIntText(
  row: Record<string, unknown>,
  column: string,
): bigint {
  const value = requireRowString(row, column);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `${column} is not a positive integer cursor`,
    );
  }
  return BigInt(value);
}

export function requireInsertedPosition(
  result: { readonly lastInsertRowid: bigint | number },
  field: string,
): bigint {
  const value = result.lastInsertRowid;
  if (typeof value !== "bigint" || value <= 0n || value > MAX_SQLITE_INTEGER) {
    throw new DurableStoreError(
      "STORE_UNAVAILABLE",
      `SQLite did not return an exact positive ${field}`,
    );
  }
  return value;
}

export function requireRowBytes(
  row: Record<string, unknown>,
  column: string,
): Uint8Array {
  try {
    return snapshotBytes(row[column], column);
  } catch (error) {
    if (error instanceof DurableStoreError) {
      throw new DurableStoreError("STORE_CORRUPT", `${column} is not a byte string`);
    }
    throw error;
  }
}

export function toCommitResult(
  stored: StoredCommitResult,
  disposition: CommitResult["disposition"],
): CommitResult {
  return Object.freeze({
    aggregateId: stored.aggregateId,
    commandId: stored.commandId,
    currentVersion: stored.currentVersion,
    disposition,
    effectIdentityVersion: stored.effectIdentityVersion,
    effectSha256: stored.effectSha256,
    eventIds: Object.freeze([...stored.eventIds]),
    outboxMessageIds: Object.freeze([...stored.outboxMessageIds]),
    previousVersion: stored.previousVersion,
    requestSha256: stored.requestSha256,
  });
}

export function toCommandDecisionRecord(
  stored: StoredCommandDecision,
): CommandDecisionRecord {
  const common = {
    businessEventIds: Object.freeze([...stored.businessEventIds]),
    commandKind: stored.commandKind,
    correlationSha256: stored.correlationSha256,
    coverage: stored.coverage,
    decidedAt: stored.decidedAt,
    decisionId: stored.decisionId,
    decisionIdentityVersion: stored.decisionIdentityVersion,
    decisionPosition: stored.decisionPosition,
    decisionSha256: stored.decisionSha256,
    effectIdentityVersion: stored.effectIdentityVersion,
    effectSha256: stored.effectSha256,
    expectedVersion: stored.expectedVersion,
    key: Object.freeze({ ...stored.key }),
    observedVersion: stored.observedVersion,
    outboxMessageIds: Object.freeze([...stored.outboxMessageIds]),
    recordVersion: stored.recordVersion,
    requestIdentityVersion: stored.requestIdentityVersion,
    requestSha256: stored.requestSha256,
    resultBytes: stored.resultBytes.slice(),
    resultSha256: stored.resultSha256,
    resultVersion: stored.resultVersion,
    targetAggregateId: stored.targetAggregateId,
  };
  if (stored.effectDisposition === "EFFECTS_COMMITTED") {
    return Object.freeze({
      ...common,
      auditEventId: null,
      currentVersion: stored.currentVersion,
      effectDisposition: "EFFECTS_COMMITTED",
      previousVersion: stored.previousVersion,
      replayRequestSha256: stored.replayRequestSha256,
      resultCode: "EFFECTS_COMMITTED",
    });
  }
  return Object.freeze({
    ...common,
    auditEventId: stored.auditEventId,
    businessEventIds: Object.freeze([]) as readonly [],
    currentVersion: null,
    effectDisposition: "NO_BUSINESS_EFFECT",
    outboxMessageIds: Object.freeze([]) as readonly [],
    previousVersion: null,
    replayRequestSha256: null,
    resultCode: "EXPECTED_VERSION_CONFLICT",
  });
}

export function toCommandDecisionResponse(
  stored: StoredCommandDecision,
  disposition: CommandDecisionResponse["disposition"],
): CommandDecisionResponse {
  const historical = disposition === "REPLAYED";
  return Object.freeze({
    decision: toCommandDecisionRecord(stored),
    disposition,
    historical,
    requiresAffordanceRefresh: historical,
  });
}

export function readScalar(
  database: DatabaseSync,
  sql: string,
  column: string,
): string | number | bigint {
  const row = database.prepare(sql).get();
  const value = row?.[column];
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint"
  ) {
    throw new Error(`STORE_SCALAR_INVALID: ${column}`);
  }
  return value;
}

export function synchronousMode(value: number): StoreHealth["synchronous"] {
  switch (value) {
    case 0:
      return "off";
    case 1:
      return "normal";
    case 2:
      return "full";
    case 3:
      return "extra";
    default:
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `unknown SQLite synchronous mode ${value}`,
      );
  }
}
