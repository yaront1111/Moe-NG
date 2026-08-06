import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import * as storeModule from "./index.js";
import { bytes, text } from "./sqlite-event-store-test-helpers.js";
import { RECEIPT_OUTBOX_QUERY } from "./sqlite-event-store.js";

describe("SqliteEventStore core", () => {
  it("exposes the durable store entry point", () => {
    expect(storeModule).toHaveProperty("SqliteEventStore");
  });

  it("opens SQLite with the required safety configuration", () => {
    expect(typeof storeModule.SqliteEventStore.open).toBe("function");
    expect(typeof storeModule.SqliteEventStore.openEphemeralForTest).toBe("function");
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      const health = store.getHealth();
      expect(health.foreignKeys).toBe(true);
      expect(health.journalMode).toBe("memory");
      expect(health.quickCheck).toBe("ok");
      expect(health.userVersion).toBe(2);
      expect(Number.parseFloat(health.sqliteVersion)).toBeGreaterThanOrEqual(3.51);
      expect(health).toMatchObject({
        applicationId: storeModule.SQLITE_APPLICATION_ID,
        busyTimeoutMilliseconds: 5_000,
        durability: "EPHEMERAL_TEST",
        foreignKeyViolations: 0,
        recursiveTriggers: false,
        synchronous: "full",
        trustedSchema: false,
        walAutocheckpointPages: 1_000,
      });
    } finally {
      store.close();
    }
  });

  it("keeps ephemeral and ambiguous paths out of the production opener", () => {
    expect(() => storeModule.SqliteEventStore.open("")).toThrowError(/STORE_INPUT_INVALID/);
    expect(() => storeModule.SqliteEventStore.open(":memory:")).toThrowError(
      /STORE_INPUT_INVALID/,
    );
    expect(() => storeModule.SqliteEventStore.open("relative.sqlite")).toThrowError(
      /STORE_INPUT_INVALID/,
    );
    expect(() => storeModule.SqliteEventStore.open("file:events.sqlite")).toThrowError(
      /STORE_INPUT_INVALID/,
    );
  });

  it("refuses an unrelated database without mutating or adopting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-identity-"));
    const databasePath = join(directory, "unrelated.sqlite");
    try {
      const unrelated = new DatabaseSync(databasePath);
      unrelated.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep');");
      unrelated.close();

      expect(() => {
        const wronglyAdopted = storeModule.SqliteEventStore.open(databasePath);
        wronglyAdopted.close();
      }).toThrowError(/DATABASE_IDENTITY_MISMATCH/);

      const verification = new DatabaseSync(databasePath);
      try {
        expect(verification.prepare("PRAGMA application_id").get()).toEqual({
          application_id: 0,
        });
        expect(verification.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 0,
        });
        expect(verification.prepare("PRAGMA journal_mode").get()).toEqual({
          journal_mode: "delete",
        });
        expect(verification.prepare("SELECT value FROM unrelated").get()).toEqual({
          value: "keep",
        });
        expect(
          verification
            .prepare("SELECT count(*) AS value FROM sqlite_schema WHERE name LIKE 'aggregate_heads'")
            .get(),
        ).toEqual({ value: 0 });
      } finally {
        verification.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses matching identity metadata when the application schema is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-schema-"));
    const databasePath = join(directory, "forged.sqlite");
    try {
      const forged = new DatabaseSync(databasePath);
      forged.exec(`
        PRAGMA application_id = ${storeModule.SQLITE_APPLICATION_ID};
        PRAGMA user_version = 1;
      `);
      forged.close();

      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
        wronglyOpened.close();
      }).toThrowError(/STORE_SCHEMA_INVALID/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses a known database whose versioned schema was altered", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-altered-schema-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const initialized = storeModule.SqliteEventStore.open(databasePath);
      initialized.close();
      const alteration = new DatabaseSync(databasePath);
      alteration.exec("DROP INDEX outbox_pending_order");
      alteration.close();

      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
        wronglyOpened.close();
      }).toThrowError(/STORE_SCHEMA_INVALID/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("treats quoted schema literals as case-sensitive manifest bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-schema-literal-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const initialized = storeModule.SqliteEventStore.open(databasePath);
      initialized.close();
      const alteration = new DatabaseSync(databasePath);
      try {
        alteration.enableDefensive(false);
        alteration.exec("PRAGMA writable_schema = ON");
        const versionRow = alteration.prepare("PRAGMA schema_version").get() as {
          readonly schema_version: number;
        };
        alteration
          .prepare(`
            UPDATE sqlite_schema
            SET sql = replace(sql, '*[^0-9a-f]*', '*[^0-9A-F]*')
            WHERE name = 'command_receipts'
          `)
          .run();
        alteration.exec(`PRAGMA schema_version = ${versionRow.schema_version + 1}`);
        alteration.exec("PRAGMA writable_schema = OFF");
      } finally {
        alteration.close();
      }

      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
        wronglyOpened.close();
      }).toThrowError(/STORE_SCHEMA_INVALID/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps receipt outbox reconstruction on the event-order index", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-query-plan-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const initialized = storeModule.SqliteEventStore.open(databasePath);
      initialized.close();

      const inspection = new DatabaseSync(databasePath);
      try {
        const details = inspection
          .prepare(`EXPLAIN QUERY PLAN ${RECEIPT_OUTBOX_QUERY}`)
          .all("cmd-1")
          .map((row) => String(row.detail));
        const plan = details.join("\n");
        expect(plan).toMatch(/SEARCH events USING INDEX .*\(command_id=\?\)/u);
        expect(plan).toContain("outbox_event_order");
        expect(plan).not.toContain("SCAN ");
        expect(plan).not.toContain("USE TEMP B-TREE");
      } finally {
        inspection.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("atomically commits ordered events, aggregate version, receipt, and outbox", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      const result = store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes('{"goal":"ship"}'),
        commandId: "cmd-1",
        committedAt: "2026-08-06T10:00:00.000Z",
        events: [
          {
            eventId: "evt-1",
            eventType: "goal.created",
            metadata: bytes("meta-1"),
            outbox: [
              {
                headers: bytes("headers-1"),
                messageId: "msg-1",
                payload: bytes("wire-1"),
                topic: "goal.events",
              },
            ],
            payload: bytes("payload-1"),
          },
          {
            eventId: "evt-2",
            eventType: "goal.execution-enabled",
            outbox: [
              {
                messageId: "msg-2",
                payload: bytes("wire-2"),
                topic: "goal.events",
              },
            ],
            payload: bytes("payload-2"),
          },
        ],
        expectedVersion: 0,
      });

      expect(result).toEqual({
        aggregateId: "goal-1",
        commandId: "cmd-1",
        currentVersion: 2,
        disposition: "COMMITTED",
        effectIdentityVersion: storeModule.COMMAND_EFFECT_IDENTITY_VERSION,
        effectSha256: "ca84334e0a4f62efddbcd32532cdf7743863caf3eb0a1e8ed9332a1ebecbc7ee",
        eventIds: ["evt-1", "evt-2"],
        outboxMessageIds: ["msg-1", "msg-2"],
        previousVersion: 0,
        requestSha256: "27e8f0c686072b9c1262307a7ce9595a8036c5e6cab7444f5f8427c43c7fa8ce",
      });
      expect(store.getAggregateVersion("goal-1")).toBe(2);
      expect(
        store.readEvents("goal-1").map((event) => ({
          ...event,
          metadata: text(event.metadata),
          payload: text(event.payload),
        })),
      ).toEqual([
        {
          aggregateId: "goal-1",
          aggregateSequence: 1,
          commandId: "cmd-1",
          committedAt: "2026-08-06T10:00:00.000Z",
          eventId: "evt-1",
          eventType: "goal.created",
          globalPosition: 1n,
          metadata: "meta-1",
          payload: "payload-1",
          payloadCodecVersion: storeModule.OPAQUE_PAYLOAD_CODEC_VERSION,
          recordVersion: storeModule.EVENT_RECORD_VERSION,
          requestSha256: result.requestSha256,
        },
        {
          aggregateId: "goal-1",
          aggregateSequence: 2,
          commandId: "cmd-1",
          committedAt: "2026-08-06T10:00:00.000Z",
          eventId: "evt-2",
          eventType: "goal.execution-enabled",
          globalPosition: 2n,
          metadata: "",
          payload: "payload-2",
          payloadCodecVersion: storeModule.OPAQUE_PAYLOAD_CODEC_VERSION,
          recordVersion: storeModule.EVENT_RECORD_VERSION,
          requestSha256: result.requestSha256,
        },
      ]);
      expect(
        store.readPendingOutbox().map((message) => ({
          ...message,
          headers: text(message.headers),
          payload: text(message.payload),
        })),
      ).toEqual([
        {
          createdAt: "2026-08-06T10:00:00.000Z",
          deliveryAttempts: 0,
          eventId: "evt-1",
          headers: "headers-1",
          messageId: "msg-1",
          outboxPosition: 1n,
          payload: "wire-1",
          topic: "goal.events",
        },
        {
          createdAt: "2026-08-06T10:00:00.000Z",
          deliveryAttempts: 0,
          eventId: "evt-2",
          headers: "",
          messageId: "msg-2",
          outboxPosition: 2n,
          payload: "wire-2",
          topic: "goal.events",
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("replays an identical command without rerunning proposed effects and fences ID reuse", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      const first = store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("create-goal"),
        commandId: "cmd-1",
        committedAt: "2026-08-06T10:00:00.000Z",
        events: [
          {
            eventId: "evt-original",
            eventType: "goal.created",
            outbox: [
              {
                messageId: "msg-original",
                payload: bytes("original-wire"),
                topic: "goal.events",
              },
            ],
            payload: bytes("original-payload"),
          },
        ],
        expectedVersion: 0,
      });

      const replay = store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("create-goal"),
        commandId: "cmd-1",
        committedAt: "2026-08-06T10:01:00.000Z",
        events: [
          {
            eventId: "evt-must-not-run",
            eventType: "goal.created-again",
            payload: bytes("must-not-run"),
          },
        ],
        expectedVersion: 0,
      });

      expect(first.disposition).toBe("COMMITTED");
      expect(replay).toEqual({ ...first, disposition: "REPLAYED" });
      expect(store.getAggregateVersion("goal-1")).toBe(1);
      expect(store.readEvents("goal-1").map((event) => event.eventId)).toEqual([
        "evt-original",
      ]);
      expect(store.readPendingOutbox().map((message) => message.messageId)).toEqual([
        "msg-original",
      ]);

      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("different-command"),
          commandId: "cmd-1",
          committedAt: "2026-08-06T10:02:00.000Z",
          events: [
            {
              eventId: "evt-conflict",
              eventType: "goal.changed",
              payload: bytes("conflict"),
            },
          ],
          expectedVersion: 1,
        }),
      ).toThrowError(storeModule.CommandIdConflictError);
      expect(store.getAggregateVersion("goal-1")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("exposes the durable command receipt used for replay decisions", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      expect(store.getCommandReceipt("cmd-1")).toBeNull();
      const committed = store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("create"),
        commandId: "cmd-1",
        committedAt: "2026-08-06T10:00:00.000Z",
        events: [
          {
            eventId: "evt-1",
            eventType: "goal.created",
            payload: bytes("payload"),
          },
        ],
        expectedVersion: 0,
      });
      expect(store.getCommandReceipt("cmd-1")).toEqual({
        aggregateId: "goal-1",
        commandId: "cmd-1",
        committedAt: "2026-08-06T10:00:00.000Z",
        currentVersion: 1,
        effectIdentityVersion: storeModule.COMMAND_EFFECT_IDENTITY_VERSION,
        effectSha256: "c53de1778471023c822f8ebc6ba84a2f3a0e4aaa95b8861d1ea52dd5ea95fd2b",
        eventIds: ["evt-1"],
        outboxMessageIds: [],
        previousVersion: 0,
        requestSha256: committed.requestSha256,
      });
    } finally {
      store.close();
    }
  });

  it("fails closed when a receipt no longer matches its durable effects", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-corrupt-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "moe-test-project",
      );
      store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("create"),
        commandId: "cmd-1",
        committedAt: "2026-08-06T10:00:00.000Z",
        events: [
          {
            eventId: "evt-1",
            eventType: "goal.created",
            outbox: [
              {
                messageId: "msg-1",
                payload: bytes("wire"),
                topic: "goal.events",
              },
            ],
            payload: bytes("payload"),
          },
        ],
        expectedVersion: 0,
      });
      store.close();

      const tamper = new DatabaseSync(databasePath);
      tamper.exec(`
        PRAGMA foreign_keys = OFF;
        DELETE FROM outbox_messages;
        DELETE FROM domain_events;
        UPDATE aggregate_heads SET version = 0 WHERE aggregate_id = 'goal-1';
      `);
      tamper.close();

      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
        wronglyOpened.close();
      }).toThrowError(/STORE_CORRUPT/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("detects payload tampering and aggregate-head gaps at startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-semantic-corrupt-"));
    try {
      for (const corruption of ["payload", "head"] as const) {
        const databasePath = join(directory, `${corruption}.sqlite`);
        const store = storeModule.SqliteEventStore.openForProject(
          databasePath,
          "moe-test-project",
        );
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("create"),
          commandId: "cmd-1",
          committedAt: "2026-08-06T10:00:00.000Z",
          events: [
            {
              eventId: "evt-1",
              eventType: "goal.created",
              payload: bytes("original"),
            },
          ],
          expectedVersion: 0,
        });
        store.close();

        const tamper = new DatabaseSync(databasePath);
        if (corruption === "payload") {
          tamper.prepare("UPDATE domain_events SET payload = ? WHERE event_id = ?").run(
            bytes("changed"),
            "evt-1",
          );
        } else {
          tamper.prepare("UPDATE aggregate_heads SET version = 99 WHERE aggregate_id = ?").run(
            "goal-1",
          );
        }
        tamper.close();

        expect(() => {
          const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
          wronglyOpened.close();
        }).toThrowError(/STORE_CORRUPT/);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("detects immutable event and outbox position reordering at startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-position-corrupt-"));
    try {
      for (const corruption of ["event-position", "outbox-position"] as const) {
        const databasePath = join(directory, `${corruption}.sqlite`);
        const store = storeModule.SqliteEventStore.openForProject(
          databasePath,
          "moe-test-project",
        );
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("create"),
          commandId: "cmd-1",
          committedAt: "2026-08-06T10:00:00.000Z",
          events: [
            {
              eventId: "evt-1",
              eventType: "goal.created",
              outbox: [
                {
                  messageId: "msg-1",
                  payload: bytes("wire-1"),
                  topic: "goal.events",
                },
              ],
              payload: bytes("payload-1"),
            },
            {
              eventId: "evt-2",
              eventType: "goal.changed",
              outbox: [
                {
                  messageId: "msg-2",
                  payload: bytes("wire-2"),
                  topic: "goal.events",
                },
              ],
              payload: bytes("payload-2"),
            },
          ],
          expectedVersion: 0,
        });
        store.close();

        const tamper = new DatabaseSync(databasePath);
        try {
          if (corruption === "event-position") {
            tamper.exec(`
              UPDATE domain_events SET global_position = 1001 WHERE event_id = 'evt-1';
              UPDATE domain_events SET global_position = 1 WHERE event_id = 'evt-2';
              UPDATE domain_events SET global_position = 2 WHERE event_id = 'evt-1';
            `);
          } else {
            tamper.exec(`
              UPDATE outbox_messages SET outbox_position = 1001 WHERE message_id = 'msg-1';
              UPDATE outbox_messages SET outbox_position = 1 WHERE message_id = 'msg-2';
              UPDATE outbox_messages SET outbox_position = 2 WHERE message_id = 'msg-1';
            `);
          }
        } finally {
          tamper.close();
        }

        expect(() => {
          const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
          wronglyOpened.close();
        }).toThrowError(/STORE_CORRUPT/);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects ill-formed Unicode identifiers before SQLite can alias them", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("create"),
          commandId: "cmd-\uD800",
          committedAt: "2026-08-06T10:00:00.000Z",
          events: [
            {
              eventId: "evt-1",
              eventType: "goal.created",
              payload: bytes("payload"),
            },
          ],
          expectedVersion: 0,
        }),
      ).toThrowError(/STORE_INPUT_INVALID/);
      expect(store.getAggregateVersion("goal-1")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("normalizes hostile containers and detached bytes to stable input errors", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      const sparseEvents = new Array(1) as unknown as readonly {
        readonly eventId: string;
        readonly eventType: string;
        readonly payload: Uint8Array;
      }[];
      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("sparse"),
          commandId: "cmd-sparse",
          committedAt: "2026-08-06T10:00:00.000Z",
          events: sparseEvents,
          expectedVersion: 0,
        }),
      ).toThrowError(/STORE_INPUT_INVALID/);

      const detached = bytes("detached");
      structuredClone(detached, { transfer: [detached.buffer as ArrayBuffer] });
      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: detached,
          commandId: "cmd-detached",
          committedAt: "2026-08-06T10:00:00.000Z",
          events: [
            {
              eventId: "evt-detached",
              eventType: "goal.created",
              payload: bytes("payload"),
            },
          ],
          expectedVersion: 0,
        }),
      ).toThrowError(/STORE_INPUT_INVALID/);

      const accessorInput = {
        aggregateId: "goal-1",
        commandBytes: bytes("accessor"),
        commandId: "cmd-accessor",
        committedAt: "2026-08-06T10:00:00.000Z",
        expectedVersion: 0,
        get events(): never {
          throw new Error("caller accessor executed");
        },
      };
      expect(() => store.commit(accessorInput)).toThrowError(/STORE_INPUT_INVALID/);
    } finally {
      store.close();
    }
  });

  it("closes idempotently and returns a stable error after close", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => store.getAggregateVersion("goal-1")).toThrowError(/STORE_CLOSED/);
  });
});
