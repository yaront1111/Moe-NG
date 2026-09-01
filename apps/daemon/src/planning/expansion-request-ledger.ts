/**
 * The strict durable reader for the relation between one ACTIVE expansion hold and the EXPANSION
 * PlanningRun bound to it. The atomic writer that satisfies it lives in
 * `expansion-request-commit.ts`; this module never writes.
 *
 * WHY THE SECONDARY LEG IS READ FROM STORE EVENTS. `readDurableLedger` materialises only the
 * PRIMARY leg's decision target (`bootstrap-ledger.ts:203-224` records `decision.targetAggregateId`
 * and nothing else), so a `stateOf` lookup of the run aggregate returns `undefined` AFTER a
 * successful two-leg commit. A reader built on it would report a permanent one-sided SPLIT for
 * every healthy pair. Both legs are therefore read through `SqliteEventStore.readEvents`.
 *
 * WHAT MAKES THE SELECTION UNIQUE. The project is structural — it is inside the aggregate-id
 * prefix, so another project's holds are not merely filtered out, they are unreachable. Within
 * one project the tuple (parent node, parent run, planning run, generation, graph epoch) selects;
 * lifecycle, hold version and the run leg's own `goalRef` are then CHECKED rather than selected
 * on, so a terminal hold refuses TERMINAL and a moved version refuses STALE instead of both
 * collapsing into ABSENT. Selecting on a value is how a refusal loses its reason.
 *
 * BOTH SPLIT DIRECTIONS ARE REAL. A hold with no run leg and a run leg with no hold are distinct
 * worlds a crash between two single-aggregate commits would produce; the whole point of
 * `expansion-request-commit.ts` is that neither is reachable, so the reader must name them.
 *
 * NO REFUSAL CARRIES A FACT. Every refusal is code, layer and delegated provenance — never a
 * partial hold, a version, or a run. Unverifiable evidence must not become usable evidence.
 */

import type { SqliteEventStore, StoredEvent } from "@moe/store";
import type { ExpansionPlanningHoldState, PlanningRunContractState } from "@moe/core";

import { expansionRequestRefusal } from "./expansion-request-contracts.js";
import type { ExpansionRequestRefusal } from "./expansion-request-contracts.js";
import {
  EXPANSION_HOLD_EVENT_TYPE,
  EXPANSION_RUN_EVENT_TYPE,
  decodeExpansionHoldRecord,
  decodeExpansionRunRecord,
  expansionHoldAggregateId,
  expansionHoldAggregatePrefix,
} from "./expansion-request-records.js";
import type { ExpansionRunRecord } from "./expansion-request-records.js";

export interface ExpansionRequestSelector {
  readonly generation: number;
  readonly goalRef: string;
  readonly graphEpoch: number;
  readonly holdVersion: number;
  readonly parentNodeRef: string;
  readonly parentRunRef: string;
  readonly planningRunRef: string;
  readonly projectId: string;
}

export interface ExpansionRequestPair {
  readonly hold: ExpansionPlanningHoldState;
  readonly holdAggregateId: string;
  readonly run: PlanningRunContractState;
}

export type ExpansionRequestPairResult =
  | { readonly ok: true; readonly pair: ExpansionRequestPair }
  | ExpansionRequestRefusal;

function lastOfType(events: readonly StoredEvent[], eventType: string): StoredEvent | undefined {
  return events.filter((event) => event.eventType === eventType).at(-1);
}

/**
 * The run aggregate is keyed by `runId` alone — the shape `planning-services.ts` already
 * writes — so, unlike the hold, its id carries no project. Ownership therefore comes from the
 * durable decision trace the store stamps on the event. A run leg belonging to another
 * project is not this project's orphan and must not be read as one.
 */
function runLegOf(
  store: SqliteEventStore, planningRunRef: string, projectId: string,
): ExpansionRunRecord | null | undefined {
  const owned = store.readEvents(planningRunRef).filter(
    (event) => event.decisionTrace !== undefined && event.decisionTrace.projectId === projectId,
  );
  const event = lastOfType(owned, EXPANSION_RUN_EVENT_TYPE);
  return event === undefined ? undefined : decodeExpansionRunRecord(event.payload);
}

function selects(hold: ExpansionPlanningHoldState, selector: ExpansionRequestSelector): boolean {
  return hold.parentNodeRef === selector.parentNodeRef
    && hold.parentRunRef === selector.parentRunRef
    && hold.planningRunRef === selector.planningRunRef
    && hold.generation === selector.generation
    && hold.graphEpoch === selector.graphEpoch;
}

