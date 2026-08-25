import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bytes } from "./command-decision-test-helpers.js";
import {
  DECISION_LEG_ROSTER_VERSION,
  DecisionLedgerIntegrityError,
  decisionLegReceiptCommandId,
  identifyDecisionLegRoster,
  snapshotDecisionLegRoster,
} from "./decision-leg-roster.js";
import * as storeModule from "./index.js";

const PROJECT_ID = "project-leg-integrity";
const DECIDED_AT = "2026-08-25T09:00:00.000Z";

function leg(aggregateId: string, index: number): storeModule.ExpectedVersionDecisionLeg {
  return {
    aggregateId,
    events: [{
      eventId: `event-${index}`,
      eventType: "goal.created",
      payload: bytes(`payload-${index}`),
    }],
    expectedVersion: 0,
  };
}

function captureOpenRefusal(databasePath: string): unknown {
  try {
    const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
    store.close();
    return null;
  } catch (error) {
    return error;
  }
}

function readPersistedRoster(databasePath: string, decisionId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    const summary = database.prepare(`
      SELECT roster_version, leg_count, roster_sha256
      FROM command_decision_leg_rosters
      WHERE decision_id = ?
    `).get(decisionId);
    if (summary === undefined) throw new Error("missing persisted roster summary");
    const rows = database.prepare(`
      SELECT
        leg_index, aggregate_id, expected_version,
        receipt_command_id, receipt_request_sha256, receipt_effect_sha256
      FROM command_decision_legs
      WHERE decision_id = ?
      ORDER BY leg_index
    `).all(decisionId);
    const roster = snapshotDecisionLegRoster({
      version: summary.roster_version,
      decisionId,
      count: summary.leg_count,
      legs: rows.map((row) => ({
        aggregateId: row.aggregate_id,
        expectedVersion: row.expected_version,
        index: row.leg_index,
        receiptCommandId: row.receipt_command_id,
        receiptEffectSha256: row.receipt_effect_sha256,
        receiptRequestSha256: row.receipt_request_sha256,
      })),
    });
    return { roster, sha256: String(summary.roster_sha256) };
  } finally {
    database.close();
  }
}

