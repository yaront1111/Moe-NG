import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SqliteEventStore } from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import type { SubscriptionPageResult } from "@moe/store/subscriptions/subscription-contracts.js";

import { BOARD_PROJECTION } from "./board-projection-contracts.js";
import { createBoardProjectionService } from "./board-projection-service.js";
import type { BoardProjectionService } from "./board-projection-contracts.js";

const AT = "2026-08-09T12:00:00.000Z";
const CLOCK = (): string => AT;
const PROJECT = "proj-board-projection";
const READER = "control-room-1";
const SHA256_HEX = /^[0-9a-f]{64}$/u;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Harness {
  readonly database: DatabaseSync;
  readonly service: BoardProjectionService;
  readonly store: SqliteEventStore;
}

function withHarness(run: (harness: Harness) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-board-projection-"));
  const path = join(directory, "events.sqlite");
  const store = SqliteEventStore.openForProject(path, PROJECT);
  const database = new DatabaseSync(path, { timeout: 5_000 });
  const service = createBoardProjectionService({ clock: CLOCK, database, store });
  try {
    run({ database, service, store });
  } finally {
    database.close();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

/** Commits one goal.created event through the store's own decision API. */
function commitGoalEvent(store: SqliteEventStore, index: number): void {
  store.commitExpectedVersionDecision({
    commandKind: "goal.create",
    committedResultBytes: bytes(`result-${index}`),
    correlationId: `corr-${index}`,
    decidedAt: AT,
    events: [{ eventId: `evt-${index}`, eventType: "goal.created", payload: bytes(`p-${index}`) }],
    expectedVersion: index - 1,
    key: { commandId: `cmd-${index}`, principalId: "principal-board", projectId: PROJECT },
    requestBytes: bytes(`req-${index}`),
    targetAggregateId: "goal-1",
  });
}

function readPage(harness: Harness, subscriberId = READER): SubscriptionPageResult {
  return readSubscriptionPage(harness.store, harness.database, {
    projection: BOARD_PROJECTION, subscriberId,
  });
}

describe("createBoardProjectionService", () => {
  it("refuses unusable wiring with the stable config code before touching any handle", () => {
    for (const config of [{}, { projectId: PROJECT }, { storePath: "somewhere.sqlite" }]) {
      let thrown: unknown = null;
      try {
        createBoardProjectionService(config);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "BOARD_PROJECTION_CONFIG_INVALID" });
    }
  });

  it("refuses every entry point before a baseline exists with the store's own code", () => {
    withHarness((harness) => {
      const missing = {
        code: "SUBSCRIPTION_GENERATION_MISSING", layer: "STATE", outcome: "REFUSED",
      };
      expect(readPage(harness)).toMatchObject(missing);
      expect(harness.service.foldOnce()).toMatchObject(missing);
      expect(harness.service.registerReader(READER)).toMatchObject(missing);
    });
  });

  it("serves committed events to a registered reader: baseline, register, commit, fold, page", () => {
    withHarness((harness) => {
      const { service } = harness;
      expect(service.ensureBaseline("board-baseline")).toEqual({
        created: true, generation: 1, outcome: "BASELINE_READY",
      });
      expect(service.ensureBaseline("board-baseline")).toEqual({
        created: false, generation: 1, outcome: "BASELINE_READY",
      });

      expect(service.registerReader(READER)).toMatchObject({
        cursor: { generation: 1, position: "0" }, outcome: "REGISTERED",
      });
      expect(readPage(harness)).toMatchObject({
        events: [], hasMore: false, nextCursor: null, outcome: "PAGE",
      });

      commitGoalEvent(harness.store, 1);
      commitGoalEvent(harness.store, 2);

      const folded = service.foldOnce();
      expect(folded).toMatchObject({ appliedCount: 2, checkpoint: 2n, outcome: "FOLDED" });
      if (folded.outcome === "FOLDED") {
        expect(folded.stateDigest).toMatch(SHA256_HEX);
      }

      const page = readPage(harness);
      expect(page).toMatchObject({
        checkpoint: 2n,
        hasMore: false,
        nextCursor: { generation: 1, position: "2" },
        outcome: "PAGE",
      });
      if (page.outcome === "PAGE") {
        expect(page.events.map((event) => event.eventId)).toEqual(["evt-1", "evt-2"]);
        expect(page.events.map((event) => event.eventType))
          .toEqual(["goal.created", "goal.created"]);
        expect(page.events.map((event) => event.globalPosition)).toEqual([1n, 2n]);
      }

      // Idempotent catch-up: the digest compare-and-set re-lands on the same row.
      expect(service.foldOnce()).toMatchObject({
        appliedCount: 0, checkpoint: 2n, outcome: "FOLDED",
      });

      // The fold refreshed the snapshot sentinel, so a late reader seats at the
      // folded checkpoint with the honest folded state instead of replaying.
      expect(service.registerReader("control-room-2")).toMatchObject({
        cursor: { generation: 1, position: "2" },
        outcome: "REGISTERED",
        snapshot: {
          checkpoint: "2",
          state: {
            aggregates: { "goal-1": 2 },
            byType: { "goal.created": 2 },
            eventTotal: 2,
            lastCommittedAt: AT,
            lastPosition: "2",
          },
        },
      });
    });
  });

  it("refuses an unknown subscriber with SUBSCRIPTION_NOT_REGISTERED", () => {
    withHarness((harness) => {
      expect(harness.service.ensureBaseline("board-baseline"))
        .toMatchObject({ outcome: "BASELINE_READY" });
      expect(readPage(harness, "ghost-reader")).toMatchObject({
        code: "SUBSCRIPTION_NOT_REGISTERED", layer: "STATE", outcome: "REFUSED",
      });
    });
  });

  it("surfaces store refusals verbatim: duplicate reader and unusable reason", () => {
    withHarness((harness) => {
      const { service } = harness;
      expect(service.ensureBaseline("")).toMatchObject({
        code: "SUBSCRIPTION_INPUT_INVALID", layer: "INPUT", outcome: "REFUSED",
      });
      expect(service.ensureBaseline("board-baseline"))
        .toMatchObject({ created: true, outcome: "BASELINE_READY" });
      expect(service.registerReader(READER)).toMatchObject({ outcome: "REGISTERED" });
      expect(service.registerReader(READER)).toMatchObject({
        code: "SUBSCRIPTION_INPUT_INVALID", layer: "INPUT", outcome: "REFUSED",
      });
    });
  });

  it("owns and releases its handles in storePath mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-board-owned-"));
    const service = createBoardProjectionService({
      clock: CLOCK, projectId: PROJECT, storePath: join(directory, "owned.sqlite"),
    });
    try {
      expect(service.ensureBaseline("board-baseline")).toEqual({
        created: true, generation: 1, outcome: "BASELINE_READY",
      });
      expect(service.foldOnce()).toMatchObject({
        appliedCount: 0, checkpoint: 0n, outcome: "FOLDED",
      });
      expect(service.registerReader(READER)).toMatchObject({
        cursor: { generation: 1, position: "0" }, outcome: "REGISTERED",
      });
    } finally {
      service.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
