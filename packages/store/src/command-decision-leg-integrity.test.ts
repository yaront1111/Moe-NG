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
import type { DecisionLegRoster } from "./decision-leg-roster.js";
import { decodeDecisionDisposition } from "./decision-read-disposition.js";
import type {
  DecisionDispositionContext,
  DecisionDispositionInput,
} from "./decision-read-disposition.js";
import type { CommandDecisionRecord, EffectsCommittedDecision } from "./store-contracts.js";
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

function fence(
  aggregateId: string,
  expectedVersion = 0,
): storeModule.ExpectedVersionDecisionLeg {
  return { aggregateId, events: [], expectedVersion };
}

function commitMixedDecision(
  store: storeModule.SqliteEventStore,
): storeModule.CommandDecisionResponse {
  return store.commitExpectedVersionDecisionLegs({
    commandKind: "goal.create",
    committedResultBytes: bytes('{"goalId":"goal-a"}'),
    correlationId: "correlation-1",
    decidedAt: DECIDED_AT,
    key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
    legs: [leg("goal-a", 0), fence("goal-b"), leg("goal-c", 2)],
    requestBytes: bytes("goal.create/v1"),
  });
}

function commitMixedAndClose(
  store: storeModule.SqliteEventStore,
): storeModule.CommandDecisionResponse {
  try {
    return commitMixedDecision(store);
  } finally {
    store.close();
  }
}

const DISPOSITION_CONTEXT: DecisionDispositionContext = {
  assertAggregateTail: () => 0,
  loadRejectionAuditRow: () => undefined,
};

function requireCommitted(decision: CommandDecisionRecord): EffectsCommittedDecision {
  if (decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`expected a committed decision, got ${decision.effectDisposition}`);
  }
  return decision;
}

function committedDispositionInput(
  decision: EffectsCommittedDecision,
  legRoster: DecisionLegRoster,
): DecisionDispositionInput {
  const receiptCommandId = decisionLegReceiptCommandId(decision.decisionId, 0);
  return {
    auditEventId: null,
    businessEventCount: decision.businessEventIds.length,
    common: {
      ...decision,
      legCount: legRoster.count,
      legRosterSha256: identifyDecisionLegRoster(legRoster),
      legRosterVersion: legRoster.version,
      receiptCommandId,
    },
    currentVersion: decision.currentVersion,
    legRoster,
    outboxCount: decision.outboxMessageIds.length,
    previousVersion: decision.previousVersion,
    receipt: {
      aggregateId: decision.targetAggregateId,
      commandId: receiptCommandId,
      committedAt: decision.decidedAt,
      currentVersion: decision.currentVersion,
      effectIdentityVersion: decision.effectIdentityVersion,
      effectSha256: decision.effectSha256,
      eventIds: decision.businessEventIds,
      outboxMessageIds: decision.outboxMessageIds,
      previousVersion: decision.previousVersion,
      requestSha256: decision.replayRequestSha256,
    },
    row: { result_code: "EFFECTS_COMMITTED" },
  };
}

function withNullPrimaryReceipt(roster: DecisionLegRoster): DecisionLegRoster {
  return snapshotDecisionLegRoster({
    ...roster,
    legs: roster.legs.map((item) => item.index === 0
      ? {
        ...item,
        receiptCommandId: null,
        receiptEffectSha256: null,
        receiptRequestSha256: null,
      }
      : item),
  });
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

function rebindRosterDigest(databasePath: string, decisionId: string): void {
  const { roster } = readPersistedRoster(databasePath, decisionId);
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`
      UPDATE command_decision_leg_rosters SET roster_sha256 = ? WHERE decision_id = ?
    `).run(identifyDecisionLegRoster(roster), decisionId);
  } finally {
    database.close();
  }
}

