import type { ApprovalDecisionRecord } from "@moe/core";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import {
  POLICY_RISK_EVENT_TYPE,
  buildPolicyRiskRecord,
  policyRiskAggregateIdFor,
  policyRiskRefusal,
} from "../bootstrap/policy-risk-record.js";
import type {
  PolicyRiskLayer,
  PolicyRiskRecordCode,
  PolicyRiskWriterCode,
} from "../bootstrap/policy-risk-record.js";

/** One domain action shared by both approval transports and the policy.validate consumer. */
export const POLICY_RISK_APPROVAL_ACTION = "plan.approve" as const;

export interface PolicyRiskSubject {
  readonly subjectRef: string;
  readonly subjectRevision: number;
}

export interface PolicyRiskLegInput {
  readonly actionKind: string;
  readonly approval: ApprovalDecisionRecord;
  readonly approvedBy: string | null;
  readonly assessedAt: string;
  readonly commandId: string;
  readonly projectId: string;
  readonly subject: PolicyRiskSubject | null;
}

export interface PolicyRiskLegAccepted {
  readonly leg: ExpectedVersionDecisionLeg;
  readonly ok: true;
}

export interface PolicyRiskLegRefused {
  readonly code: PolicyRiskRecordCode | PolicyRiskWriterCode;
  readonly layer: PolicyRiskLayer;
  readonly ok: false;
}

export type PolicyRiskLegResult = PolicyRiskLegAccepted | PolicyRiskLegRefused;

function actorAccepted(input: PolicyRiskLegInput): boolean {
  return input.approvedBy !== null
    && input.approval.actorKind === "HUMAN"
    && input.approval.truthClass === "HUMAN_APPROVED"
    && input.approval.actor === input.approvedBy;
}

function writerRefusal(code: PolicyRiskWriterCode): PolicyRiskLegRefused {
  return policyRiskRefusal(code);
}

export function buildPolicyRiskLeg(
  store: SqliteEventStore,
  input: PolicyRiskLegInput,
): PolicyRiskLegResult {
  if (!actorAccepted(input)) return writerRefusal("POLICY_RISK_ACTOR_NOT_HUMAN");
  if (input.approval.policyDecisionRef === null) {
    return writerRefusal("POLICY_RISK_DECISION_REF_MISSING");
  }
  if (input.approval.stepUpAuthRef === null) {
    return writerRefusal("POLICY_RISK_STEP_UP_MISSING");
  }
  if (!("riskTier" in input.approval) || input.approval.riskTier === undefined) {
    return writerRefusal("POLICY_RISK_TIER_MISSING");
  }
  if (input.subject === null || input.subject.subjectRevision < 1) {
    return writerRefusal("POLICY_RISK_SUBJECT_UNAVAILABLE");
  }
  const record = buildPolicyRiskRecord({
    actionKind: input.actionKind,
    approvedBy: input.approvedBy,
    assessedAt: input.assessedAt,
    decisionRef: input.approval.policyDecisionRef,
    projectId: input.projectId,
    subjectRef: input.subject.subjectRef,
    subjectRevision: input.subject.subjectRevision,
    tier: input.approval.riskTier,
  });
  if (!record.ok) return record;
  const aggregateId = policyRiskAggregateIdFor(record.record);
  return Object.freeze({
    leg: Object.freeze({
      aggregateId,
      events: Object.freeze([Object.freeze({
        eventId: `${input.commandId}-${POLICY_RISK_EVENT_TYPE}`,
        eventType: POLICY_RISK_EVENT_TYPE,
        payload: record.bytes,
      })]),
      expectedVersion: store.getAggregateVersion(aggregateId),
    }),
    ok: true as const,
  });
}

export interface PolicyRiskLegRequest {
  readonly approval: ApprovalDecisionRecord;
  /**
   * The SERVER-MINTED human witness's principal, never `approval.actor` and never
   * `request.principalId`. A transport that cannot prove a human authenticated THIS request hands
   * in `null` and the builder refuses `POLICY_RISK_ACTOR_NOT_HUMAN`.
   */
  readonly approvedBy: string | null;
  readonly commandId: string;
  readonly decidedAt: string;
  readonly projectId: string;
  readonly subject: PolicyRiskSubject | null;
}

/**
 * APPEND THE RISK LEG TO A DECISION THAT IS ALREADY GOING TO COMMIT, or return the legs unchanged.
 *
 * WHY A REFUSAL IS SILENT HERE AND NOWHERE ELSE. A human approving a plan must not be blocked by
 * the absence of a risk tier, an unauthenticated transport, or a subject that is not yet readable
 * — those are reasons to record NO risk authority, not reasons to refuse the approval. The record
 * side stays fail-closed regardless: a consumer that finds no record keeps answering UNKNOWN.
 *
 * ATOMICITY IS THE CALLER'S SHAPE, NOT A PROMISE MADE HERE. The leg is appended to the SAME
 * `commitAcceptedLegs` array the approval already rides, so a failure or version race commits
 * neither and a replay writes neither twice. Composing this into a second write would break both.
 */
export function withPolicyRiskLeg(
  store: SqliteEventStore,
  legs: readonly ExpectedVersionDecisionLeg[],
  request: PolicyRiskLegRequest,
): readonly ExpectedVersionDecisionLeg[] {
  const built = buildPolicyRiskLeg(store, {
    actionKind: POLICY_RISK_APPROVAL_ACTION,
    approval: request.approval,
    approvedBy: request.approvedBy,
    assessedAt: request.decidedAt,
    commandId: request.commandId,
    projectId: request.projectId,
    subject: request.subject,
  });
  return built.ok ? [...legs, built.leg] : legs;
}