describe("command decision leg integrity", () => {
  it("persists and reopens the exact ordered receipt-bound roster", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-roundtrip-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      const response = store.commitExpectedVersionDecisionLegs({
        commandKind: "goal.create",
        committedResultBytes: bytes('{"goalId":"goal-a"}'),
        correlationId: "correlation-1",
        decidedAt: DECIDED_AT,
        key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
        legs: [leg("goal-a", 0), leg("goal-b", 1), leg("goal-c", 2)],
        requestBytes: bytes("goal.create/v1"),
      });
      store.close();

      const persisted = readPersistedRoster(databasePath, response.decision.decisionId);
      expect(persisted.roster.version).toBe(DECISION_LEG_ROSTER_VERSION);
      expect(persisted.roster.legs.map((item) => ({
        aggregateId: item.aggregateId,
        expectedVersion: item.expectedVersion,
        receiptCommandId: item.receiptCommandId,
      }))).toEqual([0, 1, 2].map((index) => ({
        aggregateId: ["goal-a", "goal-b", "goal-c"][index],
        expectedVersion: 0,
        receiptCommandId: decisionLegReceiptCommandId(response.decision.decisionId, index),
      })));
      expect(identifyDecisionLegRoster(persisted.roster)).toBe(persisted.sha256);

      const reopened = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      try {
        expect(reopened.getCommandDecision(response.decision.key)).toStrictEqual(response.decision);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("binds every rejected leg fence with null receipt authority across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-rejected-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      store.commit({
        aggregateId: "goal-b",
        commandBytes: bytes("seed"),
        commandId: "seed-command",
        committedAt: DECIDED_AT,
        events: [{ eventId: "seed-event", eventType: "goal.seeded", payload: bytes("seed") }],
        expectedVersion: 0,
      });
      const response = store.commitExpectedVersionDecisionLegs({
        commandKind: "goal.create",
        committedResultBytes: bytes("private-proposed-result"),
        correlationId: "correlation-1",
        decidedAt: "2026-08-25T09:01:00.000Z",
        key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
        legs: [leg("goal-a", 0), leg("goal-b", 1), leg("goal-c", 2)],
        requestBytes: bytes("goal.create/v1"),
      });
      expect(response.decision).toMatchObject({
        effectDisposition: "NO_BUSINESS_EFFECT",
        targetAggregateId: "goal-b",
      });
      store.close();

      const persisted = readPersistedRoster(databasePath, response.decision.decisionId);
      expect(persisted.roster.legs.map((item) => ({
        aggregateId: item.aggregateId,
        expectedVersion: item.expectedVersion,
        receiptCommandId: item.receiptCommandId,
        receiptEffectSha256: item.receiptEffectSha256,
        receiptRequestSha256: item.receiptRequestSha256,
      }))).toEqual(["goal-a", "goal-b", "goal-c"].map((aggregateId) => ({
        aggregateId,
        expectedVersion: 0,
        receiptCommandId: null,
        receiptEffectSha256: null,
        receiptRequestSha256: null,
      })));
      expect(identifyDecisionLegRoster(persisted.roster)).toBe(persisted.sha256);

      const reopened = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      try {
        expect(reopened.getCommandDecision(response.decision.key)).toStrictEqual(response.decision);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("folds a recomputed rejected-roster digest into the canonical decision identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-bound-digest-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      store.commit({
        aggregateId: "goal-b",
        commandBytes: bytes("seed"),
        commandId: "seed-command",
        committedAt: DECIDED_AT,
        events: [{ eventId: "seed-event", eventType: "goal.seeded", payload: bytes("seed") }],
        expectedVersion: 0,
      });
      const response = store.commitExpectedVersionDecisionLegs({
        commandKind: "goal.create",
        committedResultBytes: bytes("private-proposed-result"),
        correlationId: "correlation-1",
        decidedAt: "2026-08-25T09:01:00.000Z",
        key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
        legs: [leg("goal-a", 0), leg("goal-b", 1), leg("goal-c", 2)],
        requestBytes: bytes("goal.create/v1"),
      });
      store.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.prepare(`
          UPDATE command_decision_legs
          SET aggregate_id = 'goal-substituted'
          WHERE decision_id = ? AND leg_index = 2
        `).run(response.decision.decisionId);
      } finally {
        tamper.close();
      }
      const substituted = readPersistedRoster(databasePath, response.decision.decisionId);
      const recomputedSha256 = identifyDecisionLegRoster(substituted.roster);
      expect(recomputedSha256).not.toBe(substituted.sha256);
      const rebind = new DatabaseSync(databasePath);
      try {
        rebind.prepare(`
          UPDATE command_decision_leg_rosters
          SET roster_sha256 = ?
          WHERE decision_id = ?
        `).run(recomputedSha256, response.decision.decisionId);
      } finally {
        rebind.close();
      }

      const refusal = captureOpenRefusal(databasePath);
      expect(refusal).toBeInstanceOf(DecisionLedgerIntegrityError);
      expect(refusal).toMatchObject({ code: "STORE_CORRUPT", layer: "DECISION_LEDGER" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rolls back every effect, decision, summary, and leg when roster persistence fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-atomic-"));
    const databasePath = join(directory, "store.sqlite");
    const originalPrepare = DatabaseSync.prototype.prepare;
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      let refusal: unknown;
      DatabaseSync.prototype.prepare = function prepareWithRosterFailure(sql: string) {
        if (sql.includes("INSERT INTO command_decision_legs")) {
          throw new Error("injected roster persistence failure");
        }
        return originalPrepare.call(this, sql);
      };
      try {
        store.commitExpectedVersionDecisionLegs({
          commandKind: "goal.create",
          committedResultBytes: bytes('{"goalId":"goal-a"}'),
          correlationId: "correlation-1",
          decidedAt: DECIDED_AT,
          key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
          legs: [leg("goal-a", 0), leg("goal-b", 1), leg("goal-c", 2)],
          requestBytes: bytes("goal.create/v1"),
        });
      } catch (error) {
        refusal = error;
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare;
      }
      expect(refusal).toBeInstanceOf(storeModule.DurableStoreError);
      expect(refusal).toMatchObject({ code: "STORE_UNAVAILABLE" });
      expect(store.readEventsAfter(0n, 10).items).toEqual([]);
      expect(store.readCommandDecisionsAfter(0n, 10).items).toEqual([]);
      expect(store.getAggregateVersion("goal-a")).toBe(0);
      expect(store.getAggregateVersion("goal-b")).toBe(0);
      expect(store.getAggregateVersion("goal-c")).toBe(0);
      store.close();

      const inspection = new DatabaseSync(databasePath);
      try {
        expect(inspection.prepare(`
          SELECT
            (SELECT count(*) FROM command_decisions)
            + (SELECT count(*) FROM command_decision_leg_rosters)
            + (SELECT count(*) FROM command_decision_legs)
            + (SELECT count(*) FROM command_receipts)
            + (SELECT count(*) FROM domain_events) AS value
        `).get()).toEqual({ value: 0 });
      } finally {
        inspection.close();
      }
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([1, 2] as const)(
    "refuses reopen after the complete footprint for non-primary leg %i is removed",
    (legIndex) => {
      const directory = mkdtempSync(join(tmpdir(), `moe-decision-leg-delete-${legIndex}-`));
      const databasePath = join(directory, "store.sqlite");
      try {
        const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
        const response = store.commitExpectedVersionDecisionLegs({
          commandKind: "goal.create",
          committedResultBytes: bytes('{"goalId":"goal-a"}'),
          correlationId: "correlation-1",
          decidedAt: DECIDED_AT,
          key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
          legs: [leg("goal-a", 0), leg("goal-b", 1), leg("goal-c", 2)],
          requestBytes: bytes("goal.create/v1"),
        });
        store.close();

        const receiptCommandId = decisionLegReceiptCommandId(
          response.decision.decisionId,
          legIndex,
        );
        const aggregateId = legIndex === 1 ? "goal-b" : "goal-c";
        const tamper = new DatabaseSync(databasePath);
        try {
          tamper.exec("PRAGMA foreign_keys = OFF");
          tamper.prepare("DELETE FROM outbox_messages WHERE event_id IN (SELECT event_id FROM domain_events WHERE command_id = ?)")
            .run(receiptCommandId);
          tamper.prepare("DELETE FROM domain_events WHERE command_id = ?").run(receiptCommandId);
          tamper.prepare("DELETE FROM command_receipt_scopes WHERE receipt_command_id = ?")
            .run(receiptCommandId);
          tamper.prepare("DELETE FROM command_receipts WHERE command_id = ?").run(receiptCommandId);
          tamper.prepare("DELETE FROM aggregate_heads WHERE aggregate_id = ?").run(aggregateId);
        } finally {
          tamper.close();
        }

        const refusal = captureOpenRefusal(databasePath);
        expect(refusal).toBeInstanceOf(DecisionLedgerIntegrityError);
        expect(refusal).toMatchObject({ code: "STORE_CORRUPT", layer: "DECISION_LEDGER" });
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  const rosterMutations = [
    {
      name: "deleted ordered row",
      mutate(database: DatabaseSync, decisionId: string): void {
        database.prepare(
          "DELETE FROM command_decision_legs WHERE decision_id = ? AND leg_index = 2",
        ).run(decisionId);
      },
    },
    {
      name: "reordered rows",
      mutate(database: DatabaseSync, decisionId: string): void {
        database.prepare(
          "UPDATE command_decision_legs SET leg_index = leg_index + 3 WHERE decision_id = ? AND leg_index IN (1, 2)",
        ).run(decisionId);
        database.prepare(`
          UPDATE command_decision_legs
          SET leg_index = CASE leg_index WHEN 4 THEN 2 WHEN 5 THEN 1 END
          WHERE decision_id = ? AND leg_index IN (4, 5)
        `).run(decisionId);
      },
    },
    {
      name: "substituted aggregate",
      mutate(database: DatabaseSync, decisionId: string): void {
        database.prepare(`
          UPDATE command_decision_legs
          SET aggregate_id = 'goal-substituted'
          WHERE decision_id = ? AND leg_index = 1
        `).run(decisionId);
      },
    },
    {
      name: "extra ordered row",
      mutate(database: DatabaseSync, decisionId: string): void {
        database.prepare(`
          INSERT INTO command_decision_legs (
            decision_id, leg_index, aggregate_id, expected_version,
            receipt_command_id, receipt_request_sha256, receipt_effect_sha256
          ) VALUES (?, 3, 'goal-extra', 0, NULL, NULL, NULL)
        `).run(decisionId);
      },
    },
  ] as const;

  it.each(rosterMutations)("refuses a $name across close and reopen", ({ name, mutate }) => {
    const directory = mkdtempSync(join(tmpdir(), `moe-decision-leg-${name.replaceAll(" ", "-")}-`));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      const response = store.commitExpectedVersionDecisionLegs({
        commandKind: "goal.create",
        committedResultBytes: bytes('{"goalId":"goal-a"}'),
        correlationId: "correlation-1",
        decidedAt: DECIDED_AT,
        key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
        legs: [leg("goal-a", 0), leg("goal-b", 1), leg("goal-c", 2)],
        requestBytes: bytes("goal.create/v1"),
      });
      store.close();

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("PRAGMA foreign_keys = OFF");
        mutate(tamper, response.decision.decisionId);
      } finally {
        tamper.close();
      }

      const refusal = captureOpenRefusal(databasePath);
      expect(refusal).toBeInstanceOf(DecisionLedgerIntegrityError);
      expect(refusal).toMatchObject({ code: "STORE_CORRUPT", layer: "DECISION_LEDGER" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
