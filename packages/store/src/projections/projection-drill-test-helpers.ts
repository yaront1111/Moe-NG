import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalProjectionState } from "../outbox-relay/outbox-relay-digests.js";
import { relayMessage } from "../outbox-relay/transactional-outbox-relay.js";
import type {
  OutboxRelayRequest, RelayCommitSeam,
} from "../outbox-relay/transactional-outbox-relay.js";
import { DOMAIN_EVENT_SCHEMA_VERSION } from "../store-contracts.js";
import type { CommitInput } from "../store-contracts.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import type { ProjectionReducer, ProjectionState } from "./projection-fold.js";
import { compileStoredEventUpcaster } from "./projection-upcast.js";
import type { StoredEventUpcaster } from "./projection-upcast.js";

/**
 * Shared fixtures for the projection crash and rebuild drills: one domain, one reducer set,
 * one upcaster, and one incremental driver, so the rebuild and the relay are compared on
 * genuinely identical inputs. Everything here is deterministic — a seeded PRNG, a fixed
 * timestamp, no clock and no `Math.random` — so any failing generated case is reproducible
 * from its seed alone. Test-only by the repo's `*-test-helpers.ts` convention, which is why
 * this file deliberately has no sibling `.js` runtime bridge.
 *
 * `bytes`/`text` are re-declared here rather than imported from
 * `sqlite-event-store-test-helpers.ts`: that module correctly has no `.js` bridge, and the
 * crash worker loads this file under plain Node, which does NOT resolve a `.js` specifier
 * back to its `.ts` sibling the way vitest and tsc silently do.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}
export function text(value: Uint8Array): string {
  return decoder.decode(value);
}

export const DRILL_AT = "2026-08-08T10:00:00.000Z";
export const DRILL_CONSUMER = "drill-consumer";
export const DRILL_PROJECT = "moe-drill-project";
export const DRILL_PROJECTION = "goal-count";
export const DRILL_TOPIC = "goal.projected";
export const PLAIN_EVENT = "goal.created";
export const UPCAST_EVENT = "goal.renamed";
export const UPCAST_CURRENT_VERSION = "moe-domain-schema/1";
/** Deliberately NOT `{}`: a rebuild that ignored its origin state would still match an
 *  empty-origin relay, so the parameter has to carry real fields to be load-bearing. */
export const DRILL_ORIGIN_STATE: ProjectionState = Object.freeze({
  count: 0, last: "", names: Object.freeze([]),
});

export const DRILL_UPCASTER: StoredEventUpcaster = compileStoredEventUpcaster([
  { currentVersion: DOMAIN_EVENT_SCHEMA_VERSION, eventType: PLAIN_EVENT, routes: [] },
  {
    currentVersion: UPCAST_CURRENT_VERSION,
    eventType: UPCAST_EVENT,
    routes: [{
      fromVersion: DOMAIN_EVENT_SCHEMA_VERSION,
      handler: ({ metadata, payload }) => ({ metadata, payload: bytes(`up:${text(payload)}`) }),
      toVersion: UPCAST_CURRENT_VERSION,
    }],
  },
]);

/** The `up:` prefix only exists after the upcaster ran, so a projection state carrying it is
 *  evidence the upcast hop was actually taken rather than skipped. */
export const DRILL_REDUCERS: Readonly<Record<string, ProjectionReducer>> = Object.freeze({
  [PLAIN_EVENT]: (state, event) => ({
    ...state, count: (state["count"] as number) + 1, last: event.eventId,
  }),
  [UPCAST_EVENT]: (state, event) => ({
    ...state, count: (state["count"] as number) + 1, last: event.eventId,
    names: [...(state["names"] as readonly string[]), text(event.payload)],
  }),
});

