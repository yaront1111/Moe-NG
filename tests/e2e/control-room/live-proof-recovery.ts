/**
 * DoD 2'S EVIDENCE, AND IT IS A STORE QUERY QUOTED WITH ITS RESULT.
 *
 * A LOG LINE IS NOT ADMISSIBLE HERE and the DoD says so explicitly: the log is written by the
 * process whose correctness is in question, so a line reading "recovered" proves only that
 * something felt recovered. Everything below is SQL against the durable store, quoted with its
 * parameters so a reader can re-run it against the same file.
 *
 * THE TWO CLAIMS THIS FILE MEASURES, and they are different claims:
 *
 *   1. EXACTLY ONE OUTCOME for the landing that was interrupted. Counted by COUNTING ROWS in
 *      `command_decisions`, never by observing that the world looks fine afterwards -- a
 *      DUPLICATE landing also looks fine, which is precisely why the count is the property.
 *      The kinds appear in the RESULT rather than in the WHERE clause, so a query cannot fail
 *      to notice a kind the write stopped emitting.
 *
 *   2. THE GOAL RESUMES. Measured as decisions committed on the goal's OWN execution refs
 *      STRICTLY AFTER the knob's recorded timestamp. The timestamp comes from the dying
 *      process's own note, not from this file's clock, so "after the crash" is anchored to the
 *      crash rather than to when anybody got round to asking.
 */
import { DatabaseSync } from "node:sqlite";

/** One grouped row of the ledger. `decisions` is a COUNT, which is the whole point. */
export interface LedgerRow {
  readonly aggregate: string;
  readonly decisions: number;
  readonly disposition: string;
  readonly kind: string;
}

/** One decision, in the order the store committed it. */
export interface DecisionRow {
  readonly aggregate: string;
  readonly decidedAt: string;
  readonly kind: string;
  readonly resultCode: string;
}

/**
 * THE LANDING LEDGER. Scoped to the two aggregate families a landing write touches and grouped
 * so the kinds and dispositions come back in the result.
 */
export const LANDING_LEDGER_SQL = [
  "SELECT target_aggregate_id AS aggregate, command_kind AS kind,",
  "       effect_disposition AS disposition, COUNT(*) AS decisions",
  "  FROM command_decisions",
  " WHERE target_aggregate_id LIKE 'repository-landing:%'",
  "    OR target_aggregate_id LIKE 'repository-landing-attempt:%'",
  " GROUP BY aggregate, kind, disposition",
  " ORDER BY aggregate, kind",
].join("\n");

/** EVERY decision on one aggregate, in commit order, so a duplicate cannot hide in a total. */
export const NODE_DECISIONS_SQL = [
  "SELECT target_aggregate_id AS aggregate, command_kind AS kind,",
  "       result_code AS code, decided_at AS decidedAt",
  "  FROM command_decisions",
  " WHERE target_aggregate_id = ?",
  " ORDER BY decision_position",
].join("\n");

/** What the store committed AFTER a given instant, which is how resumption is measured. */
export const RESUMED_AFTER_SQL = [
  "SELECT target_aggregate_id AS aggregate, command_kind AS kind,",
  "       result_code AS code, decided_at AS decidedAt",
  "  FROM command_decisions",
  " WHERE decided_at > ?",
  " ORDER BY decision_position",
].join("\n");

function query(storePath: string, sql: string, parameters: readonly string[]): Record<string, unknown>[] {
  const database = new DatabaseSync(storePath);
  try {
    return database.prepare(sql).all(...parameters) as Record<string, unknown>[];
  } finally { database.close(); }
}

const ledgerRows = (rows: readonly Record<string, unknown>[]): readonly LedgerRow[] =>
  rows.map((row) => ({
    aggregate: String(row["aggregate"]), decisions: Number(row["decisions"]),
    disposition: String(row["disposition"]), kind: String(row["kind"]),
  }));

const decisionRows = (rows: readonly Record<string, unknown>[]): readonly DecisionRow[] =>
  rows.map((row) => ({
    aggregate: String(row["aggregate"]), decidedAt: String(row["decidedAt"]),
    kind: String(row["kind"]), resultCode: String(row["code"]),
  }));

export interface RecoveryReading {
  /** Decisions on the interrupted node's own ref, in commit order. */
  readonly crashedNode: readonly DecisionRow[];
  /** How many LANDING outcomes the interrupted node's ref carries. One is the claim. */
  readonly crashedNodeLandings: number;
  readonly ledger: readonly LedgerRow[];
  /** The SQL and parameters of every query above, so the reading can be re-run. */
  readonly queries: readonly { readonly parameters: readonly string[]; readonly sql: string }[];
  /** Decisions committed on OTHER nodes' refs strictly after the crash instant. */
  readonly resumedNodes: readonly DecisionRow[];
  /** Every decision committed strictly after the crash instant, counted. */
  readonly resumedTotal: number;
}

/**
 * Reads the store three ways and answers what it found, with the SQL that found it.
 *
 * `landingKindSuffix` is matched against `command_kind` rather than hard-coded into the WHERE
 * clause for the same reason the ledger groups by kind: a landing that started committing under
 * a different kind must show up as a MISS here, not vanish from the filter.
 */
export function readRecoveryEvidence(options: {
  readonly crashAt: string;
  readonly crashedNodeRef: string;
  readonly landingKindSuffix: string;
  readonly otherNodeRefs: readonly string[];
  readonly storePath: string;
}): RecoveryReading {
  const ledger = ledgerRows(query(options.storePath, LANDING_LEDGER_SQL, []));
  const crashedNode = decisionRows(
    query(options.storePath, NODE_DECISIONS_SQL, [options.crashedNodeRef]));
  const after = decisionRows(query(options.storePath, RESUMED_AFTER_SQL, [options.crashAt]));
  return {
    crashedNode,
    crashedNodeLandings: crashedNode
      .filter((row) => row.kind.endsWith(options.landingKindSuffix)).length,
    ledger,
    queries: [
      { parameters: [], sql: LANDING_LEDGER_SQL },
      { parameters: [options.crashedNodeRef], sql: NODE_DECISIONS_SQL },
      { parameters: [options.crashAt], sql: RESUMED_AFTER_SQL },
    ],
    resumedNodes: after.filter((row) => options.otherNodeRefs.includes(row.aggregate)),
    resumedTotal: after.length,
  };
}
