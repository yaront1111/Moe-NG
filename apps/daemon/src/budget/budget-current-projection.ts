/**
 * "What is the conserved budget position for this goal, and how much of it is actually
 * measured?" — answered from durable events only, in ONE pass over the ledger aggregate.
 *
 * THE FOLD IS NOT THIS MODULE'S. Account balances come from `@moe/scheduler`'s own
 * `replayBudgetLedger` over the concatenated entry stream, and the committed successor is then
 * cross-checked against that replay. A projection that added up buckets itself would be a
 * second implementation of the arithmetic, free to drift from the reducer that governs.
 *
 * COVERAGE IS PER METER, AND UNKNOWN IS NOT ZERO. A meter whose consumption nobody measured
 * carries no `refundable` number at all — `null`, not `0` — because a zero refund claim is a
 * claim, and the units behind it are real money. The conserved buckets stay visible at every
 * coverage: refusing to state a refund is not the same as hiding the position.
 *
 * EVERY DISAGREEMENT IS UNKNOWN WITH AN EXACT CODE. There is no path that answers from the
 * records that happened to decode.
 */

import { replayBudgetLedger } from "@moe/scheduler";
import type {
  BudgetAccountRecord,
  BudgetAuthorization,
  BudgetAvailableView,
  BudgetLedgerEntry,
  BudgetMeterBuckets,
  ReservationRecord,
  SettlementRecord,
} from "@moe/scheduler";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readBudgetBinding } from "./budget-durable-binding.js";
import { canonicalBudgetJson, decodeBudgetLedgerRecord } from "./budget-ledger-codec.js";
import {
  BUDGET_LEDGER_EVENT_TYPE,
  budgetProjectionRefusal,
  deriveBudgetAggregateId,
} from "./budget-ledger-contracts.js";
import type {
  BudgetDurableBinding, BudgetLedgerRecord, BudgetRefusal, SettledMeterSummary,
} from "./budget-ledger-contracts.js";

export interface BudgetMeterProjection {
  readonly meter: string;
  readonly coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  /** The conserved position. A durable fact at every coverage, because units do not vanish. */
  readonly buckets: BudgetMeterBuckets;
  readonly measuredCount: number;
  readonly openHoldCount: number;
  /**
   * Units provably not consumed and therefore returnable. NULL unless coverage is COMPLETE:
   * a meter whose consumption nobody measured has no refundable number, and `0` is a number.
   */
  readonly refundable: number | null;
}

export interface BudgetCurrentProjection {
  readonly ok: true;
  readonly accounts: readonly BudgetAccountRecord[];
  readonly aggregateId: string;
  readonly authorization: BudgetAuthorization;
  readonly binding: BudgetDurableBinding;
  readonly entries: readonly BudgetLedgerEntry[];
  readonly head: BudgetLedgerRecord;
  readonly headVersion: number;
  readonly meters: readonly BudgetMeterProjection[];
  readonly reservations: readonly ReservationRecord[];
  readonly settledMeters: readonly SettledMeterSummary[];
  readonly settlements: readonly SettlementRecord[];
  readonly views: readonly BudgetAvailableView[];
}

export type BudgetProjectionResult = BudgetCurrentProjection | BudgetRefusal;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

type Collected = { readonly records: readonly BudgetLedgerRecord[] } | { readonly refusal: BudgetRefusal };

/**
 * Decodes the whole aggregate in order and refuses anything that is not exactly one root
 * followed by contiguously sequenced successors bound to the SAME durable identity.
 */
function collect(events: readonly StoredEvent[], binding: BudgetDurableBinding): Collected {
  const records: BudgetLedgerRecord[] = [];
  for (const [index, event] of events.entries()) {
    if (event.eventType !== BUDGET_LEDGER_EVENT_TYPE) {
      return { refusal: budgetProjectionRefusal("BUDGET_PROJECTION_CORRUPT") };
    }
    const decoded = decodeBudgetLedgerRecord(event.payload);
    if (!decoded.ok) {
      return { refusal: budgetProjectionRefusal("BUDGET_PROJECTION_CORRUPT", decoded.code, "BUDGET_LEDGER") };
    }
    const record = decoded.record;
    if (record.binding.projectId !== binding.projectId || record.binding.goalRef !== binding.goalRef
      || record.binding.budgetAccountRef !== binding.budgetAccountRef
      || record.binding.ownerRef !== binding.ownerRef) {
      return { refusal: budgetProjectionRefusal("BUDGET_PROJECTION_SCOPE_FOREIGN") };
    }
    if (record.sequence !== index) {
      return { refusal: budgetProjectionRefusal("BUDGET_PROJECTION_VERSION_GAP") };
    }
    if ((record.transition === "ROOT_AUTHORIZED") !== (index === 0)) {
      return { refusal: budgetProjectionRefusal("BUDGET_PROJECTION_SPLIT_BRAIN") };
    }
    if (record.binding.graphRevisionRef !== binding.graphRevisionRef
      || record.binding.graphEpoch !== binding.graphEpoch) {
      return { refusal: budgetProjectionRefusal("BUDGET_PROJECTION_STALE_BINDING") };
    }
    records.push(record);
  }
  return { records };
}

const bucketsOf = (account: BudgetAccountRecord, views: readonly BudgetAvailableView[]): readonly BudgetMeterBuckets[] =>
  views.find((view) => view.accountId === account.accountId)?.meters ?? account.meters;