export interface DrillEvent {
  readonly eventId: string; readonly eventType: string; readonly payload: string;
}
export interface DrillCommit {
  readonly aggregateId: string; readonly commandId: string;
  readonly events: readonly DrillEvent[];
  /** Identity of the INBOUND message, when it must differ from the outbox ids — a redelivery
   *  needs fresh command/event/outbox ids but the same inbound envelope, or the command
   *  receipt dedupes first and the inbox is never consulted. Defaults to `messageId`. */
  readonly inboundId?: string;
  readonly messageId: string;
}
export interface DurableProjection {
  readonly digest: string | null; readonly position: bigint;
}
export interface DatabaseInvariants {
  readonly foreignKeyViolations: number; readonly integrity: string;
}
export interface IncrementalBuild {
  readonly checkpoint: bigint; readonly digest: string;
  readonly deliveries: number; readonly state: ProjectionState;
  /** Per-aggregate current version, so a later run can resume at the right expectedVersion. */
  readonly versions: Readonly<Record<string, number>>;
}
export interface RelayHistoryOptions {
  readonly reducers?: Readonly<Record<string, ProjectionReducer>>;
  readonly start?: IncrementalBuild;
}

export function drillDigest(state: ProjectionState): string {
  const canonical = canonicalProjectionState(state);
  if (canonical === null) {
    throw new Error("the drill state is not canonically representable");
  }
  return canonical.digest;
}

export const DRILL_ORIGIN_DIGEST = drillDigest(DRILL_ORIGIN_STATE);

/** Mulberry32. Integer seeds in, uniform [0, 1) out, identical on every platform. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function boundedInteger(next: () => number, minimum: number, maximum: number): number {
  return minimum + Math.floor(next() * (maximum - minimum + 1));
}

export function withDrillDirectory(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-drill-"));
  try {
    run(join(directory, "events.sqlite"));
  } finally {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
  }
}

export function openDrillStore(path: string): SqliteEventStore {
  return SqliteEventStore.openForProject(path, DRILL_PROJECT);
}

export function withDrillStore<Result>(
  path: string, run: (store: SqliteEventStore) => Result,
): Result {
  const store = openDrillStore(path);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

export function withDrillDatabase<Result>(
  path: string, read: (database: DatabaseSync) => Result,
): Result {
  const database = new DatabaseSync(path, { timeout: 5_000 });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

export function readDurableProjection(
  database: DatabaseSync, name: string = DRILL_PROJECTION,
): DurableProjection | null {
  const row = database
    .prepare("SELECT last_applied_position, state_digest FROM projections WHERE projection_name = ?")
    .get(name);
  if (row === undefined) {
    return null;
  }
  const digest = row["state_digest"];
  return Object.freeze({
    digest: typeof digest === "string" ? digest : null,
    position: BigInt(String(row["last_applied_position"])),
  });
}

/** SQLite's own verdict on the file after a hard kill, read on a fresh connection so no
 *  in-process cache can answer for the bytes on disk. */
export function inspectDrillDatabase(path: string): DatabaseInvariants {
  return withDrillDatabase(path, (database) => Object.freeze({
    foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all().length,
    integrity: String(database.prepare("PRAGMA integrity_check").get()?.["integrity_check"]),
  }));
}

export function ledgerEnd(database: DatabaseSync): bigint {
  const value = database
    .prepare("SELECT COALESCE(MAX(global_position), 0) AS end FROM domain_events").get()?.["end"];
  return BigInt(String(value ?? 0));
}

export function countRows(database: DatabaseSync, table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.["total"] ?? -1);
}

export function drillCommitInput(commit: DrillCommit, expectedVersion: number): CommitInput {
  return {
    aggregateId: commit.aggregateId,
    commandBytes: bytes(`{"command":"${commit.commandId}"}`),
    commandId: commit.commandId,
    committedAt: DRILL_AT,
    events: commit.events.map((event, index) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      outbox: [{
        messageId: `${commit.messageId}-out-${index}`,
        payload: bytes(event.payload),
        topic: DRILL_TOPIC,
      }],
      payload: bytes(event.payload),
    })),
    expectedVersion,
  };
}

/** Every field of the envelope derives from the inbound id, so two deliveries sharing that id
 *  produce the same receipt digest and dedupe rather than conflict. */