/** The run leg's binding must describe the SAME hold, member by member. */
function bindingAgrees(record: ExpansionRunRecord, hold: ExpansionPlanningHoldState): boolean {
  const binding = record.state.runKind === "EXPANSION" ? record.state.expansion : undefined;
  return binding !== undefined
    && binding.holdId === hold.holdId
    && binding.generation === hold.generation
    && binding.graphEpoch === hold.graphEpoch
    && binding.parentNodeRef === hold.parentNodeRef
    && binding.parentRunRef === hold.parentRunRef
    && binding.proposalBaseHash === hold.proposalBaseHash
    && binding.sourceFingerprint === hold.sourceFingerprint
    && binding.workerHandoff.digest === hold.workerHandoff.digest
    && binding.workerHandoff.ref === hold.workerHandoff.ref;
}

interface Candidate {
  readonly aggregateId: string;
  readonly hold: ExpansionPlanningHoldState;
}

function collect(
  store: SqliteEventStore, selector: ExpansionRequestSelector,
): readonly Candidate[] | ExpansionRequestRefusal {
  const found: Candidate[] = [];
  for (const aggregateId of store.enumerateAggregateIdsByPrefix(
    expansionHoldAggregatePrefix(selector.projectId),
  )) {
    const event = lastOfType(store.readEvents(aggregateId), EXPANSION_HOLD_EVENT_TYPE);
    if (event === undefined) continue;
    const hold = decodeExpansionHoldRecord(event.payload);
    // A present-but-unreadable record fails the whole read. Skipping it would let corrupt bytes
    // hide behind a healthy sibling and report ABSENT for a hold that is very much there.
    if (hold === null) return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_MALFORMED");
    if (selects(hold, selector)) found.push({ aggregateId, hold });
  }
  return found;
}

/**
 * SPLIT means a run leg whose OWN binding names a hold that is not in the store — the world a
 * crash between two single-aggregate commits leaves behind. A run leg whose hold exists but does
 * not match the caller's tuple is not split: it is a selector that names no current pair, which
 * is ABSENT. Collapsing the two would report a healthy ledger as corrupt every time a caller
 * asked about a generation or epoch that had moved.
 */
function orphaned(
  store: SqliteEventStore,
  selector: ExpansionRequestSelector,
  runLeg: ExpansionRunRecord | null | undefined,
): boolean {
  if (runLeg === undefined) return false;
  if (runLeg === null) return true;
  const binding = runLeg.state.runKind === "EXPANSION" ? runLeg.state.expansion : undefined;
  if (binding === undefined) return true;
  const events = store.readEvents(
    expansionHoldAggregateId(selector.projectId, binding.holdId),
  );
  return lastOfType(events, EXPANSION_HOLD_EVENT_TYPE) === undefined;
}

/**
 * Selects the ONE current hold/run pair for a selector, or names exactly why there is none.
 * Deeply frozen and read-only: it opens nothing and repairs nothing.
 */
export function readCurrentExpansionRequest(
  store: SqliteEventStore,
  selector: ExpansionRequestSelector,
): ExpansionRequestPairResult {
  const collected = collect(store, selector);
  if (!Array.isArray(collected)) return collected as ExpansionRequestRefusal;
  const candidates = collected;
  if (candidates.length > 1) {
    return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_AMBIGUOUS");
  }
  const candidate = candidates[0];
  const runLeg = runLegOf(store, selector.planningRunRef, selector.projectId);
  if (candidate === undefined) return expansionRequestRefusal(orphaned(store, selector, runLeg)
    ? "EXPANSION_REQUEST_LEDGER_SPLIT" : "EXPANSION_REQUEST_LEDGER_ABSENT");
  if (candidate.hold.lifecycle !== "ACTIVE") {
    return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_TERMINAL");
  }
  if (candidate.hold.version !== selector.holdVersion) {
    return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_STALE");
  }
  if (runLeg === undefined) return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_SPLIT");
  if (runLeg === null) return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_MALFORMED");
  if (runLeg.state.goalRef !== selector.goalRef) {
    return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_FOREIGN");
  }
  if (!bindingAgrees(runLeg, candidate.hold)) {
    return expansionRequestRefusal("EXPANSION_REQUEST_LEDGER_CONFLICTING");
  }
  return Object.freeze({
    ok: true as const,
    pair: Object.freeze({
      hold: candidate.hold, holdAggregateId: candidate.aggregateId, run: runLeg.state,
    }),
  });
}

export { expansionHoldAggregateId };
