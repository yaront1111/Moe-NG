import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DurableStoreError } from "../store-contracts.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import { bytes } from "../sqlite-event-store-test-helpers.js";
import { snapshotSubscriberId } from "./subscription-contracts.js";
import type {
  SubscriptionEventSource, SubscriptionGap, SubscriptionPage, SubscriptionPageResult,
  SubscriptionRefused,
} from "./subscription-contracts.js";
import { readSubscriptionPage } from "./subscription-read-page.js";
import {
  acknowledge, advanceGeneration, registerSubscription, reseatToSnapshot,
} from "./subscription-writes.js";

const AGGREGATE = "goal-1";
const AT = "2026-08-08T10:00:00.000Z";
const EVENT_TYPE = "goal.created";
const PROJECT = "moe-subscription-page-project";
const PROJECTION = "goal-count";
const STATE_DIGEST = "a".repeat(64);
const SUBSCRIBER = "goal-consumer";

interface Harness {
  readonly database: DatabaseSync;
  readonly store: SqliteEventStore;
}

function withHarness(run: (harness: Harness) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-subscription-page-"));
  const path = join(directory, "events.sqlite");
  const store = SqliteEventStore.openForProject(path, PROJECT);
  const database = new DatabaseSync(path, { timeout: 5_000 });
  try {
    run({ database, store });
  } finally {
    database.close();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function commitEvent(store: SqliteEventStore, index: number): void {
  store.commit({
    aggregateId: AGGREGATE, commandBytes: bytes(`{"n":${index}}`), commandId: `cmd-${index}`,
    committedAt: AT,
    events: [{ eventId: `evt-${index}`, eventType: EVENT_TYPE, payload: bytes(`p-${index}`) }],
    expectedVersion: index - 1,
  });
}

function setCheckpoint(database: DatabaseSync, position: bigint): void {
  database.prepare(`INSERT INTO projections (projection_name, last_applied_position, state_digest)
    VALUES (?, ?, NULL) ON CONFLICT(projection_name)
    DO UPDATE SET last_applied_position = excluded.last_applied_position`)
    .run(PROJECTION, position.toString());
}

function advance(harness: Harness, checkpoint: bigint, count: number, reason = "initial"): void {
  const result = advanceGeneration(harness.database, {
    at: AT,
    baselines: [{ checkpoint, projection: PROJECTION, state: { count }, stateDigest: STATE_DIGEST }],
    reason,
  });
  if (result.outcome !== "ADVANCED") {
    throw new Error(`expected a generation, got ${JSON.stringify(result)}`);
  }
}

function enrol(harness: Harness, subscriberId = SUBSCRIBER, origin = true): void {
  const result = origin
    ? registerSubscription(harness.database, {
      at: AT, projection: PROJECTION, startMode: "ORIGIN", subscriberId,
    })
    : registerSubscription(harness.database, { at: AT, projection: PROJECTION, subscriberId });
  if (result.outcome === "REFUSED") {
    throw new Error(`expected a seated cursor, got ${JSON.stringify(result)}`);
  }
}

function read(
  harness: Harness, limit?: number, subscriberId = SUBSCRIBER, projection = PROJECTION,
): SubscriptionPageResult {
  return limit === undefined
    ? readSubscriptionPage(harness.store, harness.database, { projection, subscriberId })
    : readSubscriptionPage(harness.store, harness.database, { limit, projection, subscriberId });
}

function paged(result: SubscriptionPageResult): SubscriptionPage {
  if (result.outcome !== "PAGE") {
    throw new Error(`expected a page, got ${JSON.stringify(result, replacer)}`);
  }
  return result;
}

function gapped(result: SubscriptionPageResult): SubscriptionGap {
  if (result.outcome !== "CURSOR_GAP") {
    throw new Error(`expected a cursor gap, got ${JSON.stringify(result, replacer)}`);
  }
  return result;
}

function denied(result: SubscriptionPageResult): SubscriptionRefused {
  if (result.outcome !== "REFUSED") {
    throw new Error(`expected a refusal, got ${JSON.stringify(result, replacer)}`);
  }
  return result;
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function positions(page: SubscriptionPage): readonly bigint[] {
  return page.events.map((event) => event.globalPosition);
}

function tamperCursor(database: DatabaseSync, edit: (raw: Record<string, unknown>) => void): void {
  const stored = database
    .prepare("SELECT filter_json FROM event_subscriptions WHERE subscriber_id = ?")
    .get(SUBSCRIBER)?.["filter_json"];
  const raw = JSON.parse(String(stored)) as Record<string, unknown>;
  edit(raw);
  database.prepare("UPDATE event_subscriptions SET filter_json = ? WHERE subscriber_id = ?")
    .run(JSON.stringify(raw), SUBSCRIBER);
}

function failingSource(error: unknown): SubscriptionEventSource {
  return {
    readEventsAfter: () => {
      throw error;
    },
  };
}

describe("readSubscriptionPage cursor gaps", () => {
  it("reports a changed generation and recovers through a reseat", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      for (let index = 1; index <= 4; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 4n);
      advance(harness, 2n, 2, "rebuild");

      const gap = gapped(read(harness));

      expect(gap.cause).toBe("GENERATION_CHANGED");
      expect(gap.lastGoodCursor).toEqual({ generation: 1, position: "0" });
      expect(gap.snapshot.generation).toBe(2);
      expect(gap.snapshot.checkpoint).toBe("2");
      expect(gap.snapshot.state).toEqual({ count: 2 });

      const reseated = reseatToSnapshot(harness.database, {
        projection: PROJECTION, subscriberId: SUBSCRIBER,
      });
      expect(reseated.outcome).toBe("RESEATED");
      expect(positions(paged(read(harness)))).toEqual([3n, 4n]);
    });
  });

  it("reports pruned history instead of silently repositioning the cursor", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      for (let index = 1; index <= 5; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 5n);
      expect(acknowledge(harness.database, {
        cursor: { generation: 1, position: "1" }, subscriberId: SUBSCRIBER,
      }).outcome).toBe("ACKNOWLEDGED");
      harness.database.prepare("DELETE FROM domain_events WHERE global_position <= 3").run();

      const gap = gapped(read(harness));

      expect(gap.cause).toBe("HISTORY_PRUNED");
      expect(gap.lastGoodCursor).toEqual({ generation: 1, position: "1" });
      expect(gap.snapshot.checkpoint).toBe("0");
    });
  });

  it("reports pruned history when the ledger is empty but the projection ran on", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      setCheckpoint(harness.database, 5n);

      const gap = gapped(read(harness));

      expect(gap.cause).toBe("HISTORY_PRUNED");
      expect(gap.lastGoodCursor).toEqual({ generation: 1, position: "0" });
    });
  });

  it("returns an empty page, not a gap, on a store that has never run", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);

      const page = paged(read(harness));

      expect(page).toEqual({
        checkpoint: 0n, events: [], hasMore: false, nextCursor: null, outcome: "PAGE",
      });
    });
  });

  it("reports a cursor ahead of the projection rather than refusing", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      for (let index = 1; index <= 5; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 5n);
      expect(acknowledge(harness.database, {
        cursor: { generation: 1, position: "5" }, subscriberId: SUBSCRIBER,
      }).outcome).toBe("ACKNOWLEDGED");
      setCheckpoint(harness.database, 3n);

      const gap = gapped(read(harness));

      expect(gap.cause).toBe("CURSOR_AHEAD");
      expect(gap.lastGoodCursor).toEqual({ generation: 1, position: "5" });
      expect(gap.snapshot.projection).toBe(PROJECTION);
    });
  });
});

