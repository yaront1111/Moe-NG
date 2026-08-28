import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import { graphRevisionAggregateId } from "./active-graph-projection.js";

export const ACTIVE_GRAPH_SLOT_EVENT_TYPE = "ActiveGraphSlotAdvanced" as const;

export interface ActiveGraphSlotObservation {
  readonly aggregateId: string;
  readonly version: number;
}

export interface ActiveGraphSlotLegInput {
  readonly commandId: string;
  readonly graphEpoch: number;
  readonly observed: ActiveGraphSlotObservation;
  readonly projectId: string;
  readonly reason: "ACTIVATE" | "SUPERSEDE";
  readonly revisionId: string;
}

const encoder = new TextEncoder();

/**
 * The project slot turns the pre-transaction active-graph scan into a store fence: writers that
 * observed the same version contend on one APPEND leg, so the store rejects the stale decision
 * without business residue. Its id deliberately sits outside `graph-revision:<project>:` because
 * graph readers replay every member of that prefix, and outside `moe-internal:` because the store
 * reserves that namespace for its own receipts and rejection audit.
 */
export function activeGraphSlotAggregateId(projectId: string): string {
  return `active-graph-slot:${projectId}`;
}

export function observeActiveGraphSlot(
  store: SqliteEventStore,
  projectId: string,
): ActiveGraphSlotObservation {
  const aggregateId = activeGraphSlotAggregateId(projectId);
  return Object.freeze({ aggregateId, version: store.getAggregateVersion(aggregateId) });
}

export function buildActiveGraphSlotLeg(
  input: ActiveGraphSlotLegInput,
): ExpectedVersionDecisionLeg {
  const revisionAggregateId = graphRevisionAggregateId(input.projectId, input.revisionId);
  return Object.freeze({
    aggregateId: input.observed.aggregateId,
    events: [Object.freeze({
      eventId: `${input.commandId}-slot`,
      eventType: ACTIVE_GRAPH_SLOT_EVENT_TYPE,
      payload: encoder.encode(JSON.stringify({
        graphEpoch: input.graphEpoch,
        reason: input.reason,
        revisionAggregateId,
        revisionId: input.revisionId,
      })),
    })],
    expectedVersion: input.observed.version,
  });
}