/**
 * Rolls the per-account buckets up per meter, taking the HOLD position where one exists. The
 * account fold does not model a reservation — units move between buckets of one account without
 * a movement entry — so the view is the more current statement of that account's distribution.
 */
function rollUp(
  accounts: readonly BudgetAccountRecord[], views: readonly BudgetAvailableView[],
): Map<string, BudgetMeterBuckets> {
  const totals = new Map<string, BudgetMeterBuckets>();
  for (const account of accounts) {
    for (const bucket of bucketsOf(account, views)) {
      const prior = totals.get(bucket.meter);
      totals.set(bucket.meter, prior === undefined ? { ...bucket } : {
        available: prior.available + bucket.available,
        committed: prior.committed + bucket.committed,
        meter: bucket.meter,
        quarantined: prior.quarantined + bucket.quarantined,
        reserved: prior.reserved + bucket.reserved,
      });
    }
  }
  return totals;
}

/**
 * The tri-state, meter by meter.
 *
 * An UNMEASURED hold — one still open, or one settled against a receipt that measured nothing —
 * is UNKNOWN. A lower bound or a written-off hold is PARTIAL: it is evidence, but not the whole
 * of it. Only a meter whose every hold resolved exactly is COMPLETE, and only COMPLETE states a
 * refundable number.
 *
 * PRUNED EVIDENCE COUNTS THROUGH THE SUMMARY. A SETTLED pair leaves the head
 * record at its terminal commit, and its measured lines survive only as the
 * record's `settledMeters` fold — added to `measuredCount` here. The verdict
 * triggers read the SURVIVING rows alone, which is exactly right: only SETTLED
 * pairs prune, and a SETTLED settlement can carry no UNKNOWN_HELD, LOWER_BOUND
 * or CONSERVATIVE_WRITE_OFF line, so nothing verdict-bearing ever leaves.
 */
function coverageOf(
  meter: string, reservations: readonly ReservationRecord[], settlements: readonly SettlementRecord[],
  settledMeters: readonly SettledMeterSummary[], buckets: BudgetMeterBuckets,
): BudgetMeterProjection {
  const settled = new Set(settlements.map((entry) => entry.reservationId));
  const openHoldCount = reservations.filter((entry) =>
    (entry.state === "RESERVED" || entry.state === "ACTIVATED")
    && !settled.has(entry.reservationId)
    && entry.lines.some((line) => line.meter === meter)).length;
  const lines = settlements.flatMap((entry) => entry.lines.filter((line) => line.meter === meter));
  const prunedMeasured = settledMeters.find((entry) => entry.meter === meter)?.measuredLineCount ?? 0;
  const measuredCount = prunedMeasured + lines.filter((line) =>
    line.disposition !== "UNKNOWN_HELD" && line.identity !== null).length;
  const coverage = lines.some((line) => line.disposition === "UNKNOWN_HELD") || openHoldCount > 0
    ? "UNKNOWN" as const
    : lines.some((line) => line.disposition === "LOWER_BOUND" || line.disposition === "CONSERVATIVE_WRITE_OFF")
      ? "PARTIAL" as const
      : "COMPLETE" as const;
  return {
    buckets, coverage, measuredCount, meter, openHoldCount,
    refundable: coverage === "COMPLETE" ? buckets.available : null,
  };
}

/** Reads the whole durable ledger for a goal in one pass, or refuses with an exact code. */
export function readCurrentBudgetLedger(
  store: SqliteEventStore, projectId: string, goalRef: string,
): BudgetProjectionResult {
  const bound = readBudgetBinding(store, projectId, goalRef);
  if (!bound.ok) return bound;
  const aggregateId = deriveBudgetAggregateId(projectId, bound.binding.budgetAccountRef);
  const events = store.readEvents(aggregateId);
  if (events.length === 0) return budgetProjectionRefusal("BUDGET_PROJECTION_ABSENT");
  const collected = collect(events, bound.binding);
  if ("refusal" in collected) return collected.refusal;
  const { records } = collected;
  const head = records[records.length - 1];
  const root = records[0];
  if (head === undefined || root === undefined) return budgetProjectionRefusal("BUDGET_PROJECTION_ABSENT");
  const entries = records.flatMap((record) => [...record.appended]);
  const replay = replayBudgetLedger(root.authorization, entries);
  if (!replay.ok) {
    const issue = replay.issues[0];
    return budgetProjectionRefusal(
      "BUDGET_PROJECTION_CONSERVATION_FAILED", issue?.code ?? null, "BUDGET_ACCOUNT",
    );
  }
  if (canonicalBudgetJson(replay.state.accounts) !== canonicalBudgetJson(head.accounts)) {
    return budgetProjectionRefusal("BUDGET_PROJECTION_CONSERVATION_FAILED");
  }
  const totals = rollUp(replay.state.accounts, head.views);
  return deepFreeze({
    accounts: replay.state.accounts,
    aggregateId,
    authorization: root.authorization,
    binding: bound.binding,
    entries,
    head,
    headVersion: events.length,
    meters: [...totals.keys()].sort().map((meter) =>
      coverageOf(meter, head.reservations, head.settlements, head.settledMeters,
        totals.get(meter) as BudgetMeterBuckets)),
    ok: true as const,
    reservations: head.reservations,
    settledMeters: head.settledMeters,
    settlements: head.settlements,
    views: head.views,
  });
}
