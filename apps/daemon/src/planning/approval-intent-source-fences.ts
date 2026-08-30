import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { activeGraphSlotAggregateId, observeActiveGraphSlot } from "./active-graph-slot.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";
import { runPolicyAggregateId } from "./run-policy-record.js";

/** The exact pre-read versions whose bytes authorize an intent approval. */
export interface ApprovalIntentSourceFenceSnapshot {
  readonly activeGraphSlotVersion: number;
  readonly planningAuthorityVersion: number;
  readonly planningRunVersion: number;
  readonly projectPolicyVersion: number;
  readonly runPolicyVersion: number;
}

function versionOf(store: SqliteEventStore, aggregateId: string): number {
  return store.getAggregateVersion(aggregateId);
}

/**
 * Observe BEFORE any source reader runs. A writer racing either before or after a read therefore
 * moves one of these versions and the store refuses the whole decision; no later observation can
 * bless bytes read from a different authority world.
 */
export function observeApprovalIntentSourceFences(
  store: SqliteEventStore,
  projectId: string,
  runId: string,
): ApprovalIntentSourceFenceSnapshot {
  const planningRunVersion = versionOf(store, runId);
  const planningAuthorityVersion = versionOf(store, planningAuthorityAggregateId(runId));
  const projectPolicyVersion = versionOf(store, policyAggregateId(projectId));
  const runPolicyVersion = versionOf(store, runPolicyAggregateId(runId));
  const activeGraph = observeActiveGraphSlot(store, projectId);
  return Object.freeze({
    activeGraphSlotVersion: activeGraph.version,
    planningAuthorityVersion,
    planningRunVersion,
    projectPolicyVersion,
    runPolicyVersion,
  });
}

function fence(aggregateId: string, expectedVersion: number): ExpectedVersionDecisionLeg {
  return Object.freeze({
    aggregateId,
    events: Object.freeze([]),
    expectedVersion,
  });
}

/** Fixed source roster; callers can supply no aggregate id and can append no event. */
export function buildApprovalIntentSourceFenceLegs(
  snapshot: ApprovalIntentSourceFenceSnapshot,
  projectId: string,
  runId: string,
): readonly ExpectedVersionDecisionLeg[] {
  return Object.freeze([
    fence(runId, snapshot.planningRunVersion),
    fence(planningAuthorityAggregateId(runId), snapshot.planningAuthorityVersion),
    fence(policyAggregateId(projectId), snapshot.projectPolicyVersion),
    fence(runPolicyAggregateId(runId), snapshot.runPolicyVersion),
    fence(activeGraphSlotAggregateId(projectId), snapshot.activeGraphSlotVersion),
  ]);
}
