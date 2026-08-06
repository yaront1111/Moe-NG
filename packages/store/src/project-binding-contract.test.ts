import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { proposedDecision } from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

interface FirstOpenResult {
  readonly accessMode?: string;
  readonly code?: string;
  readonly outcome: "OPENED" | "REJECTED";
  readonly projectId: string;
  readonly quickCheck?: string;
  readonly writeProjectAsserted?: boolean;
}

function seedScopedDecision(databasePath: string): void {
  const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
  try {
    store.commitExpectedVersionDecision(proposedDecision());
  } finally {
    store.close();
  }

  const inspection = new DatabaseSync(databasePath);
  try {
    expect(
      inspection.prepare("SELECT count(*) AS value FROM command_receipt_scopes").get(),
    ).toEqual({ value: 1 });
    expect(
      inspection.prepare("SELECT count(*) AS value FROM command_decisions").get(),
    ).toEqual({ value: 1 });
  } finally {
    inspection.close();
  }
}

function expectOpenErrorCode(databasePath: string, expectedCode: string): void {
  let captured: unknown;
  try {
    const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
    store.close();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
  expect(captured).toMatchObject({ code: expectedCode });
}

function startFirstOpenAttempt(
  databasePath: string,
  projectId: string,
  gate: SharedArrayBuffer,
): { readonly ready: Promise<void>; readonly result: Promise<FirstOpenResult> } {
  const worker = new Worker(
    new URL("./project-binding-first-open-worker.mjs", import.meta.url),
    {
      execArgv: ["--experimental-strip-types"],
      workerData: { databasePath, gate, projectId },
    },
  );
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: FirstOpenResult) => void;
  let rejectResult!: (error: Error) => void;
  let resultReceived = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<FirstOpenResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const rejectBoth = (error: Error): void => {
    rejectReady(error);
    rejectResult(error);
  };
  worker.on("message", (message: unknown) => {
    if (message === null || typeof message !== "object" || !("kind" in message)) {
      return;
    }
    if (message.kind === "READY") {
      resolveReady();
    } else if (message.kind === "RESULT") {
      resultReceived = true;
      resolveResult(message as unknown as FirstOpenResult);
    }
  });
  worker.on("error", rejectBoth);
  worker.on("exit", (code) => {
    if (code !== 0 || !resultReceived) {
      rejectBoth(new Error(`project binding first-open worker exited with ${code}`));
    }
  });
  return { ready, result };
}

describe("durable project binding access and first-open contract", () => {
  it("distinguishes generic inspection from project-asserted write access", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-binding-health-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const writer = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      try {
        expect(writer.getHealth()).toMatchObject({
          accessMode: "PROJECT_ASSERTED_WRITE",
          projectId: "project-1",
          writeProjectAsserted: true,
        });
      } finally {
        writer.close();
      }

      const inspection = storeModule.SqliteEventStore.open(databasePath);
      try {
        expect(inspection.getHealth()).toMatchObject({
          accessMode: "READ_ONLY_INSPECTION",
          projectId: "project-1",
          writeProjectAsserted: false,
        });
      } finally {
        inspection.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports scoped history with a deleted binding as corrupt on asserted reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-binding-deleted-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      seedScopedDecision(databasePath);
      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("DELETE FROM store_project_binding");
      } finally {
        tamper.close();
      }
      expectOpenErrorCode(databasePath, "STORE_CORRUPT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not mask a transplanted scoped binding as a project mismatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-binding-transplanted-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      seedScopedDecision(databasePath);
      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("UPDATE store_project_binding SET project_id = 'project-b'");
      } finally {
        tamper.close();
      }
      expectOpenErrorCode(databasePath, "STORE_CORRUPT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("atomically assigns one project when different workers first-open a fresh database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-binding-first-open-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const attempts = [
        startFirstOpenAttempt(databasePath, "project-a", gate),
        startFirstOpenAttempt(databasePath, "project-b", gate),
      ];
      await Promise.all(attempts.map((attempt) => attempt.ready));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, attempts.length);
      const results = await Promise.all(attempts.map((attempt) => attempt.result));

      expect(results.map((result) => result.outcome).sort()).toEqual([
        "OPENED",
        "REJECTED",
      ]);
      expect(results.map((result) => result.projectId).sort()).toEqual([
        "project-a",
        "project-b",
      ]);
      const winner = results.find((result) => result.outcome === "OPENED")!;
      const loser = results.find((result) => result.outcome === "REJECTED")!;
      expect(winner).toMatchObject({
        accessMode: "PROJECT_ASSERTED_WRITE",
        projectId: winner.projectId,
        quickCheck: "ok",
        writeProjectAsserted: true,
      });
      expect(loser.projectId).not.toBe(winner.projectId);
      expect(loser.code).toBe("PROJECT_SCOPE_MISMATCH");

      const reopened = storeModule.SqliteEventStore.openForProject(
        databasePath,
        winner.projectId,
      );
      try {
        expect(reopened.getHealth()).toMatchObject({
          accessMode: "PROJECT_ASSERTED_WRITE",
          foreignKeyViolations: 0,
          projectId: winner.projectId,
          quickCheck: "ok",
          writeProjectAsserted: true,
        });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("requires a stale unbound inspection handle to reopen after project binding", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-binding-stale-inspection-"));
    const databasePath = join(directory, "store.sqlite");
    const staleInspection = storeModule.SqliteEventStore.open(databasePath);
    const writer = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
    try {
      writer.commit({
        aggregateId: "late-bound-aggregate",
        commandBytes: new TextEncoder().encode("late-bound-command"),
        commandId: "late-bound-command",
        committedAt: "2026-08-06T20:01:00.000Z",
        events: [
          {
            eventId: "late-bound-event",
            eventType: "late-bound.event",
            payload: new TextEncoder().encode("late-bound-payload"),
          },
        ],
        expectedVersion: 0,
      });

      let captured: unknown;
      try {
        staleInspection.getCommandReceipt("late-bound-command");
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
      expect(captured).toMatchObject({ code: "PROJECT_SCOPE_REQUIRED" });
      let absentCaptured: unknown;
      try {
        staleInspection.getCommandReceipt("absent-command");
      } catch (error) {
        absentCaptured = error;
      }
      expect(absentCaptured).toBeInstanceOf(storeModule.DurableStoreError);
      expect(absentCaptured).toMatchObject({ code: "PROJECT_SCOPE_REQUIRED" });
      expect(staleInspection.getAggregateVersion("late-bound-aggregate")).toBe(1);
      expect(staleInspection.getHealth().projectId).toBe("project-1");
    } finally {
      staleInspection.close();
      writer.close();
    }

    try {
      const reopened = storeModule.SqliteEventStore.open(databasePath);
      try {
        expect(reopened.getCommandReceipt("late-bound-command")?.commandId).toBe(
          "late-bound-command",
        );
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
