import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import * as storeModule from "./index.js";

it("reports an unknown outcome when bootstrap COMMIT succeeds and acknowledgement fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-bootstrap-commit-ambiguity-"));
  const databasePath = join(directory, "store.sqlite");
  const originalExec = DatabaseSync.prototype.exec;
  let interceptCommit = true;
  DatabaseSync.prototype.exec = function execWithLostAcknowledgement(sql: string): void {
    originalExec.call(this, sql);
    if (interceptCommit && sql.trim() === "COMMIT") {
      interceptCommit = false;
      throw new Error("simulated lost bootstrap COMMIT acknowledgement");
    }
  };
  try {
    let captured: unknown;
    try {
      const store = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "project-1",
      );
      store.close();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
    expect(captured).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }

  try {
    const reconciled = storeModule.SqliteEventStore.openForProject(
      databasePath,
      "project-1",
    );
    expect(reconciled.getHealth()).toMatchObject({
      projectId: "project-1",
      quickCheck: "ok",
    });
    reconciled.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("preserves OUTCOME_UNKNOWN when connection close acknowledgement also fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-bootstrap-close-ambiguity-"));
  const databasePath = join(directory, "store.sqlite");
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  let interceptCommit = true;
  let interceptClose = true;
  DatabaseSync.prototype.exec = function execWithLostCommitAcknowledgement(sql: string): void {
    originalExec.call(this, sql);
    if (interceptCommit && sql.trim() === "COMMIT") {
      interceptCommit = false;
      throw new Error("simulated lost bootstrap COMMIT acknowledgement");
    }
  };
  DatabaseSync.prototype.close = function closeWithLostAcknowledgement(): void {
    originalClose.call(this);
    if (interceptClose) {
      interceptClose = false;
      throw new Error("simulated lost close acknowledgement");
    }
  };
  try {
    let captured: unknown;
    try {
      storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
    expect(captured).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.close = originalClose;
  }

  try {
    const reconciled = storeModule.SqliteEventStore.openForProject(
      databasePath,
      "project-1",
    );
    reconciled.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("reports a known startup failure when COMMIT was rejected before execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-bootstrap-commit-rejected-"));
  const databasePath = join(directory, "store.sqlite");
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
    let captured: unknown;
    try {
      storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
    expect(captured).toMatchObject({ code: "STORE_UNAVAILABLE" });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }

  try {
    const reconciled = storeModule.SqliteEventStore.openForProject(
      databasePath,
      "project-1",
    );
    expect(reconciled.getHealth()).toMatchObject({ projectId: "project-1" });
    reconciled.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("preserves STORE_BUSY when bootstrap COMMIT is rejected by a live lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-bootstrap-commit-busy-"));
  const databasePath = join(directory, "store.sqlite");
  const originalExec = DatabaseSync.prototype.exec;
  let rejectCommit = true;
  DatabaseSync.prototype.exec = function execWithBusyCommit(sql: string): void {
    if (rejectCommit && sql.trim() === "COMMIT") {
      rejectCommit = false;
      throw Object.assign(new Error("database is locked"), {
        errcode: 5,
        errstr: "database is locked",
      });
    }
    originalExec.call(this, sql);
  };
  try {
    let captured: unknown;
    try {
      storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
    expect(captured).toMatchObject({ code: "STORE_BUSY" });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }

  try {
    const reconciled = storeModule.SqliteEventStore.openForProject(
      databasePath,
      "project-1",
    );
    reconciled.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
