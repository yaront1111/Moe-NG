import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import * as storeModule from "./index.js";
import { RECEIPT_OUTBOX_QUERY } from "./sqlite-event-store.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function text(value: Uint8Array): string {
  return textDecoder.decode(value);
}

interface RaceWorkerResult {
  readonly code?: string;
  readonly disposition?: string;
  readonly eventIds?: readonly string[];
}

function startRaceWorker(
  databasePath: string,
  gate: SharedArrayBuffer,
  suffix: string,
  sharedCommand = false,
): {
  readonly preOpenReady: Promise<void>;
  readonly ready: Promise<void>;
  readonly result: Promise<RaceWorkerResult>;
} {
  const worker = new Worker(new URL("./sqlite-event-store-race-worker.mjs", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: {
      commandBytes: sharedCommand ? "same-command" : `command-${suffix}`,
      commandId: sharedCommand ? "cmd-shared" : `cmd-${suffix}`,
      committedAt: "2026-08-06T10:00:00.000Z",
      databasePath,
      eventId: `evt-${suffix}`,
      gate,
    },
  });

  let resolvePreOpenReady!: () => void;
  let resolveReady!: () => void;
  let resolveResult!: (value: RaceWorkerResult) => void;
  let rejectBoth!: (error: Error) => void;
  const preOpenReady = new Promise<void>((resolve, reject) => {
    resolvePreOpenReady = resolve;
    rejectBoth = reject;
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    const previousReject = rejectBoth;
    rejectBoth = (error) => {
      previousReject(error);
      reject(error);
    };
  });
  const result = new Promise<RaceWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    const previousReject = rejectBoth;
    rejectBoth = (error) => {
      previousReject(error);
      reject(error);
    };
  });
  worker.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && "kind" in message) {
      if (message.kind === "READY") {
        resolveReady();
      } else if (message.kind === "PREOPEN_READY") {
        resolvePreOpenReady();
      } else if (message.kind === "RESULT") {
        resolveResult(message as RaceWorkerResult);
      }
    }
  });
  worker.on("error", (error) => rejectBoth(error));
  worker.on("exit", (code) => {
    if (code !== 0) {
      rejectBoth(new Error(`race worker exited with ${code}`));
    }
  });
  return { preOpenReady, ready, result };
}

