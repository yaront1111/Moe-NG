/**
 * A planted historical decision is reader-test state only. It never claims that production can
 * create an ALLOW decision today. This fixture writes the historical row at the event seam and
 * deliberately does not drive policy evaluation.
 */
import type { SqliteEventStore } from "@moe/store";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";

const ENCODER = new TextEncoder();
const HISTORICAL_POLICY_REF = "historical-policy-reader-allowance";
const HISTORICAL_PRINCIPAL_REF = "historical-principal-reader-only";
const HISTORICAL_DECISION_DIGEST = "a1".repeat(32);
const HISTORICAL_HOLD_DIGEST = "b1".repeat(32);

export const HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS =
  Date.parse("2025-01-01T00:00:00.000Z");

export function plantHistoricalPolicyAllowance(
  store: SqliteEventStore,
  projectId: string,
  evaluatedAtEpochMs: number,
): void {
  const aggregateId = policyAggregateId(projectId);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const ordinal = String(expectedVersion + 1);
  const commandId = `plant-historical-policy-allowance-${projectId}-${ordinal}`;
  const payload = {
    decision: "ALLOW",
    decisionDigest: HISTORICAL_DECISION_DIGEST,
    policyRef: HISTORICAL_POLICY_REF,
    principalId: HISTORICAL_PRINCIPAL_REF,
    sliceRef: HISTORICAL_POLICY_REF,
  };

  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(commandId),
    commandId,
    committedAt: new Date(evaluatedAtEpochMs).toISOString(),
    events: [{
      eventId: `${commandId}-PolicyEvaluated`,
      eventType: "PolicyEvaluated",
      payload: ENCODER.encode(JSON.stringify(payload)),
    }],
    expectedVersion,
  });
}

/**
 * Appends the historical reader shape with a non-allowing outcome.
 *
 * This exists only for the standing-hold tests: after the contained ALLOW event establishes a
 * reservation, the latest decision must stop allowing without claiming a production writer can
 * extend a stream containing reader-only history.
 */
export function plantHistoricalPolicyHold(
  store: SqliteEventStore,
  projectId: string,
  evaluatedAtEpochMs: number,
): void {
  const aggregateId = policyAggregateId(projectId);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const ordinal = String(expectedVersion + 1);
  const commandId = `plant-historical-policy-hold-${projectId}-${ordinal}`;
  const payload = {
    decision: "HOLD_UNKNOWN",
    decisionDigest: HISTORICAL_HOLD_DIGEST,
    policyRef: HISTORICAL_POLICY_REF,
    principalId: HISTORICAL_PRINCIPAL_REF,
    sliceRef: HISTORICAL_POLICY_REF,
  };

  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(commandId),
    commandId,
    committedAt: new Date(evaluatedAtEpochMs).toISOString(),
    events: [{
      eventId: `${commandId}-PolicyEvaluated`,
      eventType: "PolicyEvaluated",
      payload: ENCODER.encode(JSON.stringify(payload)),
    }],
    expectedVersion,
  });
}
