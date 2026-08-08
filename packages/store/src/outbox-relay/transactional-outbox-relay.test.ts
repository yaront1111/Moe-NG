import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { compileStoredEventUpcaster } from "../projections/projection-upcast.js";
import type { StoredEventUpcaster } from "../projections/projection-upcast.js";
import type { ProjectionReducer, ProjectionState } from "../projections/projection-fold.js";
import { DOMAIN_EVENT_SCHEMA_VERSION, DurableStoreError } from "../store-contracts.js";
import type { CommitInput } from "../store-contracts.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { bytes } from "../sqlite-event-store-test-helpers.js";
import { relayMessage } from "./transactional-outbox-relay.js";
import type {
  OutboxRelayApplied, OutboxRelayDeduplicated, OutboxRelayMessage, OutboxRelayRefused,
  OutboxRelayRequest, OutboxRelayResult,
} from "./transactional-outbox-relay.js";

const AGGREGATE = "goal-1";
const CONSUMER = "relay-consumer";
const EVENT_TYPE = "goal.created";
const PROJECTION = "goal-count";
const SHA256 = /^[0-9a-f]{64}$/;
const EMPTY: DurableSnapshot = { events: [], inbox: [], outbox: [], projection: null };
const ORIGIN_STATE: ProjectionState = Object.freeze({ count: 0, last: "" });
const INBOUND: OutboxRelayMessage = Object.freeze({
  headers: bytes("h=1"), messageId: "inbound-1",
  payload: bytes("inbound-payload-1"), topic: "goal.inbound",
});
const UPCASTER = compileStoredEventUpcaster([
  { currentVersion: DOMAIN_EVENT_SCHEMA_VERSION, eventType: EVENT_TYPE, routes: [] },
]);
const UNREACHABLE_UPCASTER = compileStoredEventUpcaster([
  { currentVersion: "moe-domain-schema/9", eventType: EVENT_TYPE, routes: [] },
]);

interface Delivery {
  readonly commandId: string; readonly eventId: string; readonly messageId: string;
}
interface RelayOptions {
  readonly calls?: string[]; readonly checkpoint?: bigint;
  readonly message?: OutboxRelayMessage;
  readonly reducers?: Readonly<Record<string, ProjectionReducer>>;
  readonly state?: ProjectionState; readonly upcaster?: StoredEventUpcaster;
}
interface DurableSnapshot {
  readonly events: readonly string[]; readonly inbox: readonly string[];
  readonly outbox: readonly string[]; readonly projection: string | null;
}
type Open = () => SqliteEventStore;

function delivery(suffix: string): Delivery {
  return { commandId: `cmd-${suffix}`, eventId: `evt-${suffix}`, messageId: `msg-${suffix}` };
}

function commitInput(at: Delivery, expectedVersion: number): CommitInput {
  return {
    aggregateId: AGGREGATE, commandBytes: bytes(`{"command":"${at.commandId}"}`),
    commandId: at.commandId, committedAt: "2026-08-08T10:00:00.000Z",
    events: [{
      eventId: at.eventId, eventType: EVENT_TYPE,
      outbox: [{
        messageId: at.messageId, payload: bytes(`out-${at.messageId}`), topic: "goal.projected",
      }],
      payload: bytes(`payload-${at.eventId}`),
    }],
    expectedVersion,
  };
}

function counting(calls: string[]): Readonly<Record<string, ProjectionReducer>> {
  return {
    [EVENT_TYPE]: (state, event) => {
      calls.push(event.eventId);
      return { ...state, count: (state["count"] as number) + 1, last: event.eventId };
    },
  };
}

function ask(
  at: Delivery, expectedVersion: number, options: RelayOptions = {},
): OutboxRelayRequest {
  return {
    commit: commitInput(at, expectedVersion), consumerId: CONSUMER,
    message: options.message ?? INBOUND,
    projection: {
      checkpoint: { globalPosition: options.checkpoint ?? 0n }, name: PROJECTION,
      reducers: options.reducers ?? counting(options.calls ?? []),
      state: options.state ?? ORIGIN_STATE, upcaster: options.upcaster ?? UPCASTER,
    },
  };
}

function withStore(run: (open: Open, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-relay-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    run(() => SqliteEventStore.openForProject(databasePath, "moe-relay-project"), databasePath);
  } finally { rmSync(directory, { force: true, recursive: true }); }
}

