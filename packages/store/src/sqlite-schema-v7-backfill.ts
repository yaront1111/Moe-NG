import type { DatabaseSync } from "node:sqlite";

import {
  buildDecisionLegRoster,
  persistDecisionLegRoster,
} from "./decision-leg-roster-persistence.js";
import type { DecisionLegAuthoritySource } from "./decision-leg-roster-persistence.js";
import { internalReceiptCommandId } from "./store-digests.js";
import {
  requireRowString,
  requireStoredIntegerAtLeast,
  requireStoredSha256,
} from "./store-rows.js";
import { LEG_RECEIPT_SEPARATOR } from "./store-internals.js";
import { DurableStoreError } from "./store-contracts.js";

/**
 * Derives the v7 decision-leg rosters for a POPULATED v6 database.
 *
 * The v6 schema kept every fact this needs: a decision names its own primary
 * aggregate and expected version, its committed effect is the receipt row keyed by
 * the canonical internal receipt id, and each secondary leg is the receipt named
 * `<canonical>:leg:<index>`. So the roster is RE-DERIVED from surviving rows, never
 * invented: a decision whose evidence is incomplete is refused with
 * STORE_MIGRATION_REQUIRED and the whole v6->v7 step rolls back with it.
 *
 * ONE LIMIT, stated rather than hidden: a leg that committed no events wrote no
 * receipt, so v6 records neither its aggregate nor its position, and a TRAILING leg
 * lost that way is indistinguishable from a decision that never had it. Nothing in v6
 * totals legs or their events across a decision - business_event_count covers the
 * primary aggregate only (sqlite-schema-manifest.ts) - so no guard here could detect
 * it without inventing evidence. It is not reachable from a genuine v6 database either:
 * multi-leg decisions arrived WITH the v7 roster tables.
 *
 * No transaction is opened here. `bootstrapAndValidateSchema` already holds
 * BEGIN IMMEDIATE around the migration, so a throw leaves an intact v6 store, and a
 * nested transaction or a second connection would break exactly that guarantee.
 */

interface DecisionRow {
  readonly decisionId: string;
  readonly effectDisposition: string;
  readonly expectedVersion: number;
  readonly targetAggregateId: string;
}

interface ReceiptRow {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly effectSha256: string;
  readonly expectedVersion: number;
  readonly requestSha256: string;
}

/** Row values are decoded, never cast: a corrupt column must say so by its own name. */
function decisionRow(row: Record<string, unknown>): DecisionRow {
  return {
    decisionId: requireStoredSha256(row, "decision_id"),
    effectDisposition: requireRowString(row, "effect_disposition"),
    expectedVersion: requireStoredIntegerAtLeast(row, "expected_version", 0),
    targetAggregateId: requireRowString(row, "target_aggregate_id"),
  };
}

function receiptRow(row: Record<string, unknown>): ReceiptRow {
  return {
    aggregateId: requireRowString(row, "aggregate_id"),
    commandId: requireRowString(row, "command_id"),
    effectSha256: requireStoredSha256(row, "effect_sha256"),
    expectedVersion: requireStoredIntegerAtLeast(row, "expected_version", 0),
    requestSha256: requireStoredSha256(row, "request_sha256"),
  };
}

const SELECT_DECISIONS = `
  SELECT decision_id, effect_disposition, expected_version, target_aggregate_id
  FROM command_decisions
  ORDER BY decision_position
` as const;

const SELECT_RECEIPT = `
  SELECT aggregate_id, command_id, effect_sha256, expected_version, request_sha256
  FROM command_receipts
  WHERE command_id = ?
` as const;

/** Every leg receipt of one decision, in the order SQLite stores them, not sorted. */
const SELECT_LEG_RECEIPTS = `
  SELECT aggregate_id, command_id, effect_sha256, expected_version, request_sha256
  FROM command_receipts
  WHERE command_id LIKE ? ESCAPE '\\'
` as const;

function underivable(decisionId: string, reason: string): DurableStoreError {
  return new DurableStoreError(
    "STORE_MIGRATION_REQUIRED",
    `${decisionId}: ${reason}`,
  );
}

/** `_` and `%` in an internal receipt id would otherwise widen the LIKE pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

function receiptSource(row: ReceiptRow): DecisionLegAuthoritySource["receipt"] {
  return {
    commandId: row.commandId,
    effectSha256: row.effectSha256,
    requestSha256: row.requestSha256,
  } as DecisionLegAuthoritySource["receipt"];
}

function primaryLeg(database: DatabaseSync, decision: DecisionRow): DecisionLegAuthoritySource {
  const base = {
    aggregateId: decision.targetAggregateId,
    expectedVersion: decision.expectedVersion,
  };
  // A decision that committed nothing carries the all-null triple by definition, so
  // no receipt is looked up for it and none may be substituted.
  if (decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { ...base, receipt: null };
  }
  const canonical = internalReceiptCommandId(decision.decisionId);
  const row = database.prepare(SELECT_RECEIPT).get(canonical);
  if (row === undefined) {
    throw underivable(
      decision.decisionId,
      "an EFFECTS_COMMITTED decision has no command_receipts row for its canonical receipt",
    );
  }
  return { ...base, receipt: receiptSource(receiptRow(row)) };
}

/**
 * Secondary legs, keyed 1..k with no gaps. A gap means a receipt this database no
 * longer holds, and the roster's leg indices are load-bearing identity, so guessing
 * one would mint an aggregate binding the writer never produced.
 */
function secondaryLegs(
  database: DatabaseSync,
  decision: DecisionRow,
): readonly DecisionLegAuthoritySource[] {
  const canonical = internalReceiptCommandId(decision.decisionId);
  const prefix = `${canonical}${LEG_RECEIPT_SEPARATOR}`;
  const rows = database.prepare(SELECT_LEG_RECEIPTS).all(`${escapeLike(prefix)}%`);
  const byIndex = new Map<number, ReceiptRow>();
  for (const raw of rows) {
    const row = receiptRow(raw);
    const suffix = row.commandId.slice(prefix.length);
    if (!/^[1-9][0-9]*$/u.test(suffix)) {
      throw underivable(decision.decisionId, `leg receipt "${row.commandId}" has no leg index`);
    }
    const index = Number(suffix);
    if (byIndex.has(index)) {
      throw underivable(decision.decisionId, `leg index ${String(index)} appears twice`);
    }
    byIndex.set(index, row);
  }
  const legs: DecisionLegAuthoritySource[] = [];
  for (let index = 1; index <= byIndex.size; index += 1) {
    const row = byIndex.get(index);
    if (row === undefined) {
      throw underivable(
        decision.decisionId,
        `leg receipt indices are not contiguous: ${String(index)} is missing`,
      );
    }
    legs.push({
      aggregateId: row.aggregateId,
      expectedVersion: row.expectedVersion,
      receipt: receiptSource(row),
    });
  }
  return legs;
}

export function backfillDecisionLegRosters(database: DatabaseSync): void {
  const persistence = { prepare: (sql: string) => database.prepare(sql) };
  for (const raw of database.prepare(SELECT_DECISIONS).all()) {
    const decision = decisionRow(raw);
    const sources = [primaryLeg(database, decision), ...secondaryLegs(database, decision)];
    persistDecisionLegRoster(
      persistence,
      buildDecisionLegRoster(decision.decisionId, sources),
    );
  }
}
