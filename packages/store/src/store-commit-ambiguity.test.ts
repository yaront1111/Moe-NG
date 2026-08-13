import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bytes, proposedDecision } from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

function ordinaryCommitInput(): storeModule.CommitInput {
  return {
    aggregateId: "aggregate-1",
    commandBytes: bytes("command-1"),
    commandId: "command-1",
    committedAt: "2026-08-06T22:00:00.000Z",
    events: [
      {
        eventId: "event-1",
        eventType: "commit.test",
        payload: bytes("payload-1"),
      },
    ],
    expectedVersion: 0,
  };
}

function captureStoreError(action: () => unknown): storeModule.DurableStoreError {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
  return captured as storeModule.DurableStoreError;
}

describe("transaction COMMIT outcome classification", () => {
  it("keeps an ordinary-command handle usable after a rejected COMMIT rolls back", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForTest();
    const originalExec = DatabaseSync.prototype.exec;
    let rejectCommit = true;
    DatabaseSync.prototype.exec = function execWithRejectedCommit(sql: string): void {
      if (rejectCommit && sql.trim() === "COMMIT") {
        rejectCommit = false;
        throw new Error("simulated COMMIT rejection before execution");
      }
      originalExec.call(this, sql);
    };
    try {
      expect(captureStoreError(() => store.commit(ordinaryCommitInput())).code).toBe(
        "STORE_UNAVAILABLE",
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }

    try {
      expect(store.getAggregateVersion("aggregate-1")).toBe(0);
      expect(store.commit(ordinaryCommitInput()).disposition).toBe("COMMITTED");
    } finally {
      store.close();
    }
  });

  it("keeps a decision handle usable after a rejected COMMIT rolls back", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    const originalExec = DatabaseSync.prototype.exec;
    let rejectCommit = true;
    // Armed by BEGIN IMMEDIATE so the fault lands on the decision
    // transaction's COMMIT, not on the preflight read snapshot's — a rejected
    // read COMMIT never had writes to lose and would test a different path.
    let inWriteTransaction = false;
    DatabaseSync.prototype.exec = function execWithRejectedCommit(sql: string): void {
      const statement = sql.trim();
      if (statement === "BEGIN IMMEDIATE") inWriteTransaction = true;
      if (rejectCommit && inWriteTransaction && statement === "COMMIT") {
        rejectCommit = false;
        inWriteTransaction = false;
        throw new Error("simulated COMMIT rejection before execution");
      }
      if (statement === "COMMIT" || statement === "ROLLBACK") inWriteTransaction = false;
      originalExec.call(this, sql);
    };
    try {
      expect(
        captureStoreError(() => store.commitExpectedVersionDecision(proposedDecision())).code,
      ).toBe("STORE_UNAVAILABLE");
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }

    try {
      expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(0);
      expect(
        store.commitExpectedVersionDecision(proposedDecision()).disposition,
      ).toBe("DECIDED");
    } finally {
      store.close();
    }
  });

  it("reports OUTCOME_UNKNOWN when an ordinary COMMIT succeeds without acknowledgement", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-ordinary-commit-ambiguity-"));
    const databasePath = join(directory, "store.sqlite");
    const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
    const originalExec = DatabaseSync.prototype.exec;
    let loseAcknowledgement = true;
    DatabaseSync.prototype.exec = function execWithLostAcknowledgement(sql: string): void {
      originalExec.call(this, sql);
      if (loseAcknowledgement && sql.trim() === "COMMIT") {
        loseAcknowledgement = false;
        throw new Error("simulated lost COMMIT acknowledgement");
      }
    };
    try {
      expect(captureStoreError(() => store.commit(ordinaryCommitInput())).code).toBe(
        "OUTCOME_UNKNOWN",
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      store.close();
    }

    try {
      const reopened = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      expect(reopened.commit(ordinaryCommitInput()).disposition).toBe("REPLAYED");
      reopened.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports OUTCOME_UNKNOWN when a decision COMMIT succeeds without acknowledgement", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-commit-ambiguity-"));
    const databasePath = join(directory, "store.sqlite");
    const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
    const originalExec = DatabaseSync.prototype.exec;
    let loseAcknowledgement = true;
    // Armed by BEGIN IMMEDIATE: only the decision transaction's COMMIT is
    // ambiguous when unacknowledged. The preflight read snapshot commits too,
    // and losing THAT acknowledgement loses no durable outcome.
    let inWriteTransaction = false;
    DatabaseSync.prototype.exec = function execWithLostAcknowledgement(sql: string): void {
      const statement = sql.trim();
      if (statement === "BEGIN IMMEDIATE") inWriteTransaction = true;
      originalExec.call(this, sql);
      if (statement === "COMMIT" || statement === "ROLLBACK") {
        const wasWrite = inWriteTransaction;
        inWriteTransaction = false;
        if (loseAcknowledgement && wasWrite && statement === "COMMIT") {
          loseAcknowledgement = false;
          throw new Error("simulated lost COMMIT acknowledgement");
        }
      }
    };
    try {
      expect(
        captureStoreError(() => store.commitExpectedVersionDecision(proposedDecision())).code,
      ).toBe("OUTCOME_UNKNOWN");
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      store.close();
    }

    try {
      const reopened = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      expect(
        reopened.commitExpectedVersionDecision(proposedDecision()).disposition,
      ).toBe("REPLAYED");
      reopened.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
