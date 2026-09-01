import type { DatabaseSync } from "node:sqlite";

import {
  requireCanonicalTimestamp, requireIdentifier, requireNonnegativeBigInt,
} from "../store-input-primitives.js";
import {
  SNAPSHOT_SUBSCRIBER_PREFIX, decodeSnapshotDoc, decodeSubscriberDoc, encodeSnapshotDoc,
  formatPosition, isReservedSubscriberId, parsePosition, snapshotSubscriberId,
} from "./subscription-contracts.js";
import type {
  AdvanceGenerationInput, RegisterSubscriptionInput, ReseatInput,
  SnapshotDoc, SnapshotPublishInput, SubscriptionAdvanceResult,
  SubscriptionPublishResult, SubscriptionSeatResult, SubscriptionSeated,
} from "./subscription-contracts.js";
import {
  INSERT_DOC, UPSERT_DOC, compareAndSet, corrupt, currentGeneration, deny, docRow,
  encodedCursor, inTransaction, inTransactionOrExisting, loadSnapshot, projectionCheckpoint,
  requireCurrentGeneration, requireDocText, requireGeneration, requireInput, requireSubscriberId,
  retainedFloor, seat,
} from "./subscription-internals.js";
import { clearAllPendingOffers, clearPendingOffer } from "./subscription-offers.js";

export { acknowledge } from "./subscription-acknowledge.js";

/**
 * The durable subscription write surface. Each operation owns one BEGIN IMMEDIATE, except
 * reseating, which joins an explicit caller transaction when the durable command ledger is
 * committing the authorization for that move. Every dependent read remains inside that one
 * transaction and every update compares-and-sets the exact bytes it read.
 */

/** ORIGIN is only honest while nothing has been pruned: either the ledger still starts at
 *  position 1, or it is empty and the projection has never advanced past it. */
function originPosition(database: DatabaseSync, projection: string): string {
  const floor = retainedFloor(database);
  const intact = floor === null ? projectionCheckpoint(database, projection) === 0n : floor <= 1n;
  if (!intact) {
    return deny(
      "SUBSCRIPTION_INPUT_INVALID", "INPUT",
      "an origin start is unavailable because retained history no longer begins at the origin",
    );
  }
  return "0";
}

export function registerSubscription(
  database: DatabaseSync, input: RegisterSubscriptionInput,
): SubscriptionSeatResult {
  return inTransaction(database, (): SubscriptionSeated => {
    const subscriberId = requireSubscriberId(input.subscriberId);
    const projection = requireInput("projection", () =>
      requireIdentifier(input.projection, "projection"));
    const at = requireInput("at", () => requireCanonicalTimestamp(input.at, "at"));
    const generation = requireGeneration(database);
    if (docRow(database, subscriberId) !== null) {
      deny("SUBSCRIPTION_INPUT_INVALID", "INPUT", `${subscriberId} is already registered`);
    }
    const { doc } = loadSnapshot(database, projection, generation);
    const position = input.startMode === "ORIGIN"
      ? originPosition(database, projection)
      : doc.checkpoint;
    const text = encodedCursor(input.filter ?? [], generation, position, projection);
    database.prepare(INSERT_DOC).run(subscriberId, text, at);
    return seat("REGISTERED", generation, position, doc);
  });
}

export function publishSnapshot(
  database: DatabaseSync, input: SnapshotPublishInput,
): SubscriptionPublishResult {
  return inTransaction(database, () => {
    const projection = requireInput("projection", () =>
      requireIdentifier(input.projection, "projection"));
    const checkpoint = requireInput("checkpoint", () =>
      requireNonnegativeBigInt(input.checkpoint, "checkpoint"));
    const generation = requireCurrentGeneration(database, input.generation);
    const { doc, text } = loadSnapshot(database, projection, generation);
    if (checkpoint < (parsePosition(doc.checkpoint) ?? 0n)) {
      deny(
        "SUBSCRIPTION_SNAPSHOT_REGRESSION", "STATE",
        `checkpoint ${formatPosition(checkpoint)} is behind the baseline ${doc.checkpoint}`,
      );
    }
    const next = encodeSnapshotDoc({
      checkpoint: formatPosition(checkpoint), generation, projection,
      state: input.state, stateDigest: input.stateDigest,
    });
    const published = next === null ? null : decodeSnapshotDoc(next);
    if (next === null || published === null) {
      deny("SUBSCRIPTION_INPUT_INVALID", "INPUT", "the snapshot doc is not encodable");
    }
    compareAndSet(database, snapshotSubscriberId(projection), text, next);
    return Object.freeze({ outcome: "PUBLISHED" as const, snapshot: published });
  });
}

/** Every projection that already has a baseline sentinel or a live subscriber must be carried
 *  into the new generation, or its consumers would gap forever with nothing to rebuild from. */
