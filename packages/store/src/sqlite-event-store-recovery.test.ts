import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import * as storeModule from "./index.js";
import { bytes, startRaceWorker, text } from "./sqlite-event-store-test-helpers.js";

describe("SqliteEventStore recovery and scale", () => {
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
      const store = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "moe-test-project",
      );
      try {
        store.commit({
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
        const sequenceSetup = new DatabaseSync(databasePath);
        try {
          sequenceSetup
            .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name IN (?, ?)")
            .run(Number.MAX_SAFE_INTEGER, "domain_events", "outbox_messages");
        } finally {
          sequenceSetup.close();
        }

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
      const first = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "moe-test-project",
      );
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

        const second = storeModule.SqliteEventStore.openForProject(
          databasePath,
          "moe-test-project",
        );
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
        const store = SqliteEventStore.openForProject(${JSON.stringify(databasePath)}, "moe-test-project");
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

      const reopened = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "moe-test-project",
      );
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