describe("SqliteEventStore", () => {
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
      expect(health.userVersion).toBe(1);
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
      const store = storeModule.SqliteEventStore.open(databasePath);
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
        const store = storeModule.SqliteEventStore.open(databasePath);
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
        const store = storeModule.SqliteEventStore.open(databasePath);
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

  it("rejects stale versions and rolls back every row after a mid-transaction collision", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("first"),
        commandId: "cmd-first",
        committedAt: "2026-08-06T10:00:00.000Z",
        events: [
          {
            eventId: "evt-first",
            eventType: "goal.created",
            outbox: [
              {
                messageId: "msg-shared",
                payload: bytes("wire"),
                topic: "goal.events",
              },
            ],
            payload: bytes("first"),
          },
        ],
        expectedVersion: 0,
      });

      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("stale"),
          commandId: "cmd-stale",
          committedAt: "2026-08-06T10:01:00.000Z",
          events: [
            {
              eventId: "evt-stale",
              eventType: "goal.stale",
              payload: bytes("stale"),
            },
          ],
          expectedVersion: 0,
        }),
      ).toThrowError(storeModule.ExpectedVersionConflictError);

      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("event-id-conflict"),
          commandId: "cmd-event-conflict",
          committedAt: "2026-08-06T10:01:30.000Z",
          events: [
            {
              eventId: "evt-first",
              eventType: "goal.changed",
              payload: bytes("duplicate-event"),
            },
          ],
          expectedVersion: 1,
        }),
      ).toThrowError(storeModule.DurableIdConflictError);

      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("second"),
          commandId: "cmd-second",
          committedAt: "2026-08-06T10:02:00.000Z",
          events: [
            {
              eventId: "evt-rolled-back",
              eventType: "goal.changed",
              outbox: [
                {
                  messageId: "msg-shared",
                  payload: bytes("duplicate"),
                  topic: "goal.events",
                },
              ],
              payload: bytes("rolled-back"),
            },
          ],
          expectedVersion: 1,
        }),
      ).toThrowError(storeModule.DurableIdConflictError);

      expect(store.getAggregateVersion("goal-1")).toBe(1);
      expect(store.getCommandReceipt("cmd-event-conflict")).toBeNull();
      expect(store.getCommandReceipt("cmd-second")).toBeNull();
      expect(store.readEvents("goal-1").map((event) => event.eventId)).toEqual([
        "evt-first",
      ]);

      const retry = store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("second"),
        commandId: "cmd-second",
        committedAt: "2026-08-06T10:03:00.000Z",
        events: [
          {
            eventId: "evt-retry",
            eventType: "goal.changed",
            outbox: [
              {
                messageId: "msg-retry",
                payload: bytes("retry-wire"),
                topic: "goal.events",
              },
            ],
            payload: bytes("retry"),
          },
        ],
        expectedVersion: 1,
      });
      expect(retry.disposition).toBe("COMMITTED");
      expect(store.getAggregateVersion("goal-1")).toBe(2);
    } finally {
      store.close();
    }
  });

  it("rejects oversized commit batches before starting a transaction", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      const events = Array.from(
        { length: storeModule.MAX_EVENTS_PER_COMMIT + 1 },
        (_, index) => ({
          eventId: `evt-${index}`,
          eventType: "goal.changed",
          payload: new Uint8Array(),
        }),
      );
      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("oversized"),
          commandId: "cmd-oversized",
          committedAt: "2026-08-06T10:00:00.000Z",
          events,
          expectedVersion: 0,
        }),
      ).toThrowError(/STORE_LIMIT_EXCEEDED/);
      expect(store.getAggregateVersion("goal-1")).toBe(0);
      expect(store.getCommandReceipt("cmd-oversized")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("stops copying blobs at the first field that exceeds the commit byte budget", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      const fullBlob = new Uint8Array(storeModule.MAX_BLOB_BYTES);
      const neverInspect = new Proxy(
        {
          messageId: "msg-never-inspect",
          payload: bytes("must-not-be-read"),
          topic: "goal.events",
        },
        {
          ownKeys(): never {
            throw new Error("snapshot advanced past the first over-budget field");
          },
        },
      );
      expect(() =>
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("budgeted"),
          commandId: "cmd-budgeted",
          committedAt: "2026-08-06T10:00:00.000Z",
          events: [
            {
              eventId: "evt-budgeted",
              eventType: "goal.changed",
              outbox: [
                ...Array.from({ length: 4 }, (_, index) => ({
                  messageId: `msg-${index}`,
                  payload: fullBlob,
                  topic: "goal.events",
                })),
                neverInspect,
              ],
              payload: new Uint8Array(),
            },
          ],
          expectedVersion: 0,
        }),
      ).toThrowError(/STORE_LIMIT_EXCEEDED/);
      expect(store.getAggregateVersion("goal-1")).toBe(0);
      expect(store.getCommandReceipt("cmd-budgeted")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("returns isolated byte snapshots", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      const inputPayload = bytes("event-payload");
      const wirePayload = bytes("wire-payload");
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
                payload: wirePayload,
                topic: "goal.events",
              },
            ],
            payload: inputPayload,
          },
        ],
        expectedVersion: 0,
      });
      inputPayload.fill(0);
      wirePayload.fill(0);

      const eventRead = store.readEvents("goal-1")[0]!;
      const outboxRead = store.readPendingOutbox()[0]!;
      expect(text(eventRead.payload)).toBe("event-payload");
      expect(text(outboxRead.payload)).toBe("wire-payload");
      eventRead.payload.fill(0);
      outboxRead.payload.fill(0);
      expect(text(store.readEvents("goal-1")[0]!.payload)).toBe("event-payload");
      expect(text(store.readPendingOutbox()[0]!.payload)).toBe("wire-payload");
    } finally {
      store.close();
    }
  });

  it("preserves 64-bit event and outbox cursors beyond JavaScript safe numbers", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-cursor-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const seed = storeModule.SqliteEventStore.open(databasePath);
      seed.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("seed"),
        commandId: "cmd-seed",
        committedAt: "2026-08-06T10:00:00.000Z",
        events: [
          {
            eventId: "evt-seed",
            eventType: "goal.created",
            outbox: [
              {
                messageId: "msg-seed",
                payload: bytes("seed"),
                topic: "goal.events",
              },
            ],
            payload: bytes("seed"),
          },
        ],
        expectedVersion: 0,
      });
      seed.close();

      const sequenceSetup = new DatabaseSync(databasePath);
      sequenceSetup
        .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name IN (?, ?)")
        .run(Number.MAX_SAFE_INTEGER, "domain_events", "outbox_messages");
      sequenceSetup.close();

      const store = storeModule.SqliteEventStore.open(databasePath);
      try {
        store.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("large-cursor"),
          commandId: "cmd-large-cursor",
          committedAt: "2026-08-06T10:01:00.000Z",
          events: [
            {
              eventId: "evt-large-cursor",
              eventType: "goal.changed",
              outbox: [
                {
                  messageId: "msg-large-cursor",
                  payload: bytes("large"),
                  topic: "goal.events",
                },
              ],
              payload: bytes("large"),
            },
          ],
          expectedVersion: 1,
        });
        expect(store.readEvents("goal-1")[1]!.globalPosition).toBe(9_007_199_254_740_992n);
        expect(store.readPendingOutbox()[1]!.outboxPosition).toBe(
          9_007_199_254_740_992n,
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("pages aggregate, global-event, and pending-outbox reads without silent truncation", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    try {
      store.commit({
        aggregateId: "goal-a",
        commandBytes: bytes("goal-a"),
        commandId: "cmd-a",
        committedAt: "2026-08-06T10:00:00.000Z",
        events: [
          {
            eventId: "evt-a1",
            eventType: "goal.changed",
            outbox: Array.from({ length: 101 }, (_, index) => ({
              messageId: `msg-${index}`,
              payload: bytes(`wire-${index}`),
              topic: "goal.events",
            })),
            payload: bytes("a1"),
          },
          {
            eventId: "evt-a2",
            eventType: "goal.changed",
            payload: bytes("a2"),
          },
          {
            eventId: "evt-a3",
            eventType: "goal.changed",
            payload: bytes("a3"),
          },
        ],
        expectedVersion: 0,
      });
      store.commit({
        aggregateId: "goal-b",
        commandBytes: bytes("goal-b"),
        commandId: "cmd-b",
        committedAt: "2026-08-06T10:01:00.000Z",
        events: [
          {
            eventId: "evt-b1",
            eventType: "goal.created",
            payload: bytes("b1"),
          },
        ],
        expectedVersion: 0,
      });

      const aggregateFirst = store.readAggregateEvents("goal-a", 0, 2);
      expect(aggregateFirst).toMatchObject({ hasMore: true, nextCursor: 2 });
      expect(aggregateFirst.items.map((event) => event.eventId)).toEqual([
        "evt-a1",
        "evt-a2",
      ]);
      const aggregateSecond = store.readAggregateEvents(
        "goal-a",
        aggregateFirst.nextCursor!,
        2,
      );
      expect(aggregateSecond).toMatchObject({ hasMore: false, nextCursor: 3 });
      expect(aggregateSecond.items.map((event) => event.eventId)).toEqual(["evt-a3"]);

      const globalFirst = store.readEventsAfter(0n, 3);
      expect(globalFirst).toMatchObject({ hasMore: true, nextCursor: 3n });
      expect(globalFirst.items.map((event) => event.eventId)).toEqual([
        "evt-a1",
        "evt-a2",
        "evt-a3",
      ]);
      expect(
        store
          .readEventsAfter(globalFirst.nextCursor!, 3)
          .items.map((event) => event.eventId),
      ).toEqual(["evt-b1"]);

      expect(() => store.readPendingOutbox()).toThrowError(/STORE_LIMIT_EXCEEDED/);
      const outboxFirst = store.readPendingOutboxPage(0n, 100);
      expect(outboxFirst).toMatchObject({ hasMore: true, nextCursor: 100n });
      expect(outboxFirst.items).toHaveLength(100);
      const outboxSecond = store.readPendingOutboxPage(outboxFirst.nextCursor!, 100);
      expect(outboxSecond).toMatchObject({ hasMore: false, nextCursor: 101n });
      expect(outboxSecond.items.map((message) => message.messageId)).toEqual(["msg-100"]);
    } finally {
      store.close();
    }
  });

  it("persists across restart and serializes expected versions across connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const first = storeModule.SqliteEventStore.open(databasePath);
      try {
        expect(first.getHealth().journalMode).toBe("wal");
        first.commit({
          aggregateId: "goal-1",
          commandBytes: bytes("first"),
          commandId: "cmd-first",
          committedAt: "2026-08-06T10:00:00.000Z",
          events: [
            {
              eventId: "evt-first",
              eventType: "goal.created",
              payload: bytes("first"),
            },
          ],
          expectedVersion: 0,
        });

        const second = storeModule.SqliteEventStore.open(databasePath);
        try {
          expect(second.getAggregateVersion("goal-1")).toBe(1);
          expect(() =>
            second.commit({
              aggregateId: "goal-1",
              commandBytes: bytes("stale"),
              commandId: "cmd-stale",
              committedAt: "2026-08-06T10:01:00.000Z",
              events: [
                {
                  eventId: "evt-stale",
                  eventType: "goal.stale",
                  payload: bytes("stale"),
                },
              ],
              expectedVersion: 0,
            }),
          ).toThrowError(storeModule.ExpectedVersionConflictError);
          second.commit({
            aggregateId: "goal-1",
            commandBytes: bytes("second"),
            commandId: "cmd-second",
            committedAt: "2026-08-06T10:02:00.000Z",
            events: [
              {
                eventId: "evt-second",
                eventType: "goal.changed",
                payload: bytes("second"),
              },
            ],
            expectedVersion: 1,
          });
          expect(first.getAggregateVersion("goal-1")).toBe(2);
        } finally {
          second.close();
        }
      } finally {
        first.close();
      }

      const reopened = storeModule.SqliteEventStore.open(databasePath);
      try {
        expect(reopened.getAggregateVersion("goal-1")).toBe(2);
        expect(reopened.readEvents("goal-1").map((event) => event.eventId)).toEqual([
          "evt-first",
          "evt-second",
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it(
    "serializes simultaneous fresh startup, version races, and same-command retries",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "moe-store-race-"));
      try {
        const versionRacePath = join(directory, "version-race.sqlite");
        const versionGate = new SharedArrayBuffer(8);
        const versionWorkers = [
          startRaceWorker(versionRacePath, versionGate, "left"),
          startRaceWorker(versionRacePath, versionGate, "right"),
        ];
        await Promise.all(versionWorkers.map((worker) => worker.preOpenReady));
        Atomics.store(new Int32Array(versionGate), 0, 1);
        Atomics.notify(new Int32Array(versionGate), 0, 2);
        await Promise.all(versionWorkers.map((worker) => worker.ready));
        Atomics.store(new Int32Array(versionGate), 1, 1);
        Atomics.notify(new Int32Array(versionGate), 1, 2);
        const versionResults = await Promise.all(
          versionWorkers.map((worker) => worker.result),
        );
        expect(
          versionResults
            .map((result) => result.disposition ?? result.code)
            .sort(),
        ).toEqual(["COMMITTED", "EXPECTED_VERSION_CONFLICT"]);

        const retryRacePath = join(directory, "retry-race.sqlite");
        const retryGate = new SharedArrayBuffer(8);
        const retryWorkers = [
          startRaceWorker(retryRacePath, retryGate, "left", true),
          startRaceWorker(retryRacePath, retryGate, "right", true),
        ];
        await Promise.all(retryWorkers.map((worker) => worker.preOpenReady));
        Atomics.store(new Int32Array(retryGate), 0, 1);
        Atomics.notify(new Int32Array(retryGate), 0, 2);
        await Promise.all(retryWorkers.map((worker) => worker.ready));
        Atomics.store(new Int32Array(retryGate), 1, 1);
        Atomics.notify(new Int32Array(retryGate), 1, 2);
        const retryResults = await Promise.all(
          retryWorkers.map((worker) => worker.result),
        );
        expect(retryResults.map((result) => result.disposition).sort()).toEqual([
          "COMMITTED",
          "REPLAYED",
        ]);

        const verification = storeModule.SqliteEventStore.open(retryRacePath);
        try {
          expect(verification.getAggregateVersion("goal-race")).toBe(1);
          expect(verification.readEvents("goal-race")).toHaveLength(1);
        } finally {
          verification.close();
        }
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    15_000,
  );

  it("recovers a committed lost response after process exit without explicit close", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-store-process-"));
    const nestedDirectory = join(directory, "space ü");
    mkdirSync(nestedDirectory);
    const databasePath = join(nestedDirectory, "events.sqlite");
    try {
      const moduleUrl = new URL("./sqlite-event-store.ts", import.meta.url).href;
      const childScript = `
        import { SqliteEventStore } from ${JSON.stringify(moduleUrl)};
        const store = SqliteEventStore.open(${JSON.stringify(databasePath)});
        store.commit({
          aggregateId: "goal-child",
          commandBytes: new TextEncoder().encode("child-command"),
          commandId: "cmd-child",
          committedAt: "2026-08-06T10:00:00.000Z",
          events: [{
            eventId: "evt-child",
            eventType: "goal.created",
            payload: new TextEncoder().encode("child-payload"),
          }],
          expectedVersion: 0,
        });
      `;
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "--eval", childScript],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect({ signal: child.signal, status: child.status, stderr: child.stderr }).toMatchObject({
        signal: null,
        status: 0,
      });

      const reopened = storeModule.SqliteEventStore.open(databasePath);
      try {
        const replay = reopened.commit({
          aggregateId: "goal-child",
          commandBytes: bytes("child-command"),
          commandId: "cmd-child",
          committedAt: "2026-08-06T11:00:00.000Z",
          events: [
            {
              eventId: "evt-must-not-replace",
              eventType: "goal.created",
              payload: bytes("replacement"),
            },
          ],
          expectedVersion: 0,
        });
        expect(replay.disposition).toBe("REPLAYED");
        expect(replay.eventIds).toEqual(["evt-child"]);
        expect(text(reopened.readEvents("goal-child")[0]!.payload)).toBe("child-payload");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
