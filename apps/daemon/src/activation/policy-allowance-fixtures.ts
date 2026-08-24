/**
 * A planted historical decision is reader-test state only. It never claims that production can
 * create an ALLOW decision today. This fixture writes the historical row at the event seam and
 * deliberately does not drive policy evaluation.
 */
import type { JsonValue } from "@moe/contracts";
import { POLICY_SLICE_DIGEST_VERSION, derivePolicySliceDigest } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  POLICY_DECISION_DIGEST_VERSION,
  POLICY_EVALUATION_TIME_SOURCE,
  POLICY_EVALUATOR_VERSION,
  POLICY_EVALUATOR_VERSION_SOURCE,
  decisionDigestFor,
} from "../bootstrap/bootstrap-policy-authority.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";

const ENCODER = new TextEncoder();
const HISTORICAL_PRINCIPAL_REF = "historical-principal-reader-only";
const HISTORICAL_ACTION = "effect.activate";

export interface HistoricalPolicySubject {
  readonly action: string;
  readonly additionalAutoApprovalAction?: string;
  readonly graphNodeRevisionRefs: readonly string[];
  readonly policyRef: string;
  readonly principalId: string;
  readonly scope: readonly string[];
}

export function historicalPolicySliceRef(
  action: string, additionalAutoApprovalAction?: string,
): string {
  const autoApprovalOptIns = [{ action, tier: "R0" as const }];
  if (additionalAutoApprovalAction !== undefined) {
    autoApprovalOptIns.push({ action: additionalAutoApprovalAction, tier: "R0" });
  }
  const derived = derivePolicySliceDigest({
    autoApprovalOptIns, rules: [], sliceRef: "pending-historical-policy-slice",
  });
  if (!derived.ok) throw new Error(`historical policy slice refused: ${derived.code}`);
  return derived.digest;
}

const HISTORICAL_POLICY_REF = historicalPolicySliceRef(HISTORICAL_ACTION);

const DEFAULT_HISTORICAL_SUBJECT: HistoricalPolicySubject = Object.freeze({
  action: HISTORICAL_ACTION,
  graphNodeRevisionRefs: Object.freeze([]),
  policyRef: HISTORICAL_POLICY_REF,
  principalId: HISTORICAL_PRINCIPAL_REF,
  scope: Object.freeze([]),
});

export const HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS =
  Date.parse("2025-01-01T00:00:00.000Z");

function historicalPayload(
  projectId: string,
  evaluatedAtEpochMs: number,
  allowing: boolean,
  subject: HistoricalPolicySubject,
): JsonValue {
  const factId = allowing ? "historical-risk-r0" : "historical-risk-unknown";
  const truthClass = allowing ? "DAEMON_VERIFIED" : "UNKNOWN";
  const autoApprovalOptIns = [{ action: subject.action, tier: "R0" as const }];
  if (subject.additionalAutoApprovalAction !== undefined) {
    autoApprovalOptIns.push({ action: subject.additionalAutoApprovalAction, tier: "R0" });
  }
  const expectedPolicyRef = historicalPolicySliceRef(
    subject.action, subject.additionalAutoApprovalAction,
  );
  if (subject.policyRef !== expectedPolicyRef) {
    throw new Error("historical policy subject ref does not bind its slice content");
  }
  const evaluationInput = {
    action: subject.action,
    actor: subject.principalId,
    callerRiskHint: null,
    decisionDigest: "0".repeat(64),
    evaluatedAtEpochMs,
    evaluatorVersion: POLICY_EVALUATOR_VERSION,
    facts: [{ factId, tier: allowing ? "R0" : null, truthClass }],
    graphNodeRevisionRefs: [...subject.graphNodeRevisionRefs],
    policyRevisionRef: subject.policyRef,
    requiredFactIds: [],
    scope: [...subject.scope],
    sliceChain: [{ autoApprovalOptIns, rules: [], sliceRef: subject.policyRef }],
    waivers: [],
  };
  const { decisionDigest: _inputDigest, ...verifiedInput } = evaluationInput;
  // Deliberately literal historical outcome bytes. The strict production reader replays these
  // through today's evaluator; deriving this half with that same evaluator would make a breaking
  // evaluator change update both sides of the fixture and hide the compatibility failure.
  const verifiedOutcome = {
    action: subject.action,
    actor: subject.principalId,
    decision: allowing ? "ALLOW" : "HOLD_UNKNOWN",
    evaluatorVersion: POLICY_EVALUATOR_VERSION,
    graphNodeRevisionRefs: [...subject.graphNodeRevisionRefs],
    inputFacts: [{ factId, truthClass }],
    matchedRuleIds: [],
    obligations: [],
    policyRevisionRef: subject.policyRef,
    reasonCodes: allowing ? ["ALLOWED_BY_POLICY"] : ["RISK_TIER_UNCLASSIFIABLE"],
    riskAssessment: {
      callerRiskHint: null,
      computedTier: allowing ? "R0" : null,
      effectiveTier: allowing ? "R0" : null,
      usedFactIds: allowing ? [factId] : [],
    },
  };
  const decisionMaterial = {
    projectId,
    serverSources: {
      evaluationTimeSource: POLICY_EVALUATION_TIME_SOURCE,
      evaluatorVersionSource: POLICY_EVALUATOR_VERSION_SOURCE,
      policySliceDigestVersion: POLICY_SLICE_DIGEST_VERSION,
      waiverResolutionStatus: "RESOLVED_EMPTY",
    },
    verifiedInput,
    verifiedOutcome,
  };
  return {
    decision: verifiedOutcome.decision,
    decisionDigest: decisionDigestFor(decisionMaterial as unknown as JsonValue),
    decisionDigestVersion: POLICY_DECISION_DIGEST_VERSION,
    decisionMaterial,
    policyRef: subject.policyRef,
    principalId: subject.principalId,
    projectId,
    sliceRef: subject.policyRef,
  } as unknown as JsonValue;
}

export function plantHistoricalPolicyAllowance(
  store: SqliteEventStore,
  projectId: string,
  evaluatedAtEpochMs: number,
  subject: HistoricalPolicySubject = DEFAULT_HISTORICAL_SUBJECT,
): void {
  const aggregateId = policyAggregateId(projectId);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const ordinal = String(expectedVersion + 1);
  const commandId = `plant-historical-policy-allowance-${projectId}-${ordinal}`;
  const payload = historicalPayload(projectId, evaluatedAtEpochMs, true, subject);

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
  subject: HistoricalPolicySubject = DEFAULT_HISTORICAL_SUBJECT,
): void {
  const aggregateId = policyAggregateId(projectId);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const ordinal = String(expectedVersion + 1);
  const commandId = `plant-historical-policy-hold-${projectId}-${ordinal}`;
  const payload = historicalPayload(projectId, evaluatedAtEpochMs, false, subject);

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
