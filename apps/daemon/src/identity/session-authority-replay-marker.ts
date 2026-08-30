/**
 * Pure replay-marker decision material plus its durable observation consumer.
 * The builder is the sole producer of SessionAuthorityReplayObserved bytes.
 */

import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import { SESSION_AUTHORITY_SCHEMA_VERSION } from "./session-authority-contracts.js";
import type { ReplayReceipt } from "./session-authority-contracts.js";
import { commitAuthorityDecisionLegs, jsonBytes } from "./session-authority-decision.js";
import { isSessionDigest } from "./session-authority-protocol.js";

export type ReplayObservation =
  | Readonly<{ outcome: "FRESH"; receipt: ReplayReceipt }>
  | Readonly<{ outcome: "REPLAYED" }>
  | Readonly<{ outcome: "UNKNOWN" }>;

export interface ReplayMarker {
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly replayDigest: string;
}

export interface ReplayMarkerDecisionPlan {
  readonly commandId: string;
  readonly commandKind: "OBSERVE_REPLAY";
  readonly correlationId: string;
  readonly leg: ExpectedVersionDecisionLeg;
  readonly requestFacts: Readonly<Record<string, unknown>>;
  readonly resultFacts: Readonly<Record<string, unknown>>;
}

const REPLAYED = Object.freeze({ outcome: "REPLAYED" as const });
const UNKNOWN_REPLAY = Object.freeze({ outcome: "UNKNOWN" as const });

export function replayAggregateId(replayDigest: string): string {
  return `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${replayDigest}`;
}

export function buildReplayMarkerDecisionLeg(
  marker: ReplayMarker,
): ReplayMarkerDecisionPlan | null {
  const { replayDigest } = marker;
  if (!isSessionDigest(replayDigest)) return null;
  const commandId = `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${replayDigest}`;
  const event = Object.freeze({
    domainSchemaVersion: SESSION_AUTHORITY_SCHEMA_VERSION,
    eventId: `${commandId}/SessionAuthorityReplayObserved`,
    eventType: "SessionAuthorityReplayObserved",
    payload: jsonBytes({ replayDigest }),
  });
  const leg: ExpectedVersionDecisionLeg = Object.freeze({
    aggregateId: replayAggregateId(replayDigest),
    events: Object.freeze([event]),
    expectedVersion: 0,
  });
  return Object.freeze({
    commandId,
    commandKind: "OBSERVE_REPLAY" as const,
    correlationId: `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay`,
    leg,
    requestFacts: Object.freeze({ kind: "OBSERVE_REPLAY", replayDigest }),
    resultFacts: Object.freeze({ observed: true, replayDigest }),
  });
}

/**
 * Burns the hashed replay identity at expected version 0. Only the digest is
 * persisted, so the presented nonce never reaches an event, a result, or an id.
 */
export function observeReplayMarker(
  store: SqliteEventStore,
  marker: ReplayMarker,
): ReplayObservation {
  const plan = buildReplayMarkerDecisionLeg(marker);
  if (plan === null) return UNKNOWN_REPLAY;
  const outcome = commitAuthorityDecisionLegs(store, {
    commandId: plan.commandId,
    commandKind: plan.commandKind,
    correlationId: plan.correlationId,
    decidedAt: marker.decidedAt,
    principalId: marker.principalId,
    projectId: marker.projectId,
    requestFacts: plan.requestFacts,
    resultFacts: plan.resultFacts,
  }, [plan.leg]);
  if (!outcome.ok) {
    return outcome.code === "EXPECTED_VERSION_CONFLICT" ? REPLAYED : UNKNOWN_REPLAY;
  }
  if (outcome.disposition === "REPLAYED") return REPLAYED;
  const decision = outcome.decision;
  const eventId = decision.businessEventIds[0];
  if (decision.previousVersion !== 0 || decision.currentVersion !== 1) return UNKNOWN_REPLAY;
  if (eventId === undefined) return UNKNOWN_REPLAY;
  const receipt: ReplayReceipt = Object.freeze({
    aggregateId: decision.targetAggregateId,
    eventId,
    committedAt: decision.decidedAt,
    previousVersion: 0 as const,
    currentVersion: 1 as const,
    replayDigest: marker.replayDigest,
  });
  return Object.freeze({ outcome: "FRESH" as const, receipt });
}
