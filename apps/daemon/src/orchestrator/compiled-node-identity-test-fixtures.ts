import type { GraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { putGraphBody } from "../planning/graph-body-record.js";

function record(store: SqliteEventStore, aggregateId: string, value: object): void {
  const version = store.getAggregateVersion(aggregateId);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const id = `identity-${aggregateId}-${String(version)}`;
  const result = store.commitExpectedVersionDecision({
    commandKind: "identity.fixture", committedResultBytes: bytes, correlationId: id,
    decidedAt: "2026-09-05T12:00:00.000Z", expectedVersion: version,
    events: [{ domainSchemaVersion: "identity-fixture/1", eventId: id, eventType: "IdentityFixture", payload: bytes }],
    key: { commandId: id, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: bytes, targetAggregateId: aggregateId,
  });
  if (result.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("history fixture refused");
}

/** Historical goal/run observations with real canonical graph storage; no live project state. */
export function recordHistoricalCompiledGraph(
  store: SqliteEventStore, plan: { readonly encoded: GraphContent; readonly goalRef: string; readonly planningRunRef: string },
  missingBody = false,
  finalLifecycle: "CANCELLED" | "EXECUTION_ENABLED" = "CANCELLED",
): void {
  if (!missingBody && !putGraphBody(store, PROJECT_ID, plan.encoded).ok) throw new Error("history graph refused");
  record(store, plan.planningRunRef, { state: {
    goalRef: plan.goalRef, graphRevisionRef: `revision-${plan.planningRunRef}`, lifecycle: "ACTIVATED",
    sealedHashes: { graphContentHash: plan.encoded.graphContentHash },
  } });
  const goal = { goalId: plan.goalRef, planningRunRef: plan.planningRunRef, projectId: PROJECT_ID };
  record(store, plan.goalRef, { ...goal, lifecycle: "EXECUTION_ENABLED" });
  record(store, plan.goalRef, { ...goal, lifecycle: finalLifecycle });
}
