import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventStore } from "../sqlite-event-store.js";
import { bytes } from "../sqlite-event-store-test-helpers.js";
import type { SubscriptionPage } from "./subscription-contracts.js";
import { readSubscriptionPage } from "./subscription-read-page.js";
import {
  acknowledge, advanceGeneration, registerSubscription,
} from "./subscription-writes.js";

const AT = "2026-08-16T10:00:00.000Z";
const PROJECT = "durable-offer-project";
const PROJECTION = "moe.board";
const SUBSCRIBER = "control-room-1";
const STATE_DIGEST = "a".repeat(64);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function pathFor(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-subscription-offer-${label}-`));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

function open(path: string): { readonly database: DatabaseSync; readonly store: SqliteEventStore } {
  return {
    database: new DatabaseSync(path, { timeout: 5_000 }),
    store: SqliteEventStore.openForProject(path, PROJECT),
  };
}

function close(harness: ReturnType<typeof open>): void {
  harness.database.close();
  harness.store.close();
}

function append(store: SqliteEventStore, index: number): void {
  store.commit({
    aggregateId: "goal-1",
    commandBytes: bytes(`command-${index}`),
    commandId: `command-${index}`,
    committedAt: AT,
    events: [{ eventId: `event-${index}`, eventType: "goal.changed", payload: bytes(`${index}`) }],
    expectedVersion: index - 1,
  });
}

function checkpoint(database: DatabaseSync, position: number): void {
  database.prepare(`INSERT INTO projections (projection_name, last_applied_position, state_digest)
    VALUES (?, ?, NULL) ON CONFLICT(projection_name)
    DO UPDATE SET last_applied_position = excluded.last_applied_position`)
    .run(PROJECTION, String(position));
}

function seed(harness: ReturnType<typeof open>, events = 5): void {
  const advanced = advanceGeneration(harness.database, {
    at: AT,
    baselines: [{ checkpoint: 0n, projection: PROJECTION, state: {}, stateDigest: STATE_DIGEST }],
    reason: "initial",
  });
  expect(advanced.outcome).toBe("ADVANCED");
  const registered = registerSubscription(harness.database, {
    at: AT, projection: PROJECTION, startMode: "ORIGIN", subscriberId: SUBSCRIBER,
  });
  expect(registered.outcome).toBe("REGISTERED");
  for (let index = 1; index <= events; index += 1) append(harness.store, index);
  checkpoint(harness.database, events);
}

function page(harness: ReturnType<typeof open>, limit: number): SubscriptionPage {
  const result = readSubscriptionPage(harness.store, harness.database, {
    limit, projection: PROJECTION, subscriberId: SUBSCRIBER,
  });
  if (result.outcome !== "PAGE") throw new Error(`expected PAGE, got ${result.outcome}`);
  return result;
}

describe("durable subscription page offers", () => {
  it("replays the exact issued page after the checkpoint advances and the caller changes limit", () => {
    const path = pathFor("checkpoint");
    const harness = open(path);
    try {
      seed(harness, 3);
      const first = page(harness, 2);

      append(harness.store, 4);
      append(harness.store, 5);
      checkpoint(harness.database, 5);

      const retried = page(harness, 100);
      expect(retried).toEqual(first);
      expect(retried.events.map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
      expect(retried.nextCursor).toEqual({ generation: 1, position: "2" });
    } finally {
      close(harness);
    }
  });

  it("replays the exact issued page after both store connections reopen", () => {
    const path = pathFor("reopen");
    const firstHarness = open(path);
    seed(firstHarness, 3);
    const first = page(firstHarness, 2);
    close(firstHarness);

    const reopened = open(path);
    try {
      expect(page(reopened, 20)).toEqual(first);
    } finally {
      close(reopened);
    }
  });

  it("refuses a forged skip and advances only the cursor that the pending offer issued", () => {
    const path = pathFor("exact-ack");
    const harness = open(path);
    try {
      seed(harness, 4);
      const issued = page(harness, 2);
      expect(issued.nextCursor).toEqual({ generation: 1, position: "2" });

      const forged = acknowledge(harness.database, {
        cursor: { generation: 1, position: "3" }, subscriberId: SUBSCRIBER,
      });
      expect(forged).toMatchObject({
        code: "SUBSCRIPTION_CURSOR_NOT_ISSUED", layer: "STATE", outcome: "REFUSED",
      });
      expect(page(harness, 4)).toEqual(issued);

      const accepted = acknowledge(harness.database, {
        cursor: { generation: 1, position: "2" }, subscriberId: SUBSCRIBER,
      });
      expect(accepted).toEqual({
        cursor: { generation: 1, position: "2" }, outcome: "ACKNOWLEDGED",
      });
      expect(page(harness, 2).events.map((event) => event.eventId))
        .toEqual(["event-3", "event-4"]);
    } finally {
      close(harness);
    }
  });

  it("refuses a stale duplicate acknowledgement after consuming the exact offer", () => {
    const path = pathFor("stale-ack");
    const harness = open(path);
    try {
      seed(harness, 2);
      const issued = page(harness, 2);
      if (issued.nextCursor === null) throw new Error("expected an issued cursor");
      expect(acknowledge(harness.database, {
        cursor: issued.nextCursor, subscriberId: SUBSCRIBER,
      }).outcome).toBe("ACKNOWLEDGED");

      expect(acknowledge(harness.database, {
        cursor: issued.nextCursor, subscriberId: SUBSCRIBER,
      })).toMatchObject({
        code: "SUBSCRIPTION_CURSOR_NOT_ISSUED", layer: "STATE", outcome: "REFUSED",
      });
    } finally {
      close(harness);
    }
  });

  it("fails closed when a durable offer field is modified without its identity", () => {
    const path = pathFor("tampered-offer");
    const harness = open(path);
    try {
      seed(harness, 2);
      const issued = page(harness, 2);
      harness.database.prepare(`
        UPDATE subscription_pending_offers SET page_limit = 3 WHERE subscriber_id = ?
      `).run(SUBSCRIBER);

      const replay = readSubscriptionPage(harness.store, harness.database, {
        limit: 3, projection: PROJECTION, subscriberId: SUBSCRIBER,
      });
      expect(replay).toMatchObject({
        code: "SUBSCRIPTION_STATE_CORRUPT", layer: "STATE", outcome: "REFUSED",
      });
      expect(issued.events.map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
    } finally {
      close(harness);
    }
  });
});
