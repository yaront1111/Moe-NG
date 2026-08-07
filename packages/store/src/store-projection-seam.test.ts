import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DurableStoreError, SqliteEventStore } from "./index.js";
import type { CommitInput, CommitResult } from "./index.js";
import type { CommitApply } from "./sqlite-event-store.js";
import { bytes } from "./sqlite-event-store-test-helpers.js";

const PROJECTION_NAME = "seam-probe";
const INSERT_PROJECTION =
  "INSERT INTO projections (projection_name, last_applied_position, state_digest) VALUES (?, ?, ?)";

function commitInput(suffix: string, expectedVersion: number): CommitInput {
  return {
    aggregateId: "goal-1",
    commandBytes: bytes(`{"command":"${suffix}"}`),
    commandId: `cmd-${suffix}`,
    committedAt: "2026-08-06T10:00:00.000Z",
    events: [
      {
        eventId: `evt-${suffix}`,
        eventType: "goal.created",
        payload: bytes(`payload-${suffix}`),
      },
    ],
    expectedVersion,
  };
}

function withDurableStore(run: (open: () => SqliteEventStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-store-seam-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    run(
      () => SqliteEventStore.openForProject(databasePath, "moe-seam-project"),
      databasePath,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withEphemeralStore(run: (store: SqliteEventStore) => void): void {
  const store = SqliteEventStore.openEphemeralForTest();
  try {
    run(store);
  } finally {
    store.close();
  }
}

function readProjectionNames(databasePath: string): readonly string[] {
  const database = new DatabaseSync(databasePath);
  try {
    return database
      .prepare("SELECT projection_name FROM projections ORDER BY projection_name")
      .all()
      .map((row) => String(row["projection_name"]));
  } finally {
    database.close();
  }
}

function captureThrow(run: () => void): DurableStoreError {
  try {
    run();
  } catch (error) {
    return error as DurableStoreError;
  }
  throw new Error("expected the projection seam to throw");
}

function selectPositions(database: DatabaseSync, commandId: string): readonly number[] {
  return database
    .prepare(
      "SELECT global_position FROM domain_events WHERE command_id = ? ORDER BY global_position",
    )
    .all(commandId)
    .map((row) => Number(row["global_position"]));
}

describe("projection commit seam", () => {
  it("runs the apply inside the same transaction as the event append", () => {
    withDurableStore((open, databasePath) => {
      let summary: CommitResult | null = null;
      let positionsSeenInsideApply: readonly number[] = [];
      const store = open();
      try {
        const result = store.commitWithApply(commitInput("1", 0), (context) => {
          summary = context.summary;
          positionsSeenInsideApply = selectPositions(context.database, "cmd-1");
          context.database
            .prepare(INSERT_PROJECTION)
            .run(PROJECTION_NAME, String(positionsSeenInsideApply.at(-1)), "digest-1");
        });
        expect(result.disposition).toBe("COMMITTED");
      } finally {
        store.close();
      }

      const observed = summary as CommitResult | null;
      expect(observed?.commandId).toBe("cmd-1");
      expect(observed?.aggregateId).toBe("goal-1");
      expect(observed?.eventIds).toEqual(["evt-1"]);
      expect(Object.keys(observed ?? {}).sort().join(",")).toBe(
        "aggregateId,commandId,currentVersion,disposition,effectIdentityVersion," +
          "effectSha256,eventIds,outboxMessageIds,previousVersion,requestSha256",
      );
      expect(positionsSeenInsideApply).toEqual([1]);

      const reopened = open();
      try {
        expect(reopened.readEvents("goal-1").map((event) => event.eventId)).toEqual(["evt-1"]);
        expect(reopened.getAggregateVersion("goal-1")).toBe(1);
      } finally {
        reopened.close();
      }
      expect(readProjectionNames(databasePath)).toEqual([PROJECTION_NAME]);
    });
  });

  it("rolls back the whole append when the apply throws after writing", () => {
    withDurableStore((open, databasePath) => {
      const store = open();
      try {
        expect(store.getAggregateVersion("goal-1")).toBe(0);
        const failure = captureThrow(() => {
          store.commitWithApply(commitInput("1", 0), (context) => {
            context.database
              .prepare(INSERT_PROJECTION)
              .run(PROJECTION_NAME, "1", "digest-1");
            throw new Error("projection fold rejected the commit");
          });
        });
        expect(failure).toBeInstanceOf(DurableStoreError);
        expect(failure.code).toBe("PROJECTION_APPLY_FAILED");
        expect(failure.message).toBe(
          "PROJECTION_APPLY_FAILED: projection fold rejected the commit",
        );

        expect(store.readEvents("goal-1")).toEqual([]);
        expect(store.getAggregateVersion("goal-1")).toBe(0);
        expect(store.getCommandReceipt("cmd-1")).toBeNull();
      } finally {
        store.close();
      }
      expect(readProjectionNames(databasePath)).toEqual([]);
    });
  });

  it("leaves the store handle usable after a failed apply", () => {
    withEphemeralStore((store) => {
      const failure = captureThrow(() => {
        store.commitWithApply(commitInput("1", 0), () => {
          throw new Error("apply exploded");
        });
      });
      expect(failure.code).toBe("PROJECTION_APPLY_FAILED");
      const recovered = store.commit(commitInput("2", 0));
      expect(recovered.disposition).toBe("COMMITTED");
      expect(recovered.currentVersion).toBe(1);
      expect(store.getHealth().quickCheck).toBe("ok");
    });
  });

  it("never invokes the apply for a replayed command", () => {
    withEphemeralStore((store) => {
      const applyCalls: string[] = [];
      const record: CommitApply = (context) => {
        applyCalls.push(context.summary.commandId);
      };
      expect(store.commitWithApply(commitInput("1", 0), record).disposition).toBe("COMMITTED");
      expect(store.commitWithApply(commitInput("1", 0), record).disposition).toBe("REPLAYED");
      expect(applyCalls).toEqual(["cmd-1"]);
    });
  });

  it("wraps a plain apply failure at the invocation site instead of renaming it", () => {
    withEphemeralStore((store) => {
      const failure = captureThrow(() => {
        store.commitWithApply(commitInput("1", 0), () => {
          throw new Error("not a DurableStoreError");
        });
      });
      expect(failure.code).toBe("PROJECTION_APPLY_FAILED");
      expect(failure.message).toBe("PROJECTION_APPLY_FAILED: not a DurableStoreError");
    });
  });

  it("keeps the stable code when the apply throws an undescribable value", () => {
    withEphemeralStore((store) => {
      const failure = captureThrow(() => {
        store.commitWithApply(commitInput("1", 0), () => {
          throw Symbol("unspeakable");
        });
      });
      expect(failure.code).toBe("PROJECTION_APPLY_FAILED");
      expect(store.getAggregateVersion("goal-1")).toBe(0);
    });
  });

  it("refuses an asynchronous apply instead of committing behind it", () => {
    withEphemeralStore((store) => {
      const failure = captureThrow(() => {
        store.commitWithApply(commitInput("1", 0), () => Promise.resolve());
      });
      expect(failure.message).toBe(
        "PROJECTION_APPLY_FAILED: the commit apply must be synchronous; " +
          "this transaction cannot await a thenable",
      );
      expect(store.readEvents("goal-1")).toEqual([]);
      expect(store.getAggregateVersion("goal-1")).toBe(0);
      expect(store.getCommandReceipt("cmd-1")).toBeNull();
    });
  });

  it("never invokes the apply on a conflicting command", () => {
    withEphemeralStore((store) => {
      const applyCalls: string[] = [];
      const record: CommitApply = (context) => {
        applyCalls.push(context.summary.commandId);
      };
      store.commit(commitInput("1", 0));
      const reused = { ...commitInput("1", 0), commandBytes: bytes("{}") };
      expect(captureThrow(() => store.commitWithApply(reused, record)).code).toBe(
        "COMMAND_ID_CONFLICT",
      );
      expect(captureThrow(() => store.commitWithApply(commitInput("2", 0), record)).code).toBe(
        "EXPECTED_VERSION_CONFLICT",
      );
      expect(applyCalls).toEqual([]);
    });
  });

  it("keeps the plain commit entry point unchanged", () => {
    expect(SqliteEventStore.prototype.commit.length).toBe(1);
    expect(SqliteEventStore.prototype.commitWithApply.length).toBe(2);
    withEphemeralStore((store) => {
      const committed = store.commit(commitInput("1", 0));
      expect(committed.disposition).toBe("COMMITTED");
      expect(committed.eventIds).toEqual(["evt-1"]);
      expect(store.getAggregateVersion("goal-1")).toBe(1);
      expect(store.commit(commitInput("1", 0)).disposition).toBe("REPLAYED");
    });
  });
});
