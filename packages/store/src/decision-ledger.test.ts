/**
 * Startup validation sweeps the committed ledger twice: `validateAllReceipts`
 * proves every command receipt, then `validateAllCommandDecisions` decodes
 * every decision through the same `loadReceipt`. The second sweep must reuse
 * the receipts the first sweep just proved — re-reading and re-SHA-256-ing
 * every payload blob doubles open-time work without adding evidence. The test
 * counts receipt-row loads during one open and requires exactly one per
 * receipt, by hooking the receipt-row SELECT the way the ambiguity suites
 * hook `exec` on the shared DatabaseSync prototype.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bytes, proposedDecision } from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

/** Together these fragments match only loadReceipt's receipt-row SELECT. */
const RECEIPT_ROW_MARKERS = ["FROM command_receipts", "WHERE command_id = ?"] as const;

describe("decision ledger startup validation", () => {
  it("loads and proves each command receipt once across both startup sweeps", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-startup-single-load-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      store.commit({
        aggregateId: "plain-goal",
        commandBytes: bytes("plain-seed"),
        commandId: "plain-seed-command",
        committedAt: "2026-08-21T09:00:00.000Z",
        events: [
          {
            eventId: "plain-seed-event",
            eventType: "goal.seeded",
            payload: bytes("seed"),
          },
        ],
        expectedVersion: 0,
      });
      store.commitExpectedVersionDecision(proposedDecision());
      store.commitExpectedVersionDecision(
        proposedDecision({
          events: [
            {
              eventId: "event-2",
              eventType: "goal.created",
              payload: bytes("payload-2"),
            },
          ],
          key: {
            commandId: "command-2",
            principalId: "principal-1",
            projectId: "project-1",
          },
          targetAggregateId: "goal-2",
        }),
      );
      store.close();

      const receiptRowLoads = new Map<string, number>();
      const originalPrepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function prepareWithReceiptRowCounting(
        sql: string,
      ): StatementSync {
        const statement = originalPrepare.call(this, sql);
        if (RECEIPT_ROW_MARKERS.every((marker) => sql.includes(marker))) {
          const originalGet = statement.get.bind(statement);
          // loadReceipt binds the command id as the single anonymous parameter.
          (statement as { get: StatementSync["get"] }).get = ((
            ...parameters: SQLInputValue[]
          ) => {
            const commandId = String(parameters[0]);
            receiptRowLoads.set(commandId, (receiptRowLoads.get(commandId) ?? 0) + 1);
            return originalGet(...parameters);
          }) as StatementSync["get"];
        }
        return statement;
      };
      try {
        const reopened = storeModule.SqliteEventStore.open(databasePath);
        reopened.close();
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare;
      }

      // Positive control first: startup visited the plain commit receipt and
      // one internal receipt per decision, so the hook observed real loads.
      expect(receiptRowLoads.size).toBe(3);
      expect(receiptRowLoads.get("plain-seed-command")).toBe(1);
      for (const [commandId, loads] of receiptRowLoads) {
        expect(loads, `receipt ${commandId} row loads during one open`).toBe(1);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
