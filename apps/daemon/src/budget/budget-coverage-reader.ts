/**
 * THE BUDGETS/COVERAGE READER for the Foundation context matrix.
 *
 * CONSUMER: task-c320c34a848341838685e338db089262, whose DoD 1 requires a grep-nameable durable
 * reader for the matrix's "budgets/coverage" row and blocks while one is absent. This module is
 * that name. It exists as a thin facade rather than pointing the matrix straight at
 * `readCurrentBudgetLedger` for two reasons: the matrix needs ONE reader per row, and a matrix
 * consumer must not be handed the whole ledger fold — accounts, entries, head record, raw
 * reservations and settlements — when the row asks for the per-meter standing.
 *
 * IT DELEGATES AND NARROWS; IT NEVER RE-DERIVES. `budget-current-projection.ts` already owns
 * codec validation, ordering, replay/conservation and the tri-state coverage rule. Folding those
 * records a second time here would be a second arithmetic over the same units that agrees with
 * itself no matter what the ledger actually holds. Every served field below is copied verbatim
 * from one successful `readCurrentBudgetLedger` call.
 *
 * WHAT IS DELIBERATELY NOT AN INPUT, because each is a different seam wearing similar words:
 * the caller's request payload (never authority); the activation record's `budgetView` (a
 * per-attempt post-reservation SNAPSHOT, not the current standing); `ClaudeLaunchLimits`
 * (capture and timeout ceilings, not conserved budget); and the scheduler's `projectBudgetFact`
 * (a policy projection, withheld as a separate seam by this row's filing).
 *
 * UNKNOWN NEVER BECOMES EMPTY OR ZERO. A refusal carries NO success fields at all — an empty
 * `meters` array would assert "measured, and there is nothing", which is the one claim a reader
 * that could not read is forbidden to make. An accepted meter that nobody has measured keeps its
 * conserved buckets visible and withholds only the refundable CLAIM, as `null` and never `0`.
 *
 * THREE ATTRIBUTION LEVELS STAY DISTINCT: this module's own layer, the projection's verdict in
 * `upstream.code`/`upstream.layer`, and whatever deeper source the projection itself forwarded in
 * `upstream.sourceCode`/`upstream.sourceLayer`. Collapsing any two would make an active-graph
 * fault indistinguishable from a budget fault.
 *
 * TWO WORLDS ARE NOT YET REACHABLE and are pinned as gated pending cases in the suite rather than
 * seeded around: production-applied PARTIAL and measured-COMPLETE both require a settled record,
 * and `settleBudgetReservation` / `reconcileBudgetSettlement` have ZERO production callers at the
 * tree this landed on. They are task-a91e9fe2's to open.
 */

import type { SqliteEventStore } from "@moe/store";

import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import type { BudgetMeterProjection } from "./budget-current-projection.js";
import type { BudgetDurableBinding } from "./budget-ledger-contracts.js";

/**
 * MODULE-PRIVATE. The security boundary roster counts exported `*_LAYER`/`*_LAYERS` constants, and
 * this layer is an attribution label for one daemon-internal reader, not a boundary. Tests pin it
 * by its literal value, which is what a caller would see.
 */
const COVERAGE_LAYER = "BUDGET_COVERAGE_READER";

/**
 * The ONLY code this reader authors. Every other refusal it can return is the projection's own,
 * forwarded unrestamped — a thrown store fault is the single case where no lower layer reached a
 * verdict, so there is nothing to forward and this module must answer for itself.
 */
export const BUDGET_COVERAGE_CODES = Object.freeze([
  "BUDGET_COVERAGE_STORE_UNAVAILABLE",
] as const);

export type BudgetCoverageCode = (typeof BUDGET_COVERAGE_CODES)[number];

/** The projection's verdict, whole: its code and layer, plus any deeper source it carried. */
export interface BudgetCoverageUpstream {
  readonly code: string;
  readonly layer: string;
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
}

export interface BudgetCoverageServed {
  readonly ok: true;
  /** The budget aggregate the WRITER derived, verbatim from the projection. */
  readonly aggregateId: string;
  readonly binding: BudgetDurableBinding;
  readonly headVersion: number;
  readonly meters: readonly BudgetMeterProjection[];
}

export interface BudgetCoverageRefused {
  readonly ok: false;
  /** Unverifiable evidence confers nothing, so a refusal is always UNKNOWN. */
  readonly outcome: "UNKNOWN";
  readonly authority: "NONE";
  readonly code: string;
  readonly layer: typeof COVERAGE_LAYER;
  /** The projection's verdict, or NULL when no lower layer got far enough to reach one. */
  readonly upstream: BudgetCoverageUpstream | null;
  readonly detail: string;
}

export type BudgetCoverageResult = BudgetCoverageServed | BudgetCoverageRefused;

const refuse = (
  code: string, upstream: BudgetCoverageUpstream | null, detail: string,
): BudgetCoverageRefused =>
  Object.freeze({
    authority: "NONE" as const,
    code,
    detail,
    layer: COVERAGE_LAYER,
    ok: false as const,
    outcome: "UNKNOWN" as const,
    upstream,
  });

/**
 * Serves the durable current budget standing for one goal, or refuses in UNKNOWN.
 *
 * The read is delegated whole. A thrown store fault is caught here because the projection's own
 * preamble calls `store.readEvents` uncaught, and an exception escaping a READER would reach a
 * caller as a crash rather than as the absence of evidence it actually is. The detail is a fixed
 * sentence: a store's message can name a filesystem path and its corruption mode, and neither is
 * a caller's to see.
 */
export function readCurrentBudgetCoverage(
  store: SqliteEventStore, projectId: string, goalRef: string,
): BudgetCoverageResult {
  let current;
  try {
    current = readCurrentBudgetLedger(store, projectId, goalRef);
  } catch {
    return refuse(
      "BUDGET_COVERAGE_STORE_UNAVAILABLE", null,
      "the durable budget ledger could not be read",
    );
  }
  if (!current.ok) {
    // The projection's code UNRESTAMPED at the top level, and its whole verdict preserved in
    // `upstream`. Minting a code of this module's own here would claim it decided something it
    // only relayed, and would hide which layer answered.
    return refuse(current.code, Object.freeze({
      code: current.code,
      layer: current.layer,
      sourceCode: current.sourceCode,
      sourceLayer: current.sourceLayer,
    }), "the durable budget ledger refused to answer");
  }
  // COPIED, NOT RECOMPUTED. `meters`, `binding` and the identity pair are the projection's own
  // deep-frozen output; this reader adds no arithmetic and drops the surfaces the matrix row
  // does not ask for (accounts, entries, head, reservations, settlements, views).
  return Object.freeze({
    aggregateId: current.aggregateId,
    binding: current.binding,
    headVersion: current.headVersion,
    meters: current.meters,
    ok: true as const,
  });
}