function usingStore<Result>(open: Open, run: (store: SqliteEventStore) => Result): Result {
  const store = open();
  try { return run(store); } finally { store.close(); }
}
function withDatabase<Result>(path: string, read: (database: DatabaseSync) => Result): Result {
  const database = new DatabaseSync(path);
  try { return read(database); } finally { database.close(); }
}
function column(database: DatabaseSync, sql: string): readonly string[] {
  return database.prepare(sql).all().map((row) => Object.values(row).map(String).join("|"));
}

function snapshotDatabase(path: string): DurableSnapshot {
  return withDatabase(path, (database) => ({
    events: column(database, "SELECT event_id FROM domain_events ORDER BY global_position"),
    inbox: column(database,
      "SELECT consumer_id, message_id, receipt_digest FROM inbox_receipts ORDER BY message_id"),
    outbox: column(database, "SELECT message_id FROM outbox_messages ORDER BY outbox_position"),
    projection: column(database, `SELECT last_applied_position, state_digest FROM projections
      WHERE projection_name = '${PROJECTION}'`).at(0) ?? null,
  }));
}

/** A scoped RAISE(ABORT) on one table, installed from a second connection after the store
 *  bootstrapped the schema, then dropped so nothing leaks into a reopen. */
function withWriteFault(path: string, table: string, run: () => void): void {
  withDatabase(path, (database) => {
    database.exec(`CREATE TRIGGER relay_fault BEFORE INSERT ON ${table}
       BEGIN SELECT RAISE(ABORT, 'fault:${table}'); END`);
    try { run(); } finally { database.exec("DROP TRIGGER relay_fault"); }
  });
}

function wrongOutcome(expected: string, result: OutboxRelayResult): Error {
  return new Error(`expected ${expected}, got ${JSON.stringify(result)}`);
}
function applied(result: OutboxRelayResult): OutboxRelayApplied {
  if (result.outcome !== "APPLIED") { throw wrongOutcome("APPLIED", result); }
  return result;
}
function deduplicated(result: OutboxRelayResult): OutboxRelayDeduplicated {
  if (result.outcome !== "ALREADY_APPLIED") { throw wrongOutcome("ALREADY_APPLIED", result); }
  return result;
}
function refused(result: OutboxRelayResult): OutboxRelayRefused {
  if (result.outcome !== "REFUSED") { throw wrongOutcome("REFUSED", result); }
  return result;
}
function captureThrow(run: () => void): DurableStoreError {
  try { run(); } catch (error) { return error as DurableStoreError; }
  throw new Error("expected the relay to throw");
}

/** Delivers evt-1/msg-1 at version 0, leaving the projection at position 1. */
function seed(store: SqliteEventStore, state: ProjectionState = ORIGIN_STATE): OutboxRelayApplied {
  return applied(relayMessage(store, ask(delivery("1"), 0, { state })));
}

