import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bytes, proposedDecision } from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

describe("expected-version command decision ledger project scope", () => {
  it("binds a decision store to one durable project boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-project-binding-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const projectA = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "project-a",
      );
      try {
        expect(projectA.getHealth().projectId).toBe("project-a");
        expect(() =>
          projectA.commitExpectedVersionDecision(
            proposedDecision({
              key: {
                commandId: "cross-project-command",
                principalId: "principal-1",
                projectId: "project-b",
              },
            }),
          ),
        ).toThrowError(/PROJECT_SCOPE_MISMATCH/u);
        expect(projectA.getAggregateVersion("goal-1")).toBe(0);
        expect(projectA.readCommandDecisionsAfter(0n, 10).items).toEqual([]);
      } finally {
        projectA.close();
      }

      expect(() => {
        const projectB = storeModule.SqliteEventStore.openForProject(
          databasePath,
          "project-b",
        );
        projectB.close();
      }).toThrowError(/PROJECT_SCOPE_MISMATCH/u);

      const reopened = storeModule.SqliteEventStore.open(databasePath);
      try {
        expect(reopened.getHealth().projectId).toBe("project-a");
        expect(() =>
          reopened.commitExpectedVersionDecision(
            proposedDecision({
              key: {
                commandId: "generic-open-cross-project",
                principalId: "principal-1",
                projectId: "project-b",
              },
            }),
          ),
        ).toThrowError(/PROJECT_SCOPE_REQUIRED/u);
        expect(() =>
          reopened.commit({
            aggregateId: "generic-open-goal",
            commandBytes: bytes("generic-open"),
            commandId: "generic-open-command",
            committedAt: "2026-08-06T17:49:00.000Z",
            events: [
              {
                eventId: "generic-open-event",
                eventType: "goal.created",
                payload: bytes("generic-open"),
              },
            ],
            expectedVersion: 0,
          }),
        ).toThrowError(/PROJECT_SCOPE_REQUIRED/u);
      } finally {
        reopened.close();
      }

      const staleHandlePath = join(directory, "stale-handle.sqlite");
      const staleUnboundHandle = storeModule.SqliteEventStore.open(staleHandlePath);
      const boundHandle = storeModule.SqliteEventStore.openForProject(
        staleHandlePath,
        "project-a",
      );
      try {
        expect(() =>
          staleUnboundHandle.commitExpectedVersionDecision(
            proposedDecision({
              key: {
                commandId: "stale-handle-command",
                principalId: "principal-1",
                projectId: "project-b",
              },
            }),
          ),
        ).toThrowError(/PROJECT_SCOPE_REQUIRED/u);
        expect(() => staleUnboundHandle.readCommandDecisionsAfter(0n, 10)).toThrowError(
          /PROJECT_SCOPE_REQUIRED/u,
        );
        expect(boundHandle.getHealth().projectId).toBe("project-a");
      } finally {
        staleUnboundHandle.close();
        boundHandle.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps an unbound production handle empty and unable to write", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-unscoped-binding-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const unscoped = storeModule.SqliteEventStore.open(databasePath);
      expect(() =>
        unscoped.commit({
          aggregateId: "unscoped-goal",
          commandBytes: bytes("unscoped"),
          commandId: "unscoped-command",
          committedAt: "2026-08-06T17:50:00.000Z",
          events: [
            {
              eventId: "unscoped-event",
              eventType: "goal.created",
              payload: bytes("unscoped"),
            },
          ],
          expectedVersion: 0,
        }),
      ).toThrowError(/PROJECT_SCOPE_REQUIRED/u);
      unscoped.close();

      const bound = storeModule.SqliteEventStore.openForProject(databasePath, "project-a");
      bound.close();
      const inspection = new DatabaseSync(databasePath);
      try {
        expect(inspection.prepare("SELECT count(*) AS value FROM store_project_binding").get())
          .toEqual({ value: 1 });
        expect(inspection.prepare("SELECT count(*) AS value FROM command_receipts").get())
          .toEqual({ value: 0 });
      } finally {
        inspection.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("detects deletion or transplantation of the durable project binding", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-binding-corrupt-"));
    try {
      const deletedPath = join(directory, "deleted.sqlite");
      const rawStore = storeModule.SqliteEventStore.openForProject(
        deletedPath,
        "project-a",
      );
      rawStore.commit({
        aggregateId: "raw-goal",
        commandBytes: bytes("raw"),
        commandId: "raw-command",
        committedAt: "2026-08-06T17:52:00.000Z",
        events: [
          {
            eventId: "raw-event",
            eventType: "goal.created",
            payload: bytes("raw"),
          },
        ],
        expectedVersion: 0,
      });
      rawStore.close();
      const deleteBinding = new DatabaseSync(deletedPath);
      deleteBinding.exec("DELETE FROM store_project_binding");
      deleteBinding.close();
      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(deletedPath);
        wronglyOpened.close();
      }).toThrowError(/STORE_CORRUPT/u);

      const transplantedPath = join(directory, "transplanted.sqlite");
      const decisionStore = storeModule.SqliteEventStore.openForProject(
        transplantedPath,
        "project-1",
      );
      decisionStore.commitExpectedVersionDecision(proposedDecision());
      decisionStore.close();
      const transplant = new DatabaseSync(transplantedPath);
      transplant.exec("UPDATE store_project_binding SET project_id = 'project-b'");
      transplant.close();
      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(transplantedPath);
        wronglyOpened.close();
      }).toThrowError(/STORE_CORRUPT/u);

      const rawTransplantedPath = join(directory, "raw-transplanted.sqlite");
      const rawTransplantedStore = storeModule.SqliteEventStore.openForProject(
        rawTransplantedPath,
        "project-a",
      );
      rawTransplantedStore.commit({
        aggregateId: "raw-transplanted-goal",
        commandBytes: bytes("raw-transplanted"),
        commandId: "raw-transplanted-command",
        committedAt: "2026-08-06T17:53:00.000Z",
        events: [
          {
            eventId: "raw-transplanted-event",
            eventType: "goal.created",
            payload: bytes("raw-transplanted"),
          },
        ],
        expectedVersion: 0,
      });
      rawTransplantedStore.close();
      const rawTransplant = new DatabaseSync(rawTransplantedPath);
      rawTransplant.exec("UPDATE store_project_binding SET project_id = 'project-b'");
      rawTransplant.close();
      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(rawTransplantedPath);
        wronglyOpened.close();
      }).toThrowError(/STORE_CORRUPT/u);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("treats the reserved namespace case-exactly across commit and restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-prefix-case-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      store.commit({
        aggregateId: "MOE-INTERNAL:ordinary-case-sensitive-id",
        commandBytes: bytes("uppercase-prefix"),
        commandId: "uppercase-prefix-command",
        committedAt: "2026-08-06T17:54:00.000Z",
        events: [
          {
            eventId: "uppercase-prefix-event",
            eventType: "goal.created",
            payload: bytes("uppercase"),
          },
        ],
        expectedVersion: 0,
      });
      store.close();

      const reopened = storeModule.SqliteEventStore.open(databasePath);
      try {
        expect(reopened.getAggregateVersion("MOE-INTERNAL:ordinary-case-sensitive-id"))
          .toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
