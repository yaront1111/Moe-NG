import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import {
  COMMAND_EFFECT_IDENTITY_VERSION,
  DurableStoreError,
  EVENT_RECORD_VERSION,
  MAX_PAGE_DECODED_BYTES,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  SqliteEventStore,
} from "./index.js";
import type { CommitResult, DurableStoreErrorCode } from "./index.js";
import {
  EVENT_TYPE_PAGE_CANDIDATE_QUERY,
  EVENT_TYPE_PAGE_MATERIALIZE_QUERY,
} from "./event-read-query.js";

const AGGREGATE = "goal-contract";
const COMMAND_ID = "command-contract";
const COMMITTED_AT = "2026-08-07T09:00:00.000Z";
const INDEXES = [1, 2, 3] as const;
const INVALID: DurableStoreErrorCode = "STORE_INPUT_INVALID";
const EXCEEDED: DurableStoreErrorCode = "STORE_LIMIT_EXCEEDED";
const OVER_BYTES = MAX_PAGE_DECODED_BYTES + 1;
const BAD_LIMIT = "limit must be a positive safe integer";
const BIG_LIMIT = "limit cannot exceed 1000";
const BAD_BYTES = "maxDecodedBytes must be a positive safe integer";
const BIG_BYTES = `maxDecodedBytes cannot exceed ${MAX_PAGE_DECODED_BYTES}`;
const BAD_ID = "must be well-formed, non-empty, at most 512 UTF-8 bytes, and contain no NUL";
const BAD_SEQ = "afterAggregateSequence must be a non-negative safe integer";
const BAD_GLOBAL = "afterGlobalPosition must be a non-negative SQLite-range bigint";
const BAD_OUTBOX = "afterOutboxPosition must be a non-negative SQLite-range bigint";
const EVENT_TYPE_INDEX = "domain_events_event_type_position";

function seed(store: SqliteEventStore): CommitResult {
  return store.commit({
    aggregateId: AGGREGATE,
    commandBytes: new Uint8Array([7, 7]),
    commandId: COMMAND_ID,
    committedAt: COMMITTED_AT,
    events: INDEXES.map((index) => ({
      eventId: `event-contract-${index}`,
      eventType: `goal.contract-${index}`,
      metadata: new Uint8Array([index, index + 1]),
      outbox: [
        {
          headers: new Uint8Array([index, 8]),
          messageId: `message-contract-${index}`,
          payload: new Uint8Array([index, 9]),
          topic: `goal.topic-${index}`,
        },
      ],
      payload: new Uint8Array([index, index * 2]),
    })),
    expectedVersion: 0,
  });
}

function expectedEvent(index: number, requestSha256: string): unknown {
  return {
    aggregateId: AGGREGATE,
    aggregateSequence: index,
    commandId: COMMAND_ID,
    committedAt: COMMITTED_AT,
    domainSchemaVersion: "moe-domain-schema/0",
    eventId: `event-contract-${index}`,
    eventType: `goal.contract-${index}`,
    globalPosition: BigInt(index),
    metadata: new Uint8Array([index, index + 1]),
    payload: new Uint8Array([index, index * 2]),
    payloadCodecVersion: OPAQUE_PAYLOAD_CODEC_VERSION,
    recordVersion: EVENT_RECORD_VERSION,
    requestSha256,
  };
}

function expectedMessage(index: number): unknown {
  return {
    createdAt: COMMITTED_AT,
    deliveryAttempts: 0,
    eventId: `event-contract-${index}`,
    headers: new Uint8Array([index, 8]),
    messageId: `message-contract-${index}`,
    outboxPosition: BigInt(index),
    payload: new Uint8Array([index, 9]),
    topic: `goal.topic-${index}`,
  };
}

function expectDurableError(run: () => unknown, code: DurableStoreErrorCode, detail: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DurableStoreError);
    expect((error as DurableStoreError).code).toBe(code);
    expect((error as DurableStoreError).message).toBe(`${code}: ${detail}`);
    return;
  }
  throw new Error(`expected ${code}: ${detail}`);
}

function withStore(run: (store: SqliteEventStore, committed: CommitResult) => void): void {
  const store = SqliteEventStore.openEphemeralForProjectTest("project-contract");
  try {
    run(store, seed(store));
  } finally {
    store.close();
  }
}

it("reports the exact event horizon and observes a later append", () => {
  const empty = SqliteEventStore.openEphemeralForProjectTest("project-empty-horizon");
  try {
    expect(empty.readEventHorizon()).toBe(0n);
  } finally {
    empty.close();
  }
  expectDurableError(
    () => empty.readEventHorizon(),
    "STORE_CLOSED",
    "the SQLite event store is closed",
  );
  withStore((store) => {
    expect(INDEXES).toHaveLength(3);
    expect(INDEXES.length).toBeGreaterThan(0);
    expect(store.readEventHorizon()).toBe(3n);
    store.commit({
      aggregateId: AGGREGATE,
      commandBytes: new Uint8Array([8, 8]),
      commandId: "command-contract-append",
      committedAt: COMMITTED_AT,
      events: [{
        eventId: "event-contract-append",
        eventType: "goal.contract-appended",
        payload: new Uint8Array([8]),
      }],
      expectedVersion: 3,
    });
    expect(store.readEventHorizon()).toBe(4n);
  });
});