describe("transactional outbox relay", () => {
  it("commits event, outbox, projection, and inbox receipt as one transaction", () => {
    withStore((open, path) => {
      const calls: string[] = [];
      const success = applied(
        usingStore(open, (store) => relayMessage(store, ask(delivery("1"), 0, { calls }))),
      );
      expect(Object.isFrozen(success)).toBe(true);
      expect(success.commit.disposition).toBe("COMMITTED");
      expect(success.commit.eventIds).toEqual(["evt-1"]);
      expect(success.commit.outboxMessageIds).toEqual(["msg-1"]);
      expect(success.checkpoint).toEqual({ globalPosition: 1n });
      expect(success.state).toEqual({ count: 1, last: "evt-1" });
      expect(success.stateDigest).toMatch(SHA256);
      expect(calls).toEqual(["evt-1"]);

      const durable = snapshotDatabase(path);
      expect(durable.events).toEqual(["evt-1"]);
      expect(durable.outbox).toEqual(["msg-1"]);
      expect(durable.projection).toBe(`1|${success.stateDigest}`);
      const [consumerId, messageId, digest] = (durable.inbox[0] ?? "").split("|");
      expect([durable.inbox.length, consumerId, messageId]).toEqual([1, CONSUMER, "inbound-1"]);
      expect(digest).toMatch(SHA256);
    });
  });

  const rich = (mark: number): ProjectionState =>
    Object.freeze({ at: 5n, count: 0, last: "", mark, tags: Object.freeze(["a"]) });

  it("persists a state digest stable for equal state and different for changed state", () => {
    const digests = [
      ORIGIN_STATE, ORIGIN_STATE, Object.freeze({ count: 7, last: "" }), rich(0), rich(-0),
      Object.freeze({ alpha: 1, beta: 2, count: 0, last: "" }),
      Object.freeze({ beta: 2, alpha: 1, last: "", count: 0 }),
    ].map((start) => {
      let digest = "";
      withStore((open) => {
        digest = usingStore(open, (store) => seed(store, start)).stateDigest;
      });
      return digest;
    });
    expect(digests.every((digest) => SHA256.test(digest))).toBe(true);
    expect(digests[0]).toBe(digests[1]);
    expect(digests[0]).not.toBe(digests[2]);
    // -0 and 0 are `==` and share a String() form; the digest must still separate them.
    expect(digests[3]).not.toBe(digests[4]);
    // Same content, different key insertion order: canonicalization must erase the order.
    expect(digests[5]).toBe(digests[6]);
  });

  const FAULTS = [
    { code: "STORE_UNAVAILABLE", label: "domain_events", layer: "COMMIT", refuses: false },
    { code: "STORE_UNAVAILABLE", label: "outbox_messages", layer: "COMMIT", refuses: false },
    { code: "OUTBOX_RELAY_PROJECTION_WRITE_FAILED", label: "projections",
      layer: "PROJECTION", refuses: true },
    { code: "OUTBOX_RELAY_INBOX_WRITE_FAILED", label: "inbox_receipts",
      layer: "INBOX", refuses: true },
  ] as const;

  it("covers every durable write boundary in the fault matrix", () => {
    expect(FAULTS.map((fault) => fault.label)).toEqual([
      "domain_events", "outbox_messages", "projections", "inbox_receipts",
    ]);
  });

  for (const fault of FAULTS) {
    it(`leaves none of the three effects when ${fault.label} aborts`, () => {
      withStore((open, path) => {
        const calls: string[] = [];
        usingStore(open, (store) => {
          withWriteFault(path, fault.label, () => {
            const request = ask(delivery("1"), 0, { calls });
            if (!fault.refuses) {
              expect(captureThrow(() => relayMessage(store, request)).code).toBe(fault.code);
              return;
            }
            const refusal = refused(relayMessage(store, request));
            expect(Object.isFrozen(refusal)).toBe(true);
            expect([refusal.code, refusal.layer]).toEqual([fault.code, fault.layer]);
          });
        });
        expect(snapshotDatabase(path)).toEqual(EMPTY);
      });
    });
  }

  it("rolls the whole commit back and names the upcast layer when the fold refuses", () => {
    withStore((open, path) => {
      const calls: string[] = [];
      const refusal = refused(usingStore(open, (store) => relayMessage(
        store, ask(delivery("1"), 0, { calls, upcaster: UNREACHABLE_UPCASTER }),
      )));
      expect(refusal.code).toBe("OUTBOX_RELAY_PROJECTION_REFUSED");
      expect(refusal.layer).toBe("PROJECTION");
      expect(refusal.fold?.code).toBe("PROJECTION_FOLD_UPCAST_REFUSED");
      expect(refusal.fold?.layer).toBe("UPCAST");
      expect(refusal.fold?.eventId).toBe("evt-1");
      expect(refusal.fold?.upcast?.code).toBe("SCHEMA_VERSION_UNSUPPORTED");
      expect(calls).toEqual([]);
      expect(snapshotDatabase(path)).toEqual(EMPTY);
    });
  });

  it("names the reducer layer and keeps its own code when no reducer is registered", () => {
    withStore((open, path) => {
      const refusal = refused(usingStore(open, (store) => relayMessage(
        store, ask(delivery("1"), 0, { reducers: {} }),
      )));
      expect(refusal.code).toBe("OUTBOX_RELAY_PROJECTION_REFUSED");
      expect(refusal.layer).toBe("PROJECTION");
      expect(refusal.fold?.code).toBe("PROJECTION_FOLD_REDUCER_MISSING");
      expect(refusal.fold?.layer).toBe("REDUCER");
      expect(refusal.fold?.upcast).toBeNull();
      expect(snapshotDatabase(path)).toEqual(EMPTY);
    });
  });

  it("deduplicates a redelivered envelope through the inbox without reapplying it", () => {
    withStore((open, path) => {
      const calls: string[] = [];
      let before: DurableSnapshot = EMPTY;
      const duplicate = deduplicated(usingStore(open, (store) => {
        seed(store);
        before = snapshotDatabase(path);
        return relayMessage(store, ask(delivery("2"), 1, { calls }));
      }));
      expect(Object.isFrozen(duplicate)).toBe(true);
      expect(duplicate.deduplicatedBy).toBe("INBOX");
      expect(duplicate.commit).toBeNull();
      expect(calls).toEqual([]);
      expect(snapshotDatabase(path)).toEqual(before);
    });
  });

  it("refuses the same consumer and message identity when the envelope bytes changed", () => {
    withStore((open, path) => {
      const calls: string[] = [];
      let before: DurableSnapshot = EMPTY;
      const refusal = refused(usingStore(open, (store) => {
        seed(store);
        before = snapshotDatabase(path);
        // One character moved from topic into payload: an unframed concatenation of the
        // envelope would hash identically and mistake this for a redelivery.
        return relayMessage(store, ask(delivery("2"), 1, {
          calls,
          message: { ...INBOUND, payload: bytes("dinbound-payload-1"), topic: "goal.inboun" },
        }));
      }));
      expect([refusal.code, refusal.layer]).toEqual(["OUTBOX_RELAY_INBOX_CONFLICT", "INBOX"]);
      expect(calls).toEqual([]);
      expect(snapshotDatabase(path)).toEqual(before);
    });
  });

  it("keeps the inbox dedupe after the database is closed and reopened", () => {
    withStore((open, path) => {
      usingStore(open, (store) => seed(store));
      const before = snapshotDatabase(path);
      const calls: string[] = [];
      const duplicate = deduplicated(usingStore(open, (store) => relayMessage(
        store, ask(delivery("3"), 1, { calls }),
      )));
      expect(duplicate.deduplicatedBy).toBe("INBOX");
      expect(calls).toEqual([]);
      expect(snapshotDatabase(path)).toEqual(before);
    });
  });

  it("labels a replayed command receipt separately from an inbox duplicate", () => {
    withStore((open) => {
      const calls: string[] = [];
      const duplicate = deduplicated(usingStore(open, (store) => {
        seed(store);
        return relayMessage(store, ask(delivery("1"), 0, { calls }));
      }));
      expect(duplicate.deduplicatedBy).toBe("COMMAND_RECEIPT");
      expect(duplicate.commit?.disposition).toBe("REPLAYED");
      expect(calls).toEqual([]);
    });
  });

  const STALE = [
    { checkpoint: 0n, label: "checkpoint", state: ORIGIN_STATE },
    { checkpoint: 1n, label: "state digest", state: Object.freeze({ count: 99, last: "evt-1" }) },
  ] as const;

  it("covers both halves of the projection compare-and-set", () => {
    expect(STALE.map((stale) => stale.label)).toEqual(["checkpoint", "state digest"]);
  });

  for (const stale of STALE) {
    it(`refuses and rolls back when the supplied ${stale.label} is stale`, () => {
      withStore((open, path) => {
        const calls: string[] = [];
        let before: DurableSnapshot = EMPTY;
        const refusal = refused(usingStore(open, (store) => {
          seed(store);
          before = snapshotDatabase(path);
          return relayMessage(store, ask(delivery("2"), 1, {
            calls, checkpoint: stale.checkpoint,
            message: { ...INBOUND, messageId: "inbound-2" }, state: stale.state,
          }));
        }));
        expect([refusal.code, refusal.layer])
          .toEqual(["OUTBOX_RELAY_PROJECTION_CONFLICT", "PROJECTION"]);
        expect(calls).toEqual([]);
        expect(snapshotDatabase(path)).toEqual(before);
      });
    });
  }

  type Corrupt = readonly [string, (request: OutboxRelayRequest) => OutboxRelayRequest];
  const INVALID: readonly Corrupt[] = [
    ["blank consumer", (request) => ({ ...request, consumerId: "" })],
    ["accessor message", (request) => ({ ...request,
      message: Object.defineProperty({ ...INBOUND }, "payload", { get: () => bytes("x") }) })],
    ["non-plain state", (request) => ({ ...request,
      projection: { ...request.projection,
        state: { at: () => 1 } as unknown as ProjectionState } })],
  ];

  it("refuses unusable input at the INPUT layer without persisting anything", () => {
    expect(INVALID.map(([label]) => label)).toEqual([
      "blank consumer", "accessor message", "non-plain state",
    ]);
    withStore((open, path) => {
      usingStore(open, (store) => {
        for (const [label, corrupt] of INVALID) {
          const refusal = refused(relayMessage(store, corrupt(ask(delivery("1"), 0))));
          expect([label, refusal.code, refusal.layer]).toEqual([
            label, "OUTBOX_RELAY_INPUT_INVALID", "INPUT",
          ]);
        }
      });
      expect(snapshotDatabase(path)).toEqual(EMPTY);
    });
  });
});
