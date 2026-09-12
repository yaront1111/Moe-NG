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

/** WHAT WAS NOT RECORDED, AND WHY. The identity of the decision plus the refusal that caused it. */
export interface PolicyRiskOmission {
  readonly actionKind: string;
  readonly code: PolicyRiskRecordCode | PolicyRiskWriterCode;
  readonly commandId: string;
  readonly layer: PolicyRiskLayer;
  readonly projectId: string;
}

export type PolicyRiskOmissionObserver = (omission: PolicyRiskOmission) => void;

/** The one wording, so an operator's grep and a test's expectation cannot drift apart. */
export function formatPolicyRiskOmission(omission: PolicyRiskOmission): string {
  return `policy-risk: no risk authority recorded for ${omission.actionKind}`
    + ` on ${omission.projectId} (command ${omission.commandId}):`
    + ` ${omission.code} @ ${omission.layer}`;
}

/**
 * THE DEFAULT SINK, so production is legible with no composition-root wiring at all. One line on
 * stderr is the house's diagnostic shape (`mcp-main.ts:161`, `project-stack-host-main.ts:169`).
 * An ABSENT observer falls back here and never to silence — an absent override is the ordinary
 * case, and restoring the silence for it would restore the whole defect.
 */
function writePolicyRiskOmissionLine(omission: PolicyRiskOmission): void {
  process.stderr.write(`${formatPolicyRiskOmission(omission)}\n`);
}

export interface PolicyRiskLegOutcome {
  readonly legs: readonly ExpectedVersionDecisionLeg[];
  /** The refusal that was DISCARDED before task-c7a66b70, or null when the leg built. */
  readonly refusal: PolicyRiskLegRefused | null;
}

/**
 * APPEND THE RISK LEG TO A DECISION THAT IS ALREADY GOING TO COMMIT, or return the legs unchanged
 * AND say which of the six refusals omitted it.
 *
 * WHY A REFUSAL DOES NOT BLOCK HERE AND NOWHERE ELSE. A human approving a plan must not be blocked
 * by the absence of a risk tier, an unauthenticated transport, or a subject that is not yet
 * readable — those are reasons to record NO risk authority, not reasons to refuse the approval.
 * The record side stays fail-closed regardless: a consumer that finds no record keeps answering
 * UNKNOWN. That reasoning is unchanged; what changed is that the omission is no longer SILENT.
 * "No risk authority was recorded, for reason X" is now distinguishable from "the writer ran and
 * everything was fine" — the gap that let task-510340a3's consumer bug sit behind a green suite.
 *
 * AND THE FIRST THING THE REPORT CORRECTED WAS THE BOARD. task-c7a66b70 was filed, planned and
 * once attempted on the belief that the ordinary journey refuses `POLICY_RISK_SUBJECT_UNAVAILABLE`
 * from an absent active graph. It does not: the sink prints `POLICY_RISK_DECISION_REF_MISSING`,
 * because `buildPolicyRiskLeg` tests `policyDecisionRef` at :63 and never reaches the subject at
 * :72 — the production approval record that `runApprovalIntentCommand` mints carries a null
 * `policyDecisionRef`. Three readers held the wrong cause for weeks and no gate could contradict
 * them, which is the entire argument for this row.
 *
 * WHY THE REPORT IS OFF-LEDGER RATHER THAN DURABLE, as a measured fact and not a preference. A
 * durable marker would be one more decision leg, and the ordinary plan approval already commits
 * EXACTLY 8 against a `MAX_DECISION_LEGS` of 8 (measured on task-c7a66b70 over the real journey:
 * goal, GENESIS budget root, the five `approval-intent-source-fences.ts:59-65` fences, the replay
 * marker). `packages/store/src/decision-legs-contracts.ts:3-9` documents that bound as deliberate
 * — every leg costs another version probe and another receipt inside one write transaction — so
 * the 9th throws `STORE_LIMIT_EXCEEDED` and turns this fail-OPEN approval into a hard failure.
 * There is zero spare budget on this path, and that, not indifference, is why the diagnosis is a
 * line rather than a record. Raising the cap is a store-wide concurrency decision, not this one's.
 *
 * REPORTING LIVES HERE, NOT IN THE CALLERS, so a third caller cannot reintroduce the silence by
 * forgetting to look at `refusal`. The callers supply `HandlerContext.policyRiskOmissions` when
 * they have one and read `refusal` for their own control flow.
 *
 * WHO READS THE NO-RECORD STATE, enumerated by grep over `apps/daemon/src` at task-c7a66b70 and
 * not inherited from any description. `readPolicyRisk` has exactly ONE production call site,
 * `policy-fact-resolver.ts:143` inside `resolvePolicyFact`; `resolvePolicyFact` in turn has
 * exactly ONE, `bootstrap-policy-services.ts:173`, for `policy.validate`'s caller-named action.
 * On the no-record state that chain answers `{tier: null, truthClass: "UNKNOWN"}` under a
 * `policy-risk-unclassifiable:sha256:` fact id and `assessRisk` folds it to HOLD_UNKNOWN — the
 * fail-closed behaviour this helper's fail-open is safe against, and it does not change here.
 * AUTOMATIC PREVIEW IS NO LONGER A READER: task-510340a3 moved it to `preview/preview-risk-fact.ts`
 * and `apps/daemon/src/preview/**` now contains zero calls to either symbol, only comments about
 * the path it left. Said explicitly because that stale belief has already been re-inherited once.
 *
 * ATOMICITY IS THE CALLER'S SHAPE, NOT A PROMISE MADE HERE. The leg is appended to the SAME
 * `commitAcceptedLegs` array the approval already rides, so a failure or version race commits
 * neither and a replay writes neither twice. Composing this into a second write would break both.
 */
export function withPolicyRiskLeg(
  store: SqliteEventStore,
  legs: readonly ExpectedVersionDecisionLeg[],
  request: PolicyRiskLegRequest,
  observer?: PolicyRiskOmissionObserver,
): PolicyRiskLegOutcome {
  const built = buildPolicyRiskLeg(store, {
    actionKind: POLICY_RISK_APPROVAL_ACTION,
    approval: request.approval,
    approvedBy: request.approvedBy,
    assessedAt: request.decidedAt,
    commandId: request.commandId,
    projectId: request.projectId,
    subject: request.subject,
  });
  if (built.ok) return Object.freeze({ legs: [...legs, built.leg], refusal: null });
  // THE LEG ARRAY IS NEVER WIDENED ON A REFUSAL — `legs` is handed back by identity, exactly as
  // the discarding `built.ok ? [...legs, built.leg] : legs` did. See the leg-ceiling note above.
  //
  // AND THE REPORT MUST NEVER BECOME THE BLOCK. A sink that throws — a destroyed stderr under a
  // detached daemon, an injected observer with a bug — would propagate out of a decision that is
  // mid-commit and turn this fail-OPEN approval into a hard failure. That is the same inversion
  // the leg ceiling would cause, arriving by a different door, and DoD 2 forbids both. Diagnosis
  // is best-effort BY CONSTRUCTION: there is nothing to escalate a failed log line to from here,
  // and the approval the human authorized must still commit.
  const omission = Object.freeze({
    actionKind: POLICY_RISK_APPROVAL_ACTION,
    code: built.code,
    commandId: request.commandId,
    layer: built.layer,
    projectId: request.projectId,
  });
  try {
    (observer ?? writePolicyRiskOmissionLine)(omission);
  } catch {
    // Swallowed deliberately; see above. The refusal still leaves the helper below.
  }
  return Object.freeze({ legs, refusal: built });
}
