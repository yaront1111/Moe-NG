import type { DatabaseSync } from "node:sqlite";

import { isSqliteBusy } from "../sqlite-schema-bootstrap.js";
import { DurableStoreError } from "../store-contracts.js";
import { requireIdentifier } from "../store-input-primitives.js";
import {
  SNAPSHOT_SUBSCRIBER_PREFIX, decodeSnapshotDoc, encodeSubscriberDoc, isReservedSubscriberId,
  parsePosition, refuse, snapshotSubscriberId,
} from "./subscription-contracts.js";
import type {
  SnapshotDoc, SubscriptionCode, SubscriptionLayer, SubscriptionRefused, SubscriptionSeated,
} from "./subscription-contracts.js";

/**
 * Shared refusal machinery and durable readers for the subscription module. Refusals travel
 * as a private throw so every entry point stays linear and has exactly one rollback point;
 * they are converted back into a frozen result at the boundary and nowhere else. A rollback
 * that cannot be proven raises OUTCOME_UNKNOWN instead of reporting a clean outcome, so
 * uncertainty keeps its authority.
 */

export const SELECT_DOC = "SELECT filter_json FROM event_subscriptions WHERE subscriber_id = ?";
export const INSERT_DOC =
  "INSERT INTO event_subscriptions (subscriber_id, filter_json, created_at) VALUES (?, ?, ?)";
export const UPSERT_DOC = `${INSERT_DOC}
  ON CONFLICT(subscriber_id) DO UPDATE SET filter_json = excluded.filter_json`;
export const UPDATE_DOC =
  "UPDATE event_subscriptions SET filter_json = ? WHERE subscriber_id = ? AND filter_json = ?";

class SubscriptionRefusal extends Error {
  public readonly result: SubscriptionRefused;

  public constructor(result: SubscriptionRefused) {
    super(`${result.code}: ${result.detail}`);
    this.name = "SubscriptionRefusal";
    this.result = result;
  }
}

export function deny(code: SubscriptionCode, layer: SubscriptionLayer, detail: string): never {
  throw new SubscriptionRefusal(refuse(code, layer, detail));
}

export function corrupt(detail: string): never {
  return deny("SUBSCRIPTION_STATE_CORRUPT", "STATE", detail);
}

export function requireInput<Value>(field: string, read: () => Value): Value {
  try {
    return read();
  } catch (error) {
    if (error instanceof SubscriptionRefusal) {
      throw error;
    }
    return deny(
      "SUBSCRIPTION_INPUT_INVALID", "INPUT",
      error instanceof Error ? error.message : `${field} is not valid durable input`,
    );
  }
}

function busyOrThrow(error: unknown, detail: string): SubscriptionRefused {
  if (isSqliteBusy(error)) {
    return refuse("SUBSCRIPTION_STORE_BUSY", "STATE", detail);
  }
  throw error;
}

/** Converts a thrown refusal back into a result; anything else that is not a busy store keeps
 *  its own authority and propagates. */
export function refusable<Result>(
  run: () => Result, detail = "the subscription store is busy",
): Result | SubscriptionRefused {
  try {
    return run();
  } catch (error) {
    if (error instanceof SubscriptionRefusal) {
      return error.result;
    }
    return busyOrThrow(error, detail);
  }
}

function rollback(database: DatabaseSync, cause: unknown): void {
  if (!database.isTransaction) {
    return;
  }
  try {
    database.exec("ROLLBACK");
  } catch (rollbackError) {
    throw new DurableStoreError(
      "OUTCOME_UNKNOWN",
      "subscription write outcome could not be proven; reopen and verify durable state",
      { cause: new AggregateError([cause, rollbackError]) },
    );
  }
}

/** Every write runs here: one BEGIN IMMEDIATE, every dependent read taken inside it, one
 *  commit. No decision may be made from state read before the lock was held. */
export function inTransaction<Result>(
  database: DatabaseSync, run: () => Result,
): Result | SubscriptionRefused {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    return busyOrThrow(error, "the subscription write lock is held by another writer");
  }
  return refusable(() => {
    try {
      const result = run();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(database, error);
      throw error;
    }
  }, "the subscription write timed out");
}

/** Joins an explicit caller-owned transaction; otherwise owns and commits an immediate one. */
export function inTransactionOrExisting<Result>(
  database: DatabaseSync, run: () => Result,
): Result | SubscriptionRefused {
  return database.isTransaction
    ? refusable(run, "the subscription write timed out")
    : inTransaction(database, run);
}

/**
 * Every read that feeds one decision must come from ONE snapshot. Two plain SELECTs can
 * straddle a concurrent advanceGeneration and show a generation from after it beside a
 * baseline from before it, which would look exactly like durable corruption. Reuses the
 * caller's transaction when there already is one, so this never nests.
 */
