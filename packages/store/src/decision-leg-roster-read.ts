import type { StatementSync } from "node:sqlite";

import {
  DECISION_LEG_ROSTER_VERSION,
  DecisionLedgerIntegrityError,
  identifyDecisionLegRoster,
  snapshotDecisionLegRoster,
} from "./decision-leg-roster.js";
import type { DecisionLegRoster } from "./decision-leg-roster.js";
import { DurableStoreError } from "./store-contracts.js";
import type { StoredReceipt } from "./store-internals.js";
import {
  requireNullableStoredIdentifier,
  requireRowString,
  requireStoredIdentifier,
  requireStoredIntegerAtLeast,
  requireStoredSha256,
} from "./store-rows.js";

const ROSTER_QUERY = `
  SELECT decision_id, roster_version, leg_count, roster_sha256
  FROM command_decision_leg_rosters
  WHERE decision_id = ?
` as const;

const LEGS_QUERY = `
  SELECT
    decision_id, leg_index, aggregate_id, expected_version,
    receipt_command_id, receipt_request_sha256, receipt_effect_sha256
  FROM command_decision_legs
  WHERE decision_id = ?
  ORDER BY leg_index
` as const;

export interface DecisionLegRosterReadContext {
  readonly prepare: (sql: string) => StatementSync;
  readonly loadReceipt: (
    commandId: string,
    validateAggregateTail?: boolean,
    liveBindingAlreadyValidated?: boolean,
  ) => StoredReceipt | null;
}

function nullableSha256(row: Record<string, unknown>, column: string): string | null {
  return row[column] === null ? null : requireStoredSha256(row, column);
}

function loadRoster(
  ctx: DecisionLegRosterReadContext,
  decisionId: string,
  liveBindingAlreadyValidated: boolean,
): DecisionLegRoster {
  const summary = ctx.prepare(ROSTER_QUERY).get(decisionId);
  if (summary === undefined) throw new DecisionLedgerIntegrityError();
  if (requireStoredSha256(summary, "decision_id") !== decisionId) {
    throw new DecisionLedgerIntegrityError();
  }
  const version = requireRowString(summary, "roster_version");
  const count = requireStoredIntegerAtLeast(summary, "leg_count", 1);
  const expectedSha256 = requireStoredSha256(summary, "roster_sha256");
  const rows = ctx.prepare(LEGS_QUERY).all(decisionId);
  const roster = snapshotDecisionLegRoster({
    version,
    decisionId,
    count,
    legs: rows.map((row) => {
      if (requireStoredSha256(row, "decision_id") !== decisionId) {
        throw new DecisionLedgerIntegrityError();
      }
      return {
        aggregateId: requireStoredIdentifier(row, "aggregate_id"),
        expectedVersion: requireStoredIntegerAtLeast(row, "expected_version", 0),
        index: requireStoredIntegerAtLeast(row, "leg_index", 0),
        receiptCommandId: requireNullableStoredIdentifier(row, "receipt_command_id"),
        receiptEffectSha256: nullableSha256(row, "receipt_effect_sha256"),
        receiptRequestSha256: nullableSha256(row, "receipt_request_sha256"),
      };
    }),
  });
  if (
    roster.version !== DECISION_LEG_ROSTER_VERSION ||
    identifyDecisionLegRoster(roster) !== expectedSha256
  ) {
    throw new DecisionLedgerIntegrityError();
  }
  for (const leg of roster.legs) {
    if (leg.receiptCommandId === null) continue;
    const receipt = ctx.loadReceipt(
      leg.receiptCommandId,
      true,
      liveBindingAlreadyValidated,
    );
    if (
      receipt === null ||
      receipt.commandId !== leg.receiptCommandId ||
      receipt.aggregateId !== leg.aggregateId ||
      receipt.previousVersion !== leg.expectedVersion ||
      receipt.requestSha256 !== leg.receiptRequestSha256 ||
      receipt.effectSha256 !== leg.receiptEffectSha256
    ) {
      throw new DecisionLedgerIntegrityError();
    }
  }
  return roster;
}

export function loadVerifiedDecisionLegRoster(
  ctx: DecisionLegRosterReadContext,
  decisionId: string,
  liveBindingAlreadyValidated = false,
): DecisionLegRoster {
  try {
    return loadRoster(ctx, decisionId, liveBindingAlreadyValidated);
  } catch (error) {
    if (error instanceof DecisionLedgerIntegrityError) throw error;
    if (error instanceof DurableStoreError && error.code !== "STORE_CORRUPT") throw error;
    throw new DecisionLedgerIntegrityError();
  }
}
