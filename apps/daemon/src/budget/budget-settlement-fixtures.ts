/**
 * Shared bare-store fixture for production-reachable budget refusal tests.
 *
 * The store starts with no project, activation, provider run, or budget event. Consumers that
 * need later settlement states keep those claims as TODOs until production can commit the
 * prerequisite activation; this module never manufactures authority below admission.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";

import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
} from "../recovery/restore-test-harness.js";
import { applyProviderUsageToBudget } from "./budget-settlement-application.js";

export { cleanupRestoreHarnesses };

const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const scratchRoots: string[] = [];

export function cleanupSettlementScratchRoots(): void {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
}

export function openUnactivatedBudgetFixture(label: string): SqliteEventStore {
  const path = label.replace(/[^\w.-]/gu, "_");
  const root = mkdtempSync(join(tmpdir(), `moe-settle-${path}-`));
  scratchRoots.push(root);
  return openHarnessStore(join(root, "project.db"));
}

/** Store-wide: a per-aggregate read would miss a write in a neighbouring aggregate. */
export const storeWideEventHorizon = (store: SqliteEventStore): bigint =>
  store.readEventHorizon();

const SETTLEMENT_CONTEXT = {
  commandId: "cmd-settle-1",
  correlationId: "corr-settle-1",
  decidedAt: DECIDED_AT,
  principalId: PRINCIPAL_ID,
} as const;

export const applySettlement = (
  store: SqliteEventStore,
  attemptRef: string,
): unknown => applyProviderUsageToBudget(store, {
  attemptRef,
  context: SETTLEMENT_CONTEXT,
  projectId: PROJECT_ID,
});