it("normalizes every event, outbox, receipt, and aggregate-version read", () => {
  withStore((store, committed) => {
    expect(committed.requestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(committed.effectSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(store.getAggregateVersion(AGGREGATE)).toBe(3);
    expect(store.getAggregateVersion("goal-absent")).toBe(0);
    expect(store.getCommandReceipt(COMMAND_ID)).toStrictEqual({
      aggregateId: AGGREGATE,
      commandId: COMMAND_ID,
      committedAt: COMMITTED_AT,
      currentVersion: 3,
      effectIdentityVersion: COMMAND_EFFECT_IDENTITY_VERSION,
      effectSha256: committed.effectSha256,
      eventIds: INDEXES.map((index) => `event-contract-${index}`),
      outboxMessageIds: INDEXES.map((index) => `message-contract-${index}`),
      previousVersion: 0,
      requestSha256: committed.requestSha256,
    });
    expect(store.getCommandReceipt("command-absent")).toBeNull();
    const events = INDEXES.map((index) => expectedEvent(index, committed.requestSha256));
    const messages = INDEXES.map((index) => expectedMessage(index));
    expect(store.readEvents(AGGREGATE)).toStrictEqual(events);
    expect(store.readAggregateEvents(AGGREGATE)).toStrictEqual({
      hasMore: false,
      items: events,
      nextCursor: 3,
    });
    expect(store.readEventsAfter(0n)).toStrictEqual({
      hasMore: false,
      items: events,
      nextCursor: 3n,
    });
    expect(store.readPendingOutbox()).toStrictEqual(messages);
    expect(store.readPendingOutboxPage(0n)).toStrictEqual({
      hasMore: false,
      items: messages,
      nextCursor: 3n,
    });
  });
});

it("advances number and bigint cursors and returns empty tail pages", () => {
  withStore((store, committed) => {
    const aggregatePage = store.readAggregateEvents(AGGREGATE, 0, 2);
    expect(aggregatePage.hasMore).toBe(true);
    expect(aggregatePage.nextCursor).toBe(2);
    const ids = aggregatePage.items.map((event) => event.eventId);
    expect(ids).toStrictEqual(["event-contract-1", "event-contract-2"]);
    expect(store.readAggregateEvents(AGGREGATE, aggregatePage.nextCursor!, 2)).toStrictEqual({
      hasMore: false,
      items: [expectedEvent(3, committed.requestSha256)],
      nextCursor: 3,
    });
    for (const page of [store.readEventsAfter(0n, 2), store.readPendingOutboxPage(0n, 2)]) {
      expect(page).toMatchObject({ hasMore: true, nextCursor: 2n });
    }
    const empty = { hasMore: false, items: [], nextCursor: null };
    expect(store.readAggregateEvents(AGGREGATE, 3, 10)).toStrictEqual(empty);
    expect(store.readEventsAfter(3n, 10)).toStrictEqual(empty);
    expect(store.readPendingOutboxPage(3n, 10)).toStrictEqual(empty);
  });
});

it("freezes envelopes while returning detached mutable record snapshots", () => {
  withStore((store, committed) => {
    const page = store.readAggregateEvents(AGGREGATE, 0, 10);
    const outboxPage = store.readPendingOutboxPage(0n, 10);
    const receipt = store.getCommandReceipt(COMMAND_ID)!;
    for (const frozen of [page, page.items, outboxPage, outboxPage.items, receipt,
      receipt.eventIds, receipt.outboxMessageIds, store.readEvents(AGGREGATE),
      store.readPendingOutbox()]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect(Object.isFrozen(page.items[0])).toBe(false);
    expect(Object.isFrozen(outboxPage.items[0])).toBe(false);
    page.items[0]!.payload[0] = 255;
    page.items[0]!.metadata[0] = 254;
    outboxPage.items[0]!.payload[0] = 253;
    outboxPage.items[0]!.headers[0] = 252;
    expect(store.readAggregateEvents(AGGREGATE, 0, 10).items[0]).toStrictEqual(
      expectedEvent(1, committed.requestSha256),
    );
    expect(store.readPendingOutboxPage(0n, 10).items[0]).toStrictEqual(
      expectedMessage(1),
    );
  });
});

it("serves both event-type page phases from the composite index", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-store-type-plan-"));
  try {
    const path = join(directory, "events.sqlite");
    SqliteEventStore.open(path).close();
    const database = new DatabaseSync(path);
    try {
      for (const query of [EVENT_TYPE_PAGE_CANDIDATE_QUERY, EVENT_TYPE_PAGE_MATERIALIZE_QUERY]) {
        const plan = database
          .prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all()
          .map((row) => String((row as { detail: unknown }).detail))
          .join("\n");
        expect(plan).toContain(`SEARCH events USING INDEX ${EVENT_TYPE_INDEX}`);
        expect(plan).toContain("event_type=?");
        expect(plan).not.toContain("SCAN ");
        expect(plan).not.toContain("USE TEMP B-TREE");
      }
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

type Read = (store: SqliteEventStore) => unknown;
type InvalidRead = readonly [string, Read, DurableStoreErrorCode, string];

const INVALID_READS: readonly InvalidRead[] = [
  ["aggregate version id", (s) => s.getAggregateVersion(""), INVALID, `aggregateId ${BAD_ID}`],
  ["receipt command id", (s) => s.getCommandReceipt(""), INVALID, `commandId ${BAD_ID}`],
  ["aggregate page id", (s) => s.readAggregateEvents(""), INVALID, `aggregateId ${BAD_ID}`],
  ["negative aggregate cursor", (s) => s.readAggregateEvents(AGGREGATE, -1, 0, 0), INVALID, BAD_SEQ],
  ["unsafe aggregate cursor",
    (s) => s.readAggregateEvents(AGGREGATE, Number.MAX_SAFE_INTEGER + 1), INVALID, BAD_SEQ],
  ["out-of-range global cursor",
    (s) => s.readEventsAfter(9_223_372_036_854_775_808n, 0, 0), INVALID, BAD_GLOBAL],
  ["negative outbox cursor", (s) => s.readPendingOutboxPage(-1n, 0, 0), INVALID, BAD_OUTBOX],
  ["zero aggregate limit", (s) => s.readAggregateEvents(AGGREGATE, 0, 0, 0), INVALID, BAD_LIMIT],
  ["zero global limit", (s) => s.readEventsAfter(0n, 0, 0), INVALID, BAD_LIMIT],
  ["zero outbox limit", (s) => s.readPendingOutboxPage(0n, 0, 0), INVALID, BAD_LIMIT],
  ["1001 aggregate limit", (s) => s.readAggregateEvents(AGGREGATE, 0, 1_001), EXCEEDED, BIG_LIMIT],
  ["1001 global limit", (s) => s.readEventsAfter(0n, 1_001), EXCEEDED, BIG_LIMIT],
  ["1001 outbox limit", (s) => s.readPendingOutboxPage(0n, 1_001), EXCEEDED, BIG_LIMIT],
  ["zero aggregate bytes", (s) => s.readAggregateEvents(AGGREGATE, 0, 10, 0), INVALID, BAD_BYTES],
  ["zero global bytes", (s) => s.readEventsAfter(0n, 10, 0), INVALID, BAD_BYTES],
  ["zero outbox bytes", (s) => s.readPendingOutboxPage(0n, 10, 0), INVALID, BAD_BYTES],
  ["oversized aggregate bytes", (s) => s.readAggregateEvents(AGGREGATE, 0, 10, OVER_BYTES),
    EXCEEDED, BIG_BYTES],
  ["oversized global bytes", (s) => s.readEventsAfter(0n, 10, OVER_BYTES), EXCEEDED, BIG_BYTES],
  ["oversized outbox bytes", (s) => s.readPendingOutboxPage(0n, 10, OVER_BYTES), EXCEEDED,
    BIG_BYTES],
];

for (const [name, run, code, detail] of INVALID_READS) {
  it(`fails closed for ${name}`, () => {
    withStore((store) => expectDurableError(() => run(store), code, detail));
  });
}

it("refuses unbounded reads that overflow a single bounded page", () => {
  withStore((store) => {
    const outboxDetail =
      "pending outbox exceeds a single bounded page; use readPendingOutboxPage with its cursor";
    expectDurableError(() => store.readPendingOutbox(2), EXCEEDED, outboxDetail);
    for (const batch of [0, 1, 2, 3]) {
      store.commit({
        aggregateId: "goal-wide",
        commandBytes: new Uint8Array([batch]),
        commandId: `command-wide-${batch}`,
        committedAt: COMMITTED_AT,
        events: Array.from({ length: 256 }, (_unused, index) => ({
          eventId: `event-wide-${batch}-${index}`,
          eventType: "goal.wide",
          payload: new Uint8Array([1]),
        })),
        expectedVersion: batch * 256,
      });
    }
    const aggregateDetail =
      "aggregate exceeds a single bounded page; use readAggregateEvents with its cursor";
    expectDurableError(() => store.readEvents("goal-wide"), EXCEEDED, aggregateDetail);
  });
});