function inboundMessage(commit: DrillCommit): OutboxRelayRequest["message"] {
  const inboundId = commit.inboundId ?? commit.messageId;
  return { messageId: inboundId, payload: bytes(`inbound-${inboundId}`), topic: "goal.inbound" };
}

export function drillRelayRequest(
  commit: DrillCommit, expectedVersion: number, checkpoint: bigint, state: ProjectionState,
  reducers: Readonly<Record<string, ProjectionReducer>> = DRILL_REDUCERS,
): OutboxRelayRequest {
  return {
    commit: drillCommitInput(commit, expectedVersion),
    consumerId: DRILL_CONSUMER,
    message: inboundMessage(commit),
    projection: {
      checkpoint: { globalPosition: checkpoint }, name: DRILL_PROJECTION,
      reducers, state, upcaster: DRILL_UPCASTER,
    },
  };
}

/**
 * Drives `relayMessage` once per commit, threading the durable checkpoint and state exactly
 * as a live consumer would. Throws on anything but APPLIED, so a history that silently
 * stopped relaying can never be mistaken for one that was fully applied.
 */
export function relayHistory(
  store: RelayCommitSeam, commits: readonly DrillCommit[],
  options: RelayHistoryOptions = {},
): IncrementalBuild {
  const reducers = options.reducers ?? DRILL_REDUCERS;
  const start = options.start;
  const versions = new Map(Object.entries(start?.versions ?? {}));
  let checkpoint = start?.checkpoint ?? 0n;
  let deliveries = start?.deliveries ?? 0;
  let digest = start?.digest ?? DRILL_ORIGIN_DIGEST;
  let state = start?.state ?? DRILL_ORIGIN_STATE;
  for (const commit of commits) {
    const version = versions.get(commit.aggregateId) ?? 0;
    const result = relayMessage(
      store, drillRelayRequest(commit, version, checkpoint, state, reducers),
    );
    if (result.outcome !== "APPLIED") {
      throw new Error(`the drill relay did not apply ${commit.commandId}: ` +
        JSON.stringify(result, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value));
    }
    versions.set(commit.aggregateId, version + commit.events.length);
    checkpoint = result.checkpoint.globalPosition;
    deliveries += 1;
    digest = result.stateDigest;
    state = result.state;
  }
  return Object.freeze({
    checkpoint, deliveries, digest, state, versions: Object.fromEntries(versions),
  });
}

/** The history the crash worker relays, shared so the parent drill and the child agree on
 *  every identifier without either re-deriving it. */
export const CRASH_AGGREGATE = "goal-crash";

export function crashCommit(index: number): DrillCommit {
  return {
    aggregateId: CRASH_AGGREGATE,
    commandId: `cmd-crash-${index}`,
    events: [{
      eventId: `evt-crash-${index}`,
      eventType: index % 2 === 0 ? PLAIN_EVENT : UPCAST_EVENT,
      payload: `crash-${index}`,
    }],
    messageId: `msg-crash-${index}`,
  };
}

/** A four-commit curated history: two aggregates, a multi-event commit, and one event type
 *  that only reaches its current schema version through the upcaster. */
export function curatedHistory(): readonly DrillCommit[] {
  return Object.freeze([
    {
      aggregateId: "goal-1", commandId: "cmd-1", messageId: "msg-1",
      events: [{ eventId: "evt-1", eventType: PLAIN_EVENT, payload: "created-1" }],
    },
    {
      aggregateId: "goal-2", commandId: "cmd-2", messageId: "msg-2",
      events: [
        { eventId: "evt-2", eventType: PLAIN_EVENT, payload: "created-2" },
        { eventId: "evt-3", eventType: UPCAST_EVENT, payload: "renamed-3" },
      ],
    },
    {
      aggregateId: "goal-1", commandId: "cmd-3", messageId: "msg-3",
      events: [{ eventId: "evt-4", eventType: UPCAST_EVENT, payload: "renamed-4" }],
    },
    {
      aggregateId: "goal-2", commandId: "cmd-4", messageId: "msg-4",
      events: [{ eventId: "evt-5", eventType: PLAIN_EVENT, payload: "created-5" }],
    },
  ]);
}
