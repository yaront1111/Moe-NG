import type { DatabaseSync } from "node:sqlite";

import { canonicalProjectionState } from "../outbox-relay/outbox-relay-digests.js";
import { MAX_PAGE_SIZE } from "../store-contracts.js";
import type { StoredEvent } from "../store-contracts.js";
import { requireIdentifier } from "../store-input-primitives.js";
import { foldProjection } from "./projection-fold.js";
import type { ProjectionReducer, ProjectionState } from "./projection-fold.js";
import type { StoredEventUpcaster } from "./projection-upcast.js";
import type {
  ProjectionLedgerSource, ProjectionRebuildCode, ProjectionRebuildLayer,
  ProjectionRebuildRefused, ProjectionRebuildRequest, ProjectionRebuildResult,
} from "./projection-rebuild-contracts.js";

/**
 * Rebuilds one projection from the event ledger. The `projections` table stores a digest and
 * a position but never the state, so there is nothing to resume an accumulator from: a
 * rebuild ALWAYS re-folds from global position 0, which is what makes a restart mid-rebuild
 * idempotent by construction. While the walk is still behind the durable checkpoint it writes
 * nothing; on reaching that checkpoint it asserts the recomputed digest equals the stored one
 * and refuses rather than overwriting; past it, every page advances the row under the relay's
 * own compare-and-set, so a rebuild racing a live relay LOSES instead of clobbering.
 */

export * from "./projection-rebuild-contracts.js";

const DEFAULT_PAGE_LIMIT = 100;
const EMPTY_STATE: ProjectionState = Object.freeze({});
const PROJECTION_QUERY =
  "SELECT last_applied_position, state_digest FROM projections WHERE projection_name = ?";
/** Byte-for-byte the relay's own compare-and-set, so both writers agree on what "the row is
 *  still what I read" means and neither can silently win a race the other lost. */
const PROJECTION_UPSERT = `INSERT INTO projections
    (projection_name, last_applied_position, state_digest) VALUES (?, ?, ?)
  ON CONFLICT (projection_name) DO UPDATE SET
    last_applied_position = excluded.last_applied_position, state_digest = excluded.state_digest
  WHERE last_applied_position = ? AND state_digest IS ?`;

interface RebuildPlan {
  readonly name: string; readonly originDigest: string; readonly originState: ProjectionState;
  readonly pageLimit: number; readonly reducers: Readonly<Record<string, ProjectionReducer>>;
  readonly source: ProjectionLedgerSource; readonly upcaster: StoredEventUpcaster;
}
interface Expectation { readonly digest: string | null; readonly position: bigint; }
interface Progress {
  readonly digest: string; readonly pages: number; readonly position: bigint;
  readonly state: ProjectionState;
}

const ORIGIN_EXPECTATION: Expectation = Object.freeze({ digest: null, position: 0n });

class RebuildRefusal extends Error {
  public readonly result: ProjectionRebuildRefused;

  public constructor(result: ProjectionRebuildRefused) {
    super(`${result.code}: ${result.detail}`);
    this.name = "RebuildRefusal";
    this.result = result;
  }
}