describe("readSubscriptionPage corrupt state", () => {
  const tampers: readonly (readonly [string, (raw: Record<string, unknown>) => void])[] = [
    ["a flipped digest", (raw) => {
      raw["receiptDigest"] = `b${String(raw["receiptDigest"]).slice(1)}`;
    }],
    ["a leading-zero position", (raw) => {
      raw["cursor"] = { generation: 1, position: "007" };
    }],
    ["an exponent position", (raw) => {
      raw["cursor"] = { generation: 1, position: "1e3" };
    }],
    ["a negative position", (raw) => {
      raw["cursor"] = { generation: 1, position: "-1" };
    }],
    ["an unknown doc version", (raw) => {
      raw["version"] = "moe-subscription/2";
    }],
    ["a lone surrogate projection", (raw) => {
      raw["projection"] = "goal-\ud800";
    }],
  ];

  it("covers every cursor tamper case", () => {
    expect(tampers.length).toBeGreaterThan(0);
  });

  it.each(tampers)("reports %s as a recoverable corrupt cursor", (_label, edit) => {
    withHarness((harness) => {
      advance(harness, 2n, 2);
      enrol(harness);
      tamperCursor(harness.database, edit);

      const gap = gapped(read(harness));

      expect(gap.cause).toBe("CURSOR_CORRUPT");
      expect(gap.lastGoodCursor).toBeNull();
      expect(gap.snapshot.checkpoint).toBe("2");
      expect(gap.snapshot.state).toEqual({ count: 2 });
    });
  });

  it("refuses instead of fabricating a snapshot when the baseline is missing", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      harness.database.prepare("DELETE FROM event_subscriptions WHERE subscriber_id = ?")
        .run(snapshotSubscriberId(PROJECTION));

      const result = denied(read(harness));

      expect(result.code).toBe("SUBSCRIPTION_STATE_CORRUPT");
      expect(result.layer).toBe("STATE");
      expect(result.detail).toContain("missing");
    });
  });

  it("refuses instead of fabricating a snapshot when the baseline is unparseable", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      harness.database.prepare("UPDATE event_subscriptions SET filter_json = ? WHERE subscriber_id = ?")
        .run("{\"tampered\":true}", snapshotSubscriberId(PROJECTION));

      const result = denied(read(harness));

      expect(result.code).toBe("SUBSCRIPTION_STATE_CORRUPT");
      expect(result.detail).toContain("unparseable");
    });
  });

  it("refuses an unregistered subscriber, a sentinel id, a foreign projection and a bad limit", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);

      expect(denied(read(harness, undefined, "never-registered")).code)
        .toBe("SUBSCRIPTION_NOT_REGISTERED");
      const sentinel = denied(read(harness, undefined, snapshotSubscriberId(PROJECTION)));
      expect(sentinel.code).toBe("SUBSCRIPTION_INPUT_INVALID");
      expect(sentinel.layer).toBe("INPUT");
      expect(denied(read(harness, undefined, SUBSCRIBER, "goal-audit")).code)
        .toBe("SUBSCRIPTION_INPUT_INVALID");
      expect(denied(read(harness, 0)).code).toBe("SUBSCRIPTION_INPUT_INVALID");
      expect(denied(read(harness, 10_001)).code).toBe("SUBSCRIPTION_INPUT_INVALID");
    });
  });
});

