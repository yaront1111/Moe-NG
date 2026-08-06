import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bytes, proposedDecision } from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

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

describe("live project binding and deletion detection", () => {
  it("refuses writes after the durable binding diverges from the open handle", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-live-binding-tamper-"));
    const databasePath = join(directory, "store.sqlite");
    const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-a");
    try {
      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("UPDATE store_project_binding SET project_id = 'project-b'");
      } finally {
        tamper.close();
      }

      expect(
        captureStoreError(() => store.commitExpectedVersionDecision(proposedDecision({
          key: {
            commandId: "tampered-binding-command",
            principalId: "principal-1",
            projectId: "project-a",
          },
        }))).code,
      ).toBe("STORE_CORRUPT");
      const inspection = new DatabaseSync(databasePath);
      try {
        const row = inspection
          .prepare("SELECT count(*) AS value FROM aggregate_heads")
          .get();
        expect(Number(row?.value)).toBe(0);
      } finally {
        inspection.close();
      }
    } finally {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses scoped reads and health after the live binding diverges", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-live-binding-read-tamper-"));
    const databasePath = join(directory, "store.sqlite");
    const key = {
      commandId: "read-tamper-decision",
      principalId: "principal-1",
      projectId: "project-a",
    } as const;
    const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-a");
    try {
      store.commitExpectedVersionDecision(proposedDecision({ key }));
      store.commit({
        aggregateId: "read-tamper-aggregate",
        commandBytes: bytes("read-tamper-command"),
        commandId: "read-tamper-receipt",
        committedAt: "2026-08-06T20:00:00.000Z",
        events: [
          {
            eventId: "read-tamper-event",
            eventType: "binding.read-test",
            payload: bytes("read-tamper-payload"),
          },
        ],
        expectedVersion: 0,
      });

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("UPDATE store_project_binding SET project_id = 'project-b'");
      } finally {
        tamper.close();
      }

      expect(captureStoreError(() => store.getCommandDecision(key)).code).toBe(
        "STORE_CORRUPT",
      );
      expect(
        captureStoreError(() => store.getCommandReceipt("read-tamper-receipt")).code,
      ).toBe("STORE_CORRUPT");
      expect(
        captureStoreError(() => store.getCommandReceipt("absent-receipt")).code,
      ).toBe("STORE_CORRUPT");
      expect(
        captureStoreError(() => store.getAggregateVersion("read-tamper-aggregate")).code,
      ).toBe("STORE_CORRUPT");
      expect(captureStoreError(() => store.readEventsAfter(0n, 10)).code).toBe(
        "STORE_CORRUPT",
      );
      expect(captureStoreError(() => store.readPendingOutboxPage(0n, 10)).code).toBe(
        "STORE_CORRUPT",
      );
      expect(captureStoreError(() => store.getHealth()).code).toBe("STORE_CORRUPT");
    } finally {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("revalidates the binding under lock before historical decision replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-replay-binding-race-"));
    const databasePath = join(directory, "store.sqlite");
    const input = proposedDecision({
      key: {
        commandId: "replay-race-command",
        principalId: "principal-1",
        projectId: "project-a",
      },
    });
    const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-a");
    const originalAll = StatementSync.prototype.all;
    let injectBindingChange = false;
    try {
      store.commitExpectedVersionDecision(input);
      StatementSync.prototype.all = (function allWithBindingRace(
        this: StatementSync,
        ...parameters: unknown[]
      ) {
        const rows = Reflect.apply(originalAll, this, parameters) as ReturnType<
          StatementSync["all"]
        >;
        if (
          injectBindingChange &&
          this.sourceSQL.includes("FROM store_project_binding")
        ) {
          injectBindingChange = false;
          const tamper = new DatabaseSync(databasePath);
          try {
            tamper.exec("UPDATE store_project_binding SET project_id = 'project-b'");
          } finally {
            tamper.close();
          }
        }
        return rows;
      }) as StatementSync["all"];
      injectBindingChange = true;

      expect(
        captureStoreError(() => store.commitExpectedVersionDecision(input)).code,
      ).toBe("STORE_CORRUPT");
    } finally {
      StatementSync.prototype.all = originalAll;
      store.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("detects deletion of all scoped history from an already-bound database", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-ledger-deletion-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      store.commitExpectedVersionDecision(proposedDecision());
      store.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec(`
          PRAGMA foreign_keys = OFF;
          DELETE FROM command_decisions;
          DELETE FROM command_receipt_scopes;
          DELETE FROM outbox_messages;
          DELETE FROM domain_events;
          DELETE FROM aggregate_heads;
          DELETE FROM command_receipts;
        `);
      } finally {
        tamper.close();
      }

      expect(
        captureStoreError(() => {
          const wronglyOpened = storeModule.SqliteEventStore.openForProject(
            databasePath,
            "project-1",
          );
          wronglyOpened.close();
        }).code,
      ).toBe("STORE_CORRUPT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("detects deletion of an append-only tail while earlier history remains", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-ledger-tail-deletion-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      for (const suffix of ["1", "2"] as const) {
        store.commit({
          aggregateId: `aggregate-${suffix}`,
          commandBytes: bytes(`command-${suffix}`),
          commandId: `command-${suffix}`,
          committedAt: `2026-08-06T20:0${suffix}:00.000Z`,
          events: [
            {
              eventId: `event-${suffix}`,
              eventType: "tail.test",
              payload: bytes(`payload-${suffix}`),
            },
          ],
          expectedVersion: 0,
        });
      }
      store.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec(`
          PRAGMA foreign_keys = OFF;
          DELETE FROM domain_events WHERE command_id = 'command-2';
          DELETE FROM aggregate_heads WHERE aggregate_id = 'aggregate-2';
          DELETE FROM command_receipt_scopes WHERE receipt_command_id = 'command-2';
          DELETE FROM command_receipts WHERE command_id = 'command-2';
        `);
      } finally {
        tamper.close();
      }

      expect(
        captureStoreError(() => {
          const wronglyOpened = storeModule.SqliteEventStore.openForProject(
            databasePath,
            "project-1",
          );
          wronglyOpened.close();
        }).code,
      ).toBe("STORE_CORRUPT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("detects deletion of earlier history when the append-only tail remains", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-ledger-prefix-deletion-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      for (const suffix of ["1", "2"] as const) {
        store.commit({
          aggregateId: `aggregate-${suffix}`,
          commandBytes: bytes(`command-${suffix}`),
          commandId: `command-${suffix}`,
          committedAt: `2026-08-06T21:0${suffix}:00.000Z`,
          events: [
            {
              eventId: `event-${suffix}`,
              eventType: "gap.test",
              payload: bytes(`payload-${suffix}`),
            },
          ],
          expectedVersion: 0,
        });
      }
      store.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec(`
          PRAGMA foreign_keys = OFF;
          DELETE FROM domain_events WHERE command_id = 'command-1';
          DELETE FROM aggregate_heads WHERE aggregate_id = 'aggregate-1';
          DELETE FROM command_receipt_scopes WHERE receipt_command_id = 'command-1';
          DELETE FROM command_receipts WHERE command_id = 'command-1';
        `);
      } finally {
        tamper.close();
      }

      expect(
        captureStoreError(() => {
          const wronglyOpened = storeModule.SqliteEventStore.openForProject(
            databasePath,
            "project-1",
          );
          wronglyOpened.close();
        }).code,
      ).toBe("STORE_CORRUPT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects non-integer SQLite sequence evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-ledger-sequence-type-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      store.commit({
        aggregateId: "aggregate-1",
        commandBytes: bytes("command-1"),
        commandId: "command-1",
        committedAt: "2026-08-06T20:01:00.000Z",
        events: [
          {
            eventId: "event-1",
            eventType: "sequence.test",
            payload: bytes("payload-1"),
          },
        ],
        expectedVersion: 0,
      });
      store.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("UPDATE sqlite_sequence SET seq = 'garbage' WHERE name = 'domain_events'");
      } finally {
        tamper.close();
      }

      expect(
        captureStoreError(() => {
          const wronglyOpened = storeModule.SqliteEventStore.openForProject(
            databasePath,
            "project-1",
          );
          wronglyOpened.close();
        }).code,
      ).toBe("STORE_CORRUPT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects duplicate SQLite sequence rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-ledger-sequence-duplicate-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      store.commit({
        aggregateId: "aggregate-1",
        commandBytes: bytes("command-1"),
        commandId: "command-1",
        committedAt: "2026-08-06T20:01:00.000Z",
        events: [
          {
            eventId: "event-1",
            eventType: "sequence.test",
            payload: bytes("payload-1"),
          },
        ],
        expectedVersion: 0,
      });
      store.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('domain_events', 1)");
      } finally {
        tamper.close();
      }

      expect(
        captureStoreError(() => {
          const wronglyOpened = storeModule.SqliteEventStore.openForProject(
            databasePath,
            "project-1",
          );
          wronglyOpened.close();
        }).code,
      ).toBe("STORE_CORRUPT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects SQLite sequence rows for unknown ledgers", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-ledger-sequence-unknown-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      store.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('ghost_table', 7)");
      } finally {
        tamper.close();
      }

      expect(
        captureStoreError(() => {
          const wronglyOpened = storeModule.SqliteEventStore.openForProject(
            databasePath,
            "project-1",
          );
          wronglyOpened.close();
        }).code,
      ).toBe("STORE_CORRUPT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
