import { DatabaseSync } from "node:sqlite";

import { SqliteEventStore } from "@moe/store";
import { rebuildProjection } from "@moe/store/projections/projection-rebuild.js";
import type { ProjectionRebuilt } from "@moe/store/projections/projection-rebuild.js";
import { refuse } from "@moe/store/subscriptions/subscription-contracts.js";
import type {
  GenerationBaseline, SubscriptionSeatResult,
} from "@moe/store/subscriptions/subscription-contracts.js";
import {
  currentGeneration, projectionCheckpoint, refusable,
} from "@moe/store/subscriptions/subscription-internals.js";
import {
  advanceGeneration, publishSnapshot, registerSubscription,
} from "@moe/store/subscriptions/subscription-writes.js";

import {
  BOARD_PROJECTION, BoardProjectionConfigError, INITIAL_BOARD_STATE,
} from "./board-projection-contracts.js";
import type {
  BoardBaselineResult, BoardFoldResult, BoardProjectionService, BoardRefusal,
} from "./board-projection-contracts.js";
import { BOARD_UPCASTER, boardReducersFor } from "./board-projection-fold.js";

/**
 * Daemon driver for the moe.board projection, composed ONLY from committed store
 * machinery. Folding is `rebuildProjection`: the store persists a digest and a
 * position but never the state, so every advance re-folds from position 0 and lands
 * under the relay's own compare-and-set — losing a race instead of clobbering it.
 * The baseline is `advanceGeneration`, which writes the generation row and the
 * snapshot sentinel in one transaction; its `stateDigest` is the digest the rebuild
 * itself computed, never a hand-rolled one. Everything here is synchronous, and
 * every refusal a store layer produces is returned verbatim.
 *
 * The raw `DatabaseSync` beside the store is the sanctioned subscription-write
 * pattern (`SqliteEventStore` hides its handle); both must address the same file.
 */

export interface BoardProjectionServiceConfig {
  /** Canonical-UTC millisecond clock for durable timestamps; defaults to the system clock. */
  readonly clock?: () => string;
  /** Borrowed mode: a raw connection on the SAME file as `store`; the caller closes both. */
  readonly database?: DatabaseSync;
  readonly projectId?: string;
  readonly store?: SqliteEventStore;
  /** Owned mode: the service opens both handles on this path and `close()` releases them. */
  readonly storePath?: string;
}

interface Handles {
  readonly close: () => void;
  readonly database: DatabaseSync;
  readonly store: SqliteEventStore;
}

function openHandles(config: BoardProjectionServiceConfig): Handles {
  const { database, projectId, store, storePath } = config;
  if (store !== undefined && database !== undefined &&
      storePath === undefined && projectId === undefined) {
    return { close: (): void => { /* borrowed handles stay the caller's to close */ },
      database, store };
  }
  if (storePath !== undefined && projectId !== undefined &&
      store === undefined && database === undefined) {
    const owned = SqliteEventStore.openForProject(storePath, projectId);
    let raw: DatabaseSync;
    try {
      raw = new DatabaseSync(storePath, { timeout: 5_000 });
    } catch (error) {
      owned.close();
      throw error;
    }
    return { close: (): void => { raw.close(); owned.close(); }, database: raw, store: owned };
  }
  throw new BoardProjectionConfigError(
    "pass exactly one of { storePath, projectId } or { store, database }",
  );
}

function distinctEventTypes(database: DatabaseSync): readonly string[] {
  return database
    .prepare("SELECT DISTINCT event_type AS eventType FROM domain_events ORDER BY event_type")
    .all()
    .map((row) => String(row["eventType"]));
}

/** CAST to TEXT in SQL: positions are bigint columns, and the count rides along. */
function countApplied(database: DatabaseSync, after: bigint, upTo: bigint): number {
  const row = database
    .prepare("SELECT CAST(COUNT(*) AS TEXT) AS applied FROM domain_events " +
      "WHERE global_position > ? AND global_position <= ?")
    .get(String(after), String(upTo));
  return Number(row?.["applied"] ?? "0");
}

export function createBoardProjectionService(
  config: BoardProjectionServiceConfig,
): BoardProjectionService {
  const clock = config.clock ?? ((): string => new Date().toISOString());
  const handles = openHandles(config);
  const { database, store } = handles;

  /** Reducers are re-enumerated per fold so a type committed since the last call is
   *  covered; a type that lands BETWEEN the scan and the walk refuses (verbatim
   *  PROJECTION_REBUILD_FOLD_REFUSED) and the next call picks it up — fail closed. */
  const refold = (): BoardRefusal | ProjectionRebuilt => rebuildProjection(database, {
    name: BOARD_PROJECTION,
    reducers: boardReducersFor(distinctEventTypes(database)),
    source: store,
    state: INITIAL_BOARD_STATE,
    upcaster: BOARD_UPCASTER,
  });

  /** The rebuild's own canonical state and digest — this module never computes one. */
  const baselineOf = (rebuilt: ProjectionRebuilt): GenerationBaseline => Object.freeze({
    checkpoint: rebuilt.checkpoint.globalPosition,
    projection: BOARD_PROJECTION,
    state: rebuilt.state as GenerationBaseline["state"],
    stateDigest: rebuilt.stateDigest,
  });

  const ensureBaseline = (reason: string): BoardBaselineResult =>
    refusable((): BoardBaselineResult => {
      const existing = currentGeneration(database);
      if (existing !== null) {
        return Object.freeze({
          created: false, generation: existing, outcome: "BASELINE_READY" as const,
        });
      }
      const rebuilt = refold();
      if (rebuilt.outcome === "REFUSED") {
        return rebuilt;
      }
      const advanced = advanceGeneration(database, {
        at: clock(), baselines: [baselineOf(rebuilt)], reason,
      });
      if (advanced.outcome === "REFUSED") {
        return advanced;
      }
      return Object.freeze({
        created: true, generation: advanced.generation, outcome: "BASELINE_READY" as const,
      });
    });

  const foldOnce = (): BoardFoldResult => refusable((): BoardFoldResult => {
    const generation = currentGeneration(database);
    if (generation === null) {
      // The store's own wording for this state, refused BEFORE any row moves.
      return refuse("SUBSCRIPTION_GENERATION_MISSING", "STATE", "no cursor generation exists");
    }
    const before = projectionCheckpoint(database, BOARD_PROJECTION);
    const rebuilt = refold();
    if (rebuilt.outcome === "REFUSED") {
      return rebuilt;
    }
    // Refreshing the sentinel keeps SNAPSHOT registrations and gap reseats current.
    const published = publishSnapshot(database, { ...baselineOf(rebuilt), generation });
    if (published.outcome === "REFUSED") {
      return published;
    }
    const checkpoint = rebuilt.checkpoint.globalPosition;
    return Object.freeze({
      appliedCount: countApplied(database, before, checkpoint),
      checkpoint,
      outcome: "FOLDED" as const,
      stateDigest: rebuilt.stateDigest,
    });
  });

  const registerReader = (subscriberId: string): SubscriptionSeatResult =>
    registerSubscription(database, {
      at: clock(), projection: BOARD_PROJECTION, startMode: "SNAPSHOT", subscriberId,
    });

  return Object.freeze({ close: handles.close, ensureBaseline, foldOnce, registerReader });
}
