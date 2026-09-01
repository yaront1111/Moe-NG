/**
 * The PURE half of a supersession preparation (task-32c1ba45): every current fact is read from a
 * durable reader, nothing is appended, nothing is activated, no transport is touched.
 *
 * THE REQUEST IS NEVER CONSULTED FOR A CURRENT FACT. It names a project, a goal and the approved
 * target it believes in; the target is COMPARED against `readApprovedPlan`'s own
 * `graphRevisionRef` and refused when it differs. Graph epoch, content hash, plan hash, budget
 * head, lineage set and finalization boundary all come from committed events.
 *
 * THE FACT HORIZON IS CAPTURED TWICE. Every consequence fact is re-read after the derivation and
 * compared digest-to-digest, so a fact that moved under the read becomes
 * `SUPERSESSION_CONSEQUENCE_CHANGED` with zero residue. The ledger's expected-version fences on
 * all three aggregates are the other half of that guarantee.
 *
 * DISPOSITION COVERAGE, MEASURED AND DISCLOSED. Preparation has no successor content and grants no
 * activation authority, so it records PARTIAL coverage over the durable-lineage digest. Supersede
 * time is the first point with two authenticated contents and therefore the only point that may
 * derive the exact literal-kind set and claim COMPLETE.
 */
import type { SqliteEventStore } from "@moe/store";

import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import { PLANNING_SUBMISSION_FINALIZED_EVENT_TYPE } from "./planning-authority-finalize.js";
import { readApprovedPlan } from "./planning-authority-reader.js";
import {
  PREPARATION_WINDOW_MS,
  bindPreparationGeneration,
  decodePreparationRequest,
  preparationAggregateId,
  refusePreparation,
} from "./supersession-preparation-contracts.js";
import type {
  SupersessionPreparationGeneration,
  SupersessionPreparationRefusal,
  SupersessionPreparationRequest,
} from "./supersession-preparation-contracts.js";
import { foldPreparationHistory, horizonDigestOf } from "./supersession-preparation-ledger.js";
import type {
  DispositionCoverage, PreparationHorizon,
} from "./supersession-preparation-ledger.js";
import { disposeLineages, enumerateGraphLineages } from "./supersession-preparation-lineages.js";

export interface PreparationProposal {
  readonly dispositionCoverage: DispositionCoverage;
  readonly expectedPreparationVersion: number;
  readonly generation: SupersessionPreparationGeneration;
  readonly horizon: PreparationHorizon;
  readonly lineageCount: number;
  readonly meterQuantity: number;
  readonly ok: true;
  readonly request: SupersessionPreparationRequest;
}

export type PreparationProposalResult = PreparationProposal | SupersessionPreparationRefusal;

const SERVICE = "SUPERSESSION_PREPARATION_SERVICE" as const;

/** The runner-proven finalization boundary, read off the run's own committed events. */
export function submissionFinalized(store: SqliteEventStore, runId: string): boolean {
  return store.readEvents(runId)
    .some((event) => event.eventType === PLANNING_SUBMISSION_FINALIZED_EVENT_TYPE);
}

interface CapturedFacts {
  readonly budgetHeadVersion: number;
  readonly finalized: boolean;
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly lineages: readonly string[];
  readonly planHash: string;
  readonly revisionId: string;
  readonly runId: string;
}

type CaptureResult = SupersessionPreparationRefusal
  | { readonly facts: CapturedFacts; readonly ok: true };

/** One pass over every durable reader. Called twice; the two digests are compared. */
function capture(
  store: SqliteEventStore, request: SupersessionPreparationRequest,
): CaptureResult {
  const active = readCurrentActiveGraph(store, request.projectId);
  if (!active.ok) {
    return refusePreparation("SUPERSESSION_PREPARATION_GRAPH_UNAVAILABLE", SERVICE,
      { code: active.code, layer: active.layer });
  }
  const plan = readApprovedPlan(store, request.projectId, request.goalRef);
  if (!plan.ok) {
    return refusePreparation("SUPERSESSION_PREPARATION_PLAN_UNAVAILABLE", SERVICE,
      { code: plan.code, layer: plan.layer });
  }
  if (plan.graphRevisionRef !== request.approvedTargetRevisionRef) {
    return refusePreparation("SUPERSESSION_PREPARATION_TARGET_FOREIGN", SERVICE);
  }
  if (!submissionFinalized(store, plan.runId)) {
    return refusePreparation("PLANNING_SUBMISSION_FINALIZING", SERVICE);
  }
  const budget = readCurrentBudgetLedger(store, request.projectId, request.goalRef);
  if (!budget.ok) {
    return refusePreparation("SUPERSESSION_PREPARATION_BUDGET_UNAVAILABLE", SERVICE,
      { code: budget.code, layer: budget.layer });
  }
  return {
    facts: {
      budgetHeadVersion: budget.headVersion,
      finalized: true,
      graphContentHash: active.graphContentHash,
      graphEpoch: active.graphEpoch,
      lineages: enumerateGraphLineages(store, request.projectId, active.provenance.aggregateId,
        active.content.snapshot.nodes.map((node) => node.nodeKey)),
      planHash: active.planHash,
      revisionId: active.revisionId,
      runId: plan.runId,
    },
    ok: true as const,
  };
}

