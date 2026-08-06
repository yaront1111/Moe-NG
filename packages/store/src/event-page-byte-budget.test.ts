import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { MAX_PAGE_DECODED_BYTES, SqliteEventStore } from "./index.js";
import {
  EVENT_DECODED_BYTES_SQL,
  STORED_EVENT_DECISION_JOIN,
} from "./read-page-queries.js";

function payload(byte: number): Uint8Array {
  return new Uint8Array(3_072).fill(byte);
}

function seedEventAndOutboxPages(store: SqliteEventStore): void {
  store.commit({
    aggregateId: "goal-page",
    commandBytes: new Uint8Array([1]),
    commandId: "command-page",
    committedAt: "2026-08-06T21:00:00.000Z",
    events: [1, 2, 3].map((index) => ({
      eventId: `event-page-${index}`,
      eventType: "goal.page-recorded",
      outbox: [
        {
          messageId: `message-page-${index}`,
          payload: payload(index + 10),
          topic: "goal.events",
        },
      ],
      payload: payload(index),
    })),
    expectedVersion: 0,
  });
}

it("walks aggregate, global-event, and outbox pages by byte prefix without gaps", () => {
  const store = SqliteEventStore.openEphemeralForProjectTest("project-page");
  try {
    seedEventAndOutboxPages(store);

    const aggregateIds: string[] = [];
    let aggregateCursor = 0;
    for (;;) {
      const page = store.readAggregateEvents("goal-page", aggregateCursor, 10, 4_096);
      expect(page.items).toHaveLength(1);
      aggregateIds.push(...page.items.map((event) => event.eventId));
      if (!page.hasMore) break;
      aggregateCursor = page.nextCursor!;
    }
    expect(aggregateIds).toEqual(["event-page-1", "event-page-2", "event-page-3"]);

    const globalIds: string[] = [];
    let globalCursor = 0n;
    for (;;) {
      const page = store.readEventsAfter(globalCursor, 10, 4_096);
      expect(page.items).toHaveLength(1);
      globalIds.push(...page.items.map((event) => event.eventId));
      if (!page.hasMore) break;
      globalCursor = page.nextCursor!;
    }
    expect(globalIds).toEqual(aggregateIds);

    const messageIds: string[] = [];
    let outboxCursor = 0n;
    for (;;) {
      const page = store.readPendingOutboxPage(outboxCursor, 10, 4_096);
      expect(page.items).toHaveLength(1);
      messageIds.push(...page.items.map((message) => message.messageId));
      if (!page.hasMore) break;
      outboxCursor = page.nextCursor!;
    }
    expect(messageIds).toEqual(["message-page-1", "message-page-2", "message-page-3"]);
  } finally {
    store.close();
  }
});

it("does not decode an excluded later event before its cursor is requested", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-page-budget-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    const store = SqliteEventStore.openForProject(databasePath, "project-page");
    try {
      seedEventAndOutboxPages(store);
      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec(`
          UPDATE domain_events
          SET record_version = 'future-event-record/999'
          WHERE event_id = 'event-page-2';
        `);
      } finally {
        tamper.close();
      }

      const first = store.readEventsAfter(0n, 10, 4_096);
      expect(first.items.map((event) => event.eventId)).toEqual(["event-page-1"]);
      expect(first.hasMore).toBe(true);
      expect(() => store.readEventsAfter(first.nextCursor!, 10, 4_096)).toThrowError(
        /STORE_CORRUPT.*record_version/u,
      );
      expect(store.readEventsAfter(0n, 10, 4_096).items[0]?.eventId).toBe(
        "event-page-1",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("includes the exact UTF-8 byte boundary and defers one byte over it", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-page-boundary-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    const store = SqliteEventStore.openForProject(databasePath, "project-page");
    try {
      store.commit({
        aggregateId: "goal-unicode",
        commandBytes: new Uint8Array([1]),
        commandId: "command-unicode",
        committedAt: "2026-08-06T21:10:00.000Z",
        events: [1, 2].map((index) => ({
          eventId: `event-unicode-${index}`,
          eventType: "évidence.recorded",
          payload: new Uint8Array(512).fill(index),
        })),
        expectedVersion: 0,
      });

      const probe = new DatabaseSync(databasePath);
      let decodedBytes: number[];
      try {
        const unicodeLength = probe
          .prepare(`
            SELECT
              length(event_type) AS characters,
              length(CAST(event_type AS BLOB)) AS utf8_bytes
            FROM domain_events
            WHERE event_id = 'event-unicode-1'
          `)
          .get();
        expect(Number(unicodeLength?.utf8_bytes)).toBeGreaterThan(
          Number(unicodeLength?.characters),
        );
        decodedBytes = probe
          .prepare(`
            SELECT ${EVENT_DECODED_BYTES_SQL} AS decoded_bytes
            FROM domain_events AS events
            ${STORED_EVENT_DECISION_JOIN}
            WHERE events.aggregate_id = 'goal-unicode'
            ORDER BY events.aggregate_sequence
          `)
          .all()
          .map((row) => Number(row.decoded_bytes));
      } finally {
        probe.close();
      }

      const exactBudget = decodedBytes[0]! + decodedBytes[1]!;
      expect(store.readAggregateEvents("goal-unicode", 0, 10, exactBudget).items).toHaveLength(
        2,
      );
      const oneByteShort = store.readAggregateEvents(
        "goal-unicode",
        0,
        10,
        exactBudget - 1,
      );
      expect(oneByteShort.items).toHaveLength(1);
      expect(oneByteShort.hasMore).toBe(true);
      expect(oneByteShort.nextCursor).toBe(1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("rejects a corrupt single event above the production byte ceiling in preflight", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-page-oversized-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    const store = SqliteEventStore.openForProject(databasePath, "project-page");
    try {
      store.commit({
        aggregateId: "goal-oversized",
        commandBytes: new Uint8Array([1]),
        commandId: "command-oversized",
        committedAt: "2026-08-06T21:11:00.000Z",
        events: [
          {
            eventId: "event-oversized",
            eventType: "goal.recorded",
            payload: new Uint8Array([1]),
          },
        ],
        expectedVersion: 0,
      });
      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("PRAGMA ignore_check_constraints = ON");
        tamper
          .prepare("UPDATE domain_events SET payload = zeroblob(?) WHERE event_id = ?")
          .run(MAX_PAGE_DECODED_BYTES + 1, "event-oversized");
      } finally {
        tamper.close();
      }

      expect(() => store.readEventsAfter(0n, 10)).toThrowError(
        /STORE_CORRUPT.*single-record ceiling/u,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