describe("readSubscriptionPage page semantics", () => {
  it("clamps to the projection checkpoint, including the event exactly at it", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      for (let index = 1; index <= 5; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 3n);

      const page = paged(read(harness));

      expect(positions(page)).toEqual([1n, 2n, 3n]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toEqual({ generation: 1, position: "3" });
      expect(page.checkpoint).toBe(3n);
    });
  });

  it("reports hasMore only for events within the clamped bound", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      for (let index = 1; index <= 5; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 3n);

      const first = paged(read(harness, 2));
      expect(positions(first)).toEqual([1n, 2n]);
      expect(first.hasMore).toBe(true);

      expect(acknowledge(harness.database, {
        cursor: { generation: 1, position: "2" }, subscriberId: SUBSCRIBER,
      }).outcome).toBe("ACKNOWLEDGED");
      const second = paged(read(harness, 2));
      expect(positions(second)).toEqual([3n]);
      expect(second.hasMore).toBe(false);
    });
  });

  it("returns an empty page when the cursor already sits on the checkpoint", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      for (let index = 1; index <= 2; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 2n);
      expect(acknowledge(harness.database, {
        cursor: { generation: 1, position: "2" }, subscriberId: SUBSCRIBER,
      }).outcome).toBe("ACKNOWLEDGED");

      const page = paged(read(harness));

      expect(page.events).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });
  });

  it("freezes the page and its events without freezing payload bytes", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      commitEvent(harness.store, 1);
      setCheckpoint(harness.database, 1n);

      const page = paged(read(harness));
      const event = page.events[0];

      expect(event?.payload.byteLength).toBeGreaterThan(0);
      expect(Object.isFrozen(page)).toBe(true);
      expect(Object.isFrozen(page.events)).toBe(true);
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event?.payload)).toBe(false);
    });
  });
});