function deny(
  code: ProjectionRebuildCode, layer: ProjectionRebuildLayer, detail: string,
  fold: ProjectionRebuildRefused["fold"] = null,
): never {
  throw new RebuildRefusal(Object.freeze({ code, detail, fold, layer, outcome: "REFUSED" }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "the rebuild input was rejected";
}

function planRebuild(request: ProjectionRebuildRequest): RebuildPlan {
  // The variable annotation (not just the arrow's) is what lets TypeScript treat a call as
  // unreachable-after, so `origin` narrows below.
  const bad: (detail: string) => never = (detail) =>
    deny("PROJECTION_REBUILD_INPUT_INVALID", "INPUT", detail);
  let name: string;
  try {
    name = requireIdentifier(request.name, "name");
  } catch (error) {
    return bad(`name is not usable: ${describeError(error)}`);
  }
  const pageLimit = request.pageLimit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_PAGE_SIZE) {
    bad(`pageLimit must be a safe integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  if (typeof request.source?.readEventsAfter !== "function") {
    bad("source must expose readEventsAfter");
  }
  if (typeof request.upcaster?.upcast !== "function") {
    bad("upcaster must expose upcast");
  }
  if (typeof request.reducers !== "object" || request.reducers === null) {
    bad("reducers must be a record keyed by event type");
  }
  const origin = canonicalProjectionState(request.state ?? EMPTY_STATE);
  if (origin === null) {
    bad("state must be recursively plain projection state");
  }
  return {
    name, originDigest: origin.digest, originState: origin.state, pageLimit,
    reducers: request.reducers, source: request.source, upcaster: request.upcaster,
  };
}

function readDurable(database: DatabaseSync, name: string): Expectation | null {
  const row = database.prepare(PROJECTION_QUERY).get(name);
  if (row === undefined) {
    return null;
  }
  const digest = row["state_digest"];
  return Object.freeze({
    digest: typeof digest === "string" ? digest : null,
    position: BigInt(String(row["last_applied_position"])),
  });
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction is already closed; the refusal below is the reportable outcome.
  }
}

/**
 * One BEGIN IMMEDIATE that reads the durable row and compare-and-sets it in the same
 * snapshot, so no decision is ever made from state that could have moved in between.
 * `expected` is the rebuild's OWN last written value, which is what makes a foreign advance
 * between pages lose the compare-and-set rather than get overwritten.
 */
function persist(
  database: DatabaseSync, plan: RebuildPlan, expected: Expectation | null,
  position: bigint, digest: string,
): Expectation {
  database.exec("BEGIN IMMEDIATE");
  try {
    const observed = readDurable(database, plan.name);
    const base = expected ?? observed ?? ORIGIN_EXPECTATION;
    if (observed !== null && observed.position > position) {
      deny("PROJECTION_REBUILD_STATE_CONFLICT", "STATE",
        `durable checkpoint ${observed.position} runs ahead of the rebuilt position ${position}`);
    }
    if (observed !== null && observed.position === position && observed.digest !== digest) {
      deny("PROJECTION_REBUILD_STATE_CONFLICT", "STATE",
        `durable digest at position ${position} is not what the ledger rebuilds to`);
    }
    const changes = Number(database.prepare(PROJECTION_UPSERT).run(
      plan.name, String(position), digest, String(base.position), base.digest,
    ).changes);
    if (changes !== 1) {
      deny("PROJECTION_REBUILD_STATE_CONFLICT", "STATE",
        `the rebuild lost its compare-and-set on ${JSON.stringify(plan.name)}: ` +
        `SQLite changed ${changes} rows`);
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(database);
    if (error instanceof RebuildRefusal) {
      throw error;
    }
    deny("PROJECTION_REBUILD_WRITE_FAILED", "STATE",
      `projection ${JSON.stringify(plan.name)} was not advanced: ${describeError(error)}`);
  }
  return Object.freeze({ digest, position });
}

/** Never let a page cross the durable checkpoint: landing exactly on it is what lets the
 *  recomputed digest be compared against the stored one instead of stepping over it. */
function clampPage(
  items: readonly StoredEvent[], verifyAt: bigint, position: bigint,
): readonly StoredEvent[] {
  return position >= verifyAt ? items : items.filter((event) => event.globalPosition <= verifyAt);
}

function foldPage(plan: RebuildPlan, carried: Progress, events: readonly StoredEvent[]): Progress {
  const folded = foldProjection({
    checkpoint: { globalPosition: carried.position }, events,
    reducers: plan.reducers, state: carried.state, upcaster: plan.upcaster,
  });
  if (!folded.ok) {
    deny("PROJECTION_REBUILD_FOLD_REFUSED", "PROJECTION", folded.detail, Object.freeze({
      code: folded.code, eventId: folded.eventId, layer: folded.layer,
    }));
  }
  const canonical = canonicalProjectionState(folded.state);
  if (canonical === null) {
    deny("PROJECTION_REBUILD_WRITE_FAILED", "PROJECTION",
      "the rebuilt state is not canonically representable");
  }
  return {
    digest: canonical.digest, pages: carried.pages + 1,
    position: folded.checkpoint.globalPosition, state: canonical.state,
  };
}

function walk(database: DatabaseSync, plan: RebuildPlan): ProjectionRebuildResult {
  const verifyAt = readDurable(database, plan.name)?.position ?? 0n;
  let carried: Progress = {
    digest: plan.originDigest, pages: 0, position: 0n, state: plan.originState,
  };
  let expected: Expectation | null = null;
  let persisted = false;
  for (;;) {
    const page = plan.source.readEventsAfter(carried.position, plan.pageLimit);
    const events = clampPage(page.items, verifyAt, carried.position);
    if (events.length === 0) {
      break;
    }
    carried = foldPage(plan, carried, events);
    if (carried.position >= verifyAt) {
      expected = persist(database, plan, expected, carried.position, carried.digest);
      persisted = true;
    }
    if (!page.hasMore) {
      break;
    }
  }
  if (!persisted) {
    persist(database, plan, expected, carried.position, carried.digest);
  }
  return Object.freeze({
    checkpoint: Object.freeze({ globalPosition: carried.position }), outcome: "REBUILT" as const,
    pages: carried.pages, state: carried.state, stateDigest: carried.digest,
  });
}

/**
 * Rebuilds `request.name` from the ledger behind `request.source`. Returns a frozen outcome
 * for every failure it can name; anything it cannot classify — a ledger read that throws, a
 * store error — is rethrown unchanged, so an unproven outcome never reads as a success.
 */
export function rebuildProjection(
  database: DatabaseSync, request: ProjectionRebuildRequest,
): ProjectionRebuildResult {
  try {
    return walk(database, planRebuild(request));
  } catch (error) {
    if (error instanceof RebuildRefusal) {
      return error.result;
    }
    throw error;
  }
}
