import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { proposedDecision } from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

describe("project independence and schema-version fencing", () => {
  it("allows the same principal and command ID in independent project databases", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-project-independent-commands-"));
    const projectAPath = join(directory, "project-a.sqlite");
    const projectBPath = join(directory, "project-b.sqlite");
    const projectA = storeModule.SqliteEventStore.openForProject(
      projectAPath,
      "project-a",
    );
    const projectB = storeModule.SqliteEventStore.openForProject(
      projectBPath,
      "project-b",
    );
    try {
      const sharedCommand = {
        commandId: "shared-command-id",
        principalId: "shared-principal-id",
      } as const;
      const resultA = projectA.commitExpectedVersionDecision(
        proposedDecision({
          key: { ...sharedCommand, projectId: "project-a" },
        }),
      );
      const resultB = projectB.commitExpectedVersionDecision(
        proposedDecision({
          key: { ...sharedCommand, projectId: "project-b" },
        }),
      );

      expect(resultA.disposition).toBe("DECIDED");
      expect(resultB.disposition).toBe("DECIDED");
      expect(resultA.decision.key).toEqual({ ...sharedCommand, projectId: "project-a" });
      expect(resultB.decision.key).toEqual({ ...sharedCommand, projectId: "project-b" });
      expect(projectA.readCommandDecisionsAfter(0n, 10).items).toHaveLength(1);
      expect(projectB.readCommandDecisionsAfter(0n, 10).items).toHaveLength(1);
    } finally {
      projectA.close();
      projectB.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses a too-new schema without downgrading or adopting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-too-new-schema-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const initial = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "project-1",
      );
      initial.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("PRAGMA user_version = 6");
      } finally {
        tamper.close();
      }

      let captured: unknown;
      try {
        const wronglyOpened = storeModule.SqliteEventStore.openForProject(
          databasePath,
          "project-1",
        );
        wronglyOpened.close();
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
      expect(captured).toMatchObject({ code: "STORE_SCHEMA_INVALID" });

      const inspection = new DatabaseSync(databasePath);
      try {
        expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 6,
        });
        expect(
          inspection.prepare("SELECT project_id FROM store_project_binding").get(),
        ).toEqual({ project_id: "project-1" });
      } finally {
        inspection.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not change journal mode before rejecting corrupt durable bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-corrupt-journal-mode-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const initial = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "project-1",
      );
      initial.commitExpectedVersionDecision(proposedDecision());
      initial.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        expect(tamper.prepare("PRAGMA journal_mode = DELETE").get()).toEqual({
          journal_mode: "delete",
        });
        tamper.exec("UPDATE domain_events SET payload = x'00' WHERE event_id = 'event-1'");
      } finally {
        tamper.close();
      }

      let captured: unknown;
      try {
        const wronglyOpened = storeModule.SqliteEventStore.openForProject(
          databasePath,
          "project-1",
        );
        wronglyOpened.close();
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(storeModule.DurableStoreError);
      expect(captured).toMatchObject({ code: "STORE_CORRUPT" });

      const inspection = new DatabaseSync(databasePath);
      try {
        expect(inspection.prepare("PRAGMA journal_mode").get()).toEqual({
          journal_mode: "delete",
        });
      } finally {
        inspection.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