interface Funding { readonly meter: string; readonly quantity: number }

/**
 * Funding AVAILABILITY, from the durable projection only. A meter whose coverage is not COMPLETE
 * states NO refundable number, so it can never back a hold — the fail-closed half. The hold is
 * CAPPED at what the projection says is refundable, so a preparation can never reserve authority
 * the ledger does not have. A ZERO cap is a legal hold: the delivered tree mints a zero-amount
 * genesis authorization (`budget-genesis-leg.ts:2`) and holding zero against it is exactly
 * honest; what must never happen is holding MORE than the ledger can refund.
 */
function fundingFor(
  store: SqliteEventStore, request: SupersessionPreparationRequest,
): Funding | null {
  const budget = readCurrentBudgetLedger(store, request.projectId, request.goalRef);
  if (!budget.ok) return null;
  for (const meter of budget.meters) {
    if (meter.coverage === "COMPLETE" && meter.refundable !== null) {
      return { meter: meter.meter, quantity: meter.refundable };
    }
  }
  return null;
}

/**
 * Derive one preparation proposal, or refuse with the exact code, layer and refusing service of
 * whatever answered. Never appends: the caller hands the proposal to the ledger, and a refusal
 * here leaves nothing durable behind.
 */
export function proposeSupersessionPreparation(
  store: SqliteEventStore, requestValue: unknown,
): PreparationProposalResult {
  const decoded = decodePreparationRequest(requestValue);
  if (!decoded.ok) return decoded;
  const { request } = decoded;

  const first = capture(store, request);
  if (!("facts" in first)) return first;
  if (first.facts.lineages.length === 0) {
    return refusePreparation("SUPERSESSION_PREPARATION_LINEAGE_EMPTY", SERVICE);
  }
  const funding = fundingFor(store, request);
  if (funding === null) {
    return refusePreparation("SUPERSESSION_PREPARATION_FUNDING_UNAVAILABLE", SERVICE);
  }
  const disposed = disposeLineages(first.facts.lineages);

  const history = foldPreparationHistory(
    store, preparationAggregateId(request.projectId, request.goalRef),
  );
  if (!history.ok) {
    return refusePreparation("SUPERSESSION_PREPARATION_HISTORY_UNVERIFIABLE", SERVICE,
      { code: history.code, layer: history.layer });
  }
  if (history.current !== null) {
    return refusePreparation("SUPERSESSION_PREPARATION_GENERATION_CURRENT", SERVICE);
  }

  // THE SECOND READ. Every consequence fact re-read at the end of the derivation; a digest that
  // moved means the world moved under us and nothing may be committed against the old one.
  const second = capture(store, request);
  if (!("facts" in second)) return second;
  const horizon: PreparationHorizon = horizonDigestOf({
    ...second.facts, coverage: disposed.coverage, dispositionDigest: disposed.digest,
    preparationVersion: history.version,
  });
  if (horizon.digest !== horizonDigestOf({
    ...first.facts, coverage: disposed.coverage, dispositionDigest: disposed.digest,
    preparationVersion: history.version,
  }).digest) {
    return refusePreparation("SUPERSESSION_CONSEQUENCE_CHANGED", SERVICE);
  }

  return Object.freeze({
    dispositionCoverage: disposed.coverage,
    expectedPreparationVersion: history.version,
    generation: bindPreparationGeneration({
      binding: {
        deadlineEpochMs: Date.parse(request.decidedAt) + PREPARATION_WINDOW_MS,
        factHorizonDigest: horizon.digest,
        generation: history.nextGeneration,
        goalRef: request.goalRef,
        targetRevisionRef: request.approvedTargetRevisionRef,
      },
      // The SAME `disposed.coverage` the horizon digest above already folded in, now also durable
      // on the record so `foldPreparationHistory` can hand it to `graph.supersede` (task-7eddd612).
      dispositionCoverage: disposed.coverage,
      dispositionDigest: disposed.digest,
      fencedLineages: second.facts.lineages,
      meter: funding.meter,
      quantity: funding.quantity,
    }),
    horizon,
    lineageCount: second.facts.lineages.length,
    meterQuantity: funding.quantity,
    ok: true as const,
    request,
  });
}