function coveredProjections(database: DatabaseSync): ReadonlySet<string> {
  const covered = new Set<string>();
  const rows = database.prepare("SELECT subscriber_id, filter_json FROM event_subscriptions").all();
  for (const row of rows) {
    const subscriberId = String(row["subscriber_id"]);
    if (isReservedSubscriberId(subscriberId)) {
      covered.add(subscriberId.slice(SNAPSHOT_SUBSCRIBER_PREFIX.length));
      continue;
    }
    const stored = row["filter_json"];
    const doc = typeof stored === "string" ? decodeSubscriberDoc(stored) : null;
    if (doc === null) {
      corrupt(`the ${subscriberId} cursor doc is unparseable`);
    }
    covered.add(doc.projection);
  }
  return covered;
}

function encodedBaselines(
  input: AdvanceGenerationInput, generation: number,
): ReadonlyMap<string, string> {
  const baselines = new Map<string, string>();
  if (!Array.isArray(input.baselines)) {
    deny("SUBSCRIPTION_INPUT_INVALID", "INPUT", "baselines must be an array of snapshots");
  }
  for (const item of input.baselines) {
    const projection = requireInput("baseline.projection", () =>
      requireIdentifier(item.projection, "baseline.projection"));
    const checkpoint = requireInput("baseline.checkpoint", () =>
      requireNonnegativeBigInt(item.checkpoint, "baseline.checkpoint"));
    const text = encodeSnapshotDoc({
      checkpoint: formatPosition(checkpoint), generation, projection,
      state: item.state, stateDigest: item.stateDigest,
    });
    if (text === null || baselines.has(projection)) {
      deny(
        "SUBSCRIPTION_INPUT_INVALID", "INPUT",
        `the ${projection} baseline is duplicated or not encodable`,
      );
    }
    baselines.set(projection, text);
  }
  return baselines;
}

export function advanceGeneration(
  database: DatabaseSync, input: AdvanceGenerationInput,
): SubscriptionAdvanceResult {
  return inTransaction(database, () => {
    const at = requireInput("at", () => requireCanonicalTimestamp(input.at, "at"));
    const reason = requireInput("reason", () => requireIdentifier(input.reason, "reason"));
    const generation = (currentGeneration(database) ?? 0) + 1;
    const baselines = encodedBaselines(input, generation);
    for (const projection of coveredProjections(database)) {
      if (!baselines.has(projection)) {
        deny(
          "SUBSCRIPTION_GENERATION_BASELINE_MISSING", "STATE",
          `projection ${projection} has no baseline snapshot in the new generation`,
        );
      }
    }
    database
      .prepare("INSERT INTO cursor_generations (generation, created_at, reason) VALUES (?, ?, ?)")
      .run(generation, at, reason);
    clearAllPendingOffers(database);
    const upsert = database.prepare(UPSERT_DOC);
    for (const [projection, text] of baselines) {
      upsert.run(snapshotSubscriberId(projection), text, at);
    }
    return Object.freeze({ generation, outcome: "ADVANCED" as const });
  });
}

/** Refuses when the first event the baseline still needs has already been pruned, because a
 *  reseat onto an unreachable snapshot would gap again on the very next read. */
function requireReachableSnapshot(
  database: DatabaseSync, projection: string, snapshot: SnapshotDoc,
): void {
  const checkpoint = parsePosition(snapshot.checkpoint) ?? 0n;
  const floor = retainedFloor(database);
  const stale = floor === null
    ? checkpoint < projectionCheckpoint(database, projection)
    : checkpoint + 1n < floor;
  if (stale) {
    deny(
      "SUBSCRIPTION_SNAPSHOT_STALE", "STATE",
      `retained history no longer reaches the ${projection} baseline snapshot`,
    );
  }
}

export function reseatToSnapshot(
  database: DatabaseSync, input: ReseatInput,
): SubscriptionSeatResult {
  return inTransactionOrExisting(database, (): SubscriptionSeated => {
    const subscriberId = requireSubscriberId(input.subscriberId);
    const projection = requireInput("projection", () =>
      requireIdentifier(input.projection, "projection"));
    const generation = requireGeneration(database);
    const text = requireDocText(docRow(database, subscriberId), subscriberId);
    const doc = decodeSubscriberDoc(text);
    if (doc !== null && doc.projection !== projection) {
      deny(
        "SUBSCRIPTION_INPUT_INVALID", "INPUT",
        `${subscriberId} follows ${doc.projection}, not ${projection}`,
      );
    }
    const { doc: snapshot } = loadSnapshot(database, projection, generation);
    requireReachableSnapshot(database, projection, snapshot);
    compareAndSet(database, subscriberId, text,
      encodedCursor(doc?.filter ?? [], generation, snapshot.checkpoint, projection));
    clearPendingOffer(database, subscriberId);
    return seat("RESEATED", generation, snapshot.checkpoint, snapshot);
  });
}