describe("readSubscriptionPage snapshot discipline", () => {
  it("leaves no read transaction open on the page path or the refusal path", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      commitEvent(harness.store, 1);
      setCheckpoint(harness.database, 1n);

      paged(read(harness));
      expect(harness.database.isTransaction).toBe(false);

      denied(read(harness, undefined, "never-registered"));
      expect(harness.database.isTransaction).toBe(false);

      expect(acknowledge(harness.database, {
        cursor: { generation: 1, position: "1" }, subscriberId: SUBSCRIBER,
      }).outcome).toBe("ACKNOWLEDGED");
    });
  });

  it("reuses a transaction the caller already holds instead of nesting one", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      commitEvent(harness.store, 1);
      setCheckpoint(harness.database, 1n);
      harness.database.exec("BEGIN DEFERRED");

      try {
        expect(positions(paged(read(harness)))).toEqual([1n]);
        expect(harness.database.isTransaction).toBe(true);
      } finally {
        harness.database.exec("COMMIT");
      }
    });
  });
});

describe("readSubscriptionPage determinism", () => {
  it("returns the same frozen page for the same cursor and checkpoint", () => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      for (let index = 1; index <= 3; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 2n);
      const first = paged(read(harness));

      expect(paged(read(harness))).toEqual(first);

      for (let index = 4; index <= 6; index += 1) {
        commitEvent(harness.store, index);
      }
      expect(paged(read(harness))).toEqual(first);
    });
  });

  it("paginates to exactly the retained range at every page size", () => {
    const sizes = [1, 3, 5, 10] as const;

    withHarness((harness) => {
      advance(harness, 0n, 0);
      for (let index = 1; index <= 5; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 5n);
      expect(sizes.length).toBeGreaterThan(0);
      let rounds = 0;

      for (const size of sizes) {
        const subscriberId = `sweep-${size}`;
        enrol(harness, subscriberId);
        const seen: bigint[] = [];
        let more = true;
        for (let round = 0; more && round < 20; round += 1) {
          const page = paged(read(harness, size, subscriberId));
          seen.push(...positions(page));
          if (page.nextCursor !== null) {
            expect(acknowledge(harness.database, { cursor: page.nextCursor, subscriberId })
              .outcome).toBe("ACKNOWLEDGED");
          }
          more = page.hasMore;
          rounds += 1;
        }
        expect(seen).toEqual([1n, 2n, 3n, 4n, 5n]);
      }

      expect(rounds).toBeGreaterThan(0);
    });
  });
});

describe("readSubscriptionPage event source failures", () => {
  const failures: readonly (readonly [string, DurableStoreError])[] = [
    ["STORE_BUSY", new DurableStoreError("STORE_BUSY", "the ledger reader is contended")],
    ["STORE_LIMIT_EXCEEDED", new DurableStoreError("STORE_LIMIT_EXCEEDED", "page too large")],
    ["STORE_CORRUPT", new DurableStoreError("STORE_CORRUPT", "a cursor is not increasing")],
  ];

  it("covers every event-source failure case", () => {
    expect(failures.length).toBeGreaterThan(0);
  });

  it.each(failures)("rethrows %s verbatim", (_label, error) => {
    withHarness((harness) => {
      advance(harness, 0n, 0);
      enrol(harness);
      for (let index = 1; index <= 3; index += 1) {
        commitEvent(harness.store, index);
      }
      setCheckpoint(harness.database, 3n);

      expect(() => readSubscriptionPage(failingSource(error), harness.database, {
        projection: PROJECTION, subscriberId: SUBSCRIBER,
      })).toThrow(error);
    });
  });
});