describe("command decision leg integrity", () => {
  it("persists an accepted mixed roster with authority only for append legs", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-mixed-roundtrip-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      const response = commitMixedAndClose(store);

      const persisted = readPersistedRoster(databasePath, response.decision.decisionId);
      expect(persisted.roster.legs.map((item) => ({
        aggregateId: item.aggregateId,
        receiptCommandId: item.receiptCommandId,
        receiptEffectSha256: item.receiptEffectSha256,
        receiptRequestSha256: item.receiptRequestSha256,
      }))).toEqual([
        expect.objectContaining({
          aggregateId: "goal-a",
          receiptCommandId: decisionLegReceiptCommandId(response.decision.decisionId, 0),
        }),
        {
          aggregateId: "goal-b",
          receiptCommandId: null,
          receiptEffectSha256: null,
          receiptRequestSha256: null,
        },
        expect.objectContaining({
          aggregateId: "goal-c",
          receiptCommandId: decisionLegReceiptCommandId(response.decision.decisionId, 2),
        }),
      ]);
      expect(identifyDecisionLegRoster(persisted.roster)).toBe(persisted.sha256);

      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(inspection.prepare(`
          SELECT
            (SELECT count(*) FROM aggregate_heads WHERE aggregate_id = 'goal-b') AS heads,
            (SELECT count(*) FROM command_receipts WHERE aggregate_id = 'goal-b') AS receipts,
            (SELECT count(*) FROM domain_events WHERE aggregate_id = 'goal-b') AS events
        `).get()).toEqual({ events: 0, heads: 0, receipts: 0 });
      } finally {
        inspection.close();
      }

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

  it("rejects every append when another writer advances the captured guard version", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-fence-race-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const caller = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      const writer = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      try {
        const capturedGuardVersion = caller.getAggregateVersion("goal-b");
        writer.commit({
          aggregateId: "goal-b",
          commandBytes: bytes("advance-guard"),
          commandId: "guard-writer",
          committedAt: DECIDED_AT,
          events: [{ eventId: "guard-event", eventType: "goal.updated", payload: bytes("guard") }],
          expectedVersion: capturedGuardVersion,
        });

        const response = caller.commitExpectedVersionDecisionLegs({
          commandKind: "goal.create",
          committedResultBytes: bytes('{"goalId":"goal-a"}'),
          correlationId: "correlation-1",
          decidedAt: "2026-08-25T09:01:00.000Z",
          key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
          legs: [leg("goal-a", 0), fence("goal-b", capturedGuardVersion), leg("goal-c", 2)],
          requestBytes: bytes("goal.create/v1"),
        });

        expect(response.decision).toMatchObject({
          effectDisposition: "NO_BUSINESS_EFFECT",
          expectedVersion: 0,
          observedVersion: 1,
          resultCode: "EXPECTED_VERSION_CONFLICT",
          targetAggregateId: "goal-b",
        });
        expect(caller.readEvents("goal-a")).toEqual([]);
        expect(caller.readEvents("goal-c")).toEqual([]);
        expect(caller.getAggregateVersion("goal-a")).toBe(0);
        expect(caller.getAggregateVersion("goal-c")).toBe(0);
      } finally {
        caller.close();
        writer.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

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

  it("refuses an accepted roster whose primary receipt was changed to null", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-null-primary-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      const response = commitMixedAndClose(store);

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("PRAGMA foreign_keys = OFF");
        tamper.prepare(`
          UPDATE command_decision_legs
          SET receipt_command_id = NULL,
              receipt_request_sha256 = NULL,
              receipt_effect_sha256 = NULL
          WHERE decision_id = ? AND leg_index = 0
        `).run(response.decision.decisionId);
      } finally {
        tamper.close();
      }
      rebindRosterDigest(databasePath, response.decision.decisionId);

      const refusal = captureOpenRefusal(databasePath);
      expect(refusal).toBeInstanceOf(DecisionLedgerIntegrityError);
      expect(refusal).toMatchObject({ code: "STORE_CORRUPT", layer: "DECISION_LEDGER" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("decodes a sound mixed committed disposition through the production surface", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-disposition-sound-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      const response = commitMixedAndClose(store);
      const committed = requireCommitted(response.decision);
      const { roster } = readPersistedRoster(databasePath, committed.decisionId);

      expect(roster.legs[1]!.receiptCommandId).toBeNull();
      const stored = decodeDecisionDisposition(
        "EFFECTS_COMMITTED",
        committedDispositionInput(committed, roster),
        DISPOSITION_CONTEXT,
      );
      expect(stored.effectDisposition).toBe("EFFECTS_COMMITTED");
      expect(stored.resultCode).toBe("EFFECTS_COMMITTED");
      expect(stored.targetAggregateId).toBe("goal-a");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses a committed disposition whose primary roster leg carries no receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-disposition-null-primary-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      const response = commitMixedAndClose(store);
      const committed = requireCommitted(response.decision);
      const { roster } = readPersistedRoster(databasePath, committed.decisionId);
      const input = committedDispositionInput(committed, withNullPrimaryReceipt(roster));

      let refusal: unknown = null;
      try {
        decodeDecisionDisposition("EFFECTS_COMMITTED", input, DISPOSITION_CONTEXT);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DecisionLedgerIntegrityError);
      expect(refusal).toMatchObject({ code: "STORE_CORRUPT", layer: "DECISION_LEDGER" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses an accepted fence row with a fabricated non-null receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-fake-fence-receipt-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      const response = commitMixedAndClose(store);

      const tamper = new DatabaseSync(databasePath);
      try {
        tamper.exec("PRAGMA foreign_keys = OFF");
        tamper.prepare(`
          UPDATE command_decision_legs
          SET receipt_command_id = ?,
              receipt_request_sha256 = ?,
              receipt_effect_sha256 = ?
          WHERE decision_id = ? AND leg_index = 1
        `).run(
          decisionLegReceiptCommandId(response.decision.decisionId, 1),
          "0".repeat(64),
          "1".repeat(64),
          response.decision.decisionId,
        );
      } finally {
        tamper.close();
      }
      rebindRosterDigest(databasePath, response.decision.decisionId);

      const refusal = captureOpenRefusal(databasePath);
      expect(refusal).toBeInstanceOf(DecisionLedgerIntegrityError);
      expect(refusal).toMatchObject({ code: "STORE_CORRUPT", layer: "DECISION_LEDGER" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

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

  // DIVERGENCE ARM (epic rail 7A) for the reader's roster-digest recomputation.
  // `command_decision_leg_rosters.roster_sha256` is read by exactly one production line -
  // decision-leg-roster-read.ts:60, as the `expectedSha256` that decision-leg-roster-read.ts:82
  // compares its recomputed digest against - so rewriting only that column isolates that one
  // comparison. Every fence that shares its code and layer is left with nothing to say: the
  // ordered leg rows stay byte-identical, so the roster codec's structural fences (leg count,
  // contiguous indexes, index-derived receipt ids, unique aggregates and receipts) all pass;
  // `leg_count` is untouched, so decision-leg-roster.ts:146 passes; no foreign key moves, so the
  // open-time `PRAGMA foreign_key_check` branch in sqlite-schema-integrity.ts:26-31 sees no
  // violation; every receipt still agrees with its own leg row, so the per-leg cross-check at
  // decision-leg-roster-read.ts:93-100 passes; and decision-read-decode.ts recomputes
  // `legRosterSha256` from the loaded roster rather than from this column, so the canonical
  // decision identity still verifies. Loosen the digest comparison by one and only this arm reds.
  it("refuses a rewritten summary roster digest whose ordered leg rows are untouched", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-leg-summary-digest-"));
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

      const { decisionId } = response.decision;
      const persistedSha256 = readPersistedRoster(databasePath, decisionId).sha256;
      const rewrittenSha256 =
        `${persistedSha256.startsWith("0") ? "1" : "0"}${persistedSha256.slice(1)}`;
      expect(rewrittenSha256).not.toBe(persistedSha256);

      const tamper = new DatabaseSync(databasePath);
      try {
        const update = tamper.prepare(`
          UPDATE command_decision_leg_rosters SET roster_sha256 = ? WHERE decision_id = ?
        `).run(rewrittenSha256, decisionId);
        expect(Number(update.changes)).toBe(1);
      } finally {
        tamper.close();
      }
      expect(readPersistedRoster(databasePath, decisionId).sha256).toBe(rewrittenSha256);

      const refusal = captureOpenRefusal(databasePath);
      expect(refusal).toBeInstanceOf(DecisionLedgerIntegrityError);
      expect(refusal).toMatchObject({ code: "STORE_CORRUPT", layer: "DECISION_LEDGER" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