export function inReadSnapshot<Result>(database: DatabaseSync, run: () => Result): Result {
  if (database.isTransaction) {
    return run();
  }
  database.exec("BEGIN DEFERRED");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    rollback(database, error);
    throw error;
  }
}

export function currentGeneration(database: DatabaseSync): number | null {
  const value = database
    .prepare("SELECT MAX(generation) AS generation FROM cursor_generations").get()?.["generation"];
  return typeof value === "number" ? value : null;
}

export function requireGeneration(database: DatabaseSync): number {
  const generation = currentGeneration(database);
  if (generation === null) {
    return deny("SUBSCRIPTION_GENERATION_MISSING", "STATE", "no cursor generation exists");
  }
  return generation;
}

export function requireCurrentGeneration(database: DatabaseSync, claimed: unknown): number {
  const generation = requireGeneration(database);
  if (claimed !== generation) {
    return deny(
      "SUBSCRIPTION_GENERATION_MISSING", "STATE",
      `generation ${String(claimed)} is not the current generation ${generation}`,
    );
  }
  return generation;
}

/** NULL when the ledger is empty; every caller branches on that explicitly rather than letting
 *  a comparison against NULL quietly read as false. */
export function retainedFloor(database: DatabaseSync): bigint | null {
  const value = database
    .prepare("SELECT MIN(global_position) AS floor FROM domain_events").get()?.["floor"];
  if (typeof value === "bigint") {
    return value;
  }
  return typeof value === "number" ? BigInt(value) : null;
}

/** An absent row means the projection has never run, which is position 0 — not an error. */
export function projectionCheckpoint(database: DatabaseSync, projection: string): bigint {
  const row = database
    .prepare("SELECT last_applied_position FROM projections WHERE projection_name = ?")
    .get(projection);
  if (row === undefined) {
    return 0n;
  }
  const position = parsePosition(row["last_applied_position"]);
  return position ?? corrupt(`the ${projection} projection checkpoint is unparseable`);
}

export function docRow(database: DatabaseSync, subscriberId: string): string | null {
  const value = database.prepare(SELECT_DOC).get(subscriberId)?.["filter_json"];
  return typeof value === "string" ? value : null;
}

export interface StoredSnapshot {
  readonly doc: SnapshotDoc;
  readonly text: string;
}

/** Never fabricates a baseline: a missing sentinel and an unparseable one are distinguishable
 *  STATE_CORRUPT refusals, and a sentinel from an older generation is corrupt too, because
 *  advanceGeneration writes every baseline of a generation in one transaction. */
export function loadSnapshot(
  database: DatabaseSync, projection: string, generation: number,
): StoredSnapshot {
  const text = docRow(database, snapshotSubscriberId(projection));
  if (text === null) {
    return corrupt(`the ${projection} baseline snapshot is missing`);
  }
  const doc = decodeSnapshotDoc(text);
  if (doc === null) {
    return corrupt(`the ${projection} baseline snapshot is unparseable`);
  }
  if (doc.generation !== generation) {
    return corrupt(`the ${projection} baseline snapshot is from generation ${doc.generation}`);
  }
  return { doc, text };
}

/** The one subscriber-id gate. Every entry point uses it, because a call aimed at a sentinel
 *  id would overwrite the baseline a gapped consumer has to rebuild from. */
export function requireSubscriberId(value: unknown): string {
  if (typeof value === "string" && isReservedSubscriberId(value)) {
    return deny(
      "SUBSCRIPTION_INPUT_INVALID", "INPUT",
      `subscriber ids starting with ${SNAPSHOT_SUBSCRIBER_PREFIX} are reserved for baselines`,
    );
  }
  return requireInput("subscriberId", () => requireIdentifier(value, "subscriberId"));
}

export function requireDocText(text: string | null, subscriberId: string): string {
  if (text === null) {
    return deny(
      "SUBSCRIPTION_NOT_REGISTERED", "STATE", `${subscriberId} has no durable subscription`,
    );
  }
  return text;
}

export function encodedCursor(
  filter: readonly string[], generation: number, position: string, projection: string,
): string {
  const text = encodeSubscriberDoc({ filter, generation, position, projection });
  if (text === null) {
    return deny("SUBSCRIPTION_INPUT_INVALID", "INPUT", "the cursor doc is not encodable");
  }
  return text;
}

export function compareAndSet(
  database: DatabaseSync, subscriberId: string, expected: string, next: string,
): void {
  const { changes } = database.prepare(UPDATE_DOC).run(next, subscriberId, expected);
  if (Number(changes) !== 1) {
    corrupt(`the ${subscriberId} subscription row changed under the write`);
  }
}

export function seat(
  outcome: SubscriptionSeated["outcome"], generation: number, position: string,
  snapshot: SnapshotDoc,
): SubscriptionSeated {
  return Object.freeze({ cursor: Object.freeze({ generation, position }), outcome, snapshot });
}
