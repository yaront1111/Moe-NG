import type { StatementSync } from "node:sqlite";

import {
  DECISION_LEG_ROSTER_VERSION,
  identifyDecisionLegRoster,
  snapshotDecisionLegRoster,
} from "./decision-leg-roster.js";
import type {
  DecisionLegRoster,
  DecisionLegRosterLeg,
} from "./decision-leg-roster.js";
import { DurableStoreError } from "./store-contracts.js";
import type { StoredCommitResult } from "./store-internals.js";

export interface DecisionLegAuthoritySource {
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly receipt: StoredCommitResult | null;
}

export interface StoredDecisionLegRosterIdentity {
  readonly legCount: number;
  readonly legRosterSha256: string;
  readonly legRosterVersion: typeof DECISION_LEG_ROSTER_VERSION;
}

export interface DecisionLegRosterPersistenceContext {
  readonly prepare: (sql: string) => StatementSync;
}

const INSERT_ROSTER = `
  INSERT INTO command_decision_leg_rosters (
    decision_id, roster_version, leg_count, roster_sha256
  ) VALUES (?, ?, ?, ?)
` as const;

const INSERT_LEG = `
  INSERT INTO command_decision_legs (
    decision_id, leg_index, aggregate_id, expected_version,
    receipt_command_id, receipt_request_sha256, receipt_effect_sha256
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
` as const;

export function buildDecisionLegRoster(
  decisionId: string,
  sources: readonly DecisionLegAuthoritySource[],
): DecisionLegRoster {
  const legs: DecisionLegRosterLeg[] = sources.map((source, index) => ({
    aggregateId: source.aggregateId,
    expectedVersion: source.expectedVersion,
    index,
    receiptCommandId: source.receipt?.commandId ?? null,
    receiptEffectSha256: source.receipt?.effectSha256 ?? null,
    receiptRequestSha256: source.receipt?.requestSha256 ?? null,
  }));
  return snapshotDecisionLegRoster({
    version: DECISION_LEG_ROSTER_VERSION,
    decisionId,
    count: legs.length,
    legs,
  });
}

export function persistDecisionLegRoster(
  ctx: DecisionLegRosterPersistenceContext,
  rawRoster: DecisionLegRoster,
): StoredDecisionLegRosterIdentity {
  const roster = snapshotDecisionLegRoster(rawRoster);
  const legRosterSha256 = identifyDecisionLegRoster(roster);
  const summary = ctx.prepare(INSERT_ROSTER).run(
    roster.decisionId,
    roster.version,
    roster.count,
    legRosterSha256,
  );
  if (summary.changes !== 1) {
    throw new DurableStoreError(
      "STORE_UNAVAILABLE",
      "SQLite did not persist the command decision leg roster",
    );
  }
  const insertLeg = ctx.prepare(INSERT_LEG);
  for (const leg of roster.legs) {
    const inserted = insertLeg.run(
      roster.decisionId,
      leg.index,
      leg.aggregateId,
      leg.expectedVersion,
      leg.receiptCommandId,
      leg.receiptRequestSha256,
      leg.receiptEffectSha256,
    );
    if (inserted.changes !== 1) {
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        "SQLite did not persist a command decision leg binding",
      );
    }
  }
  return {
    legCount: roster.count,
    legRosterSha256,
    legRosterVersion: roster.version,
  };
}
