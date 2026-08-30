import type { JsonObject } from "@moe/contracts";
import { validateApprovalRecord } from "@moe/core";
import type { ApprovalDecisionRecord } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import { replayOf, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type {
  DurableLedger,
  HandlerContext,
  HumanReviewWitness,
  ServiceOutcome,
  ServiceRefusedBy,
} from "../bootstrap/bootstrap-ledger.js";
import { activateInitialGraphWithApprovalReplay } from "./approval-activation.js";
import type { ActivationInput } from "./approval-activation.js";
import type { ApprovalIntent } from "./approval-intent.js";
import { APPROVAL_DECIDE_INTENT_COMMAND_KIND } from "./approval-intent-contracts.js";
import type { ApprovalIntentSourceFenceSnapshot }
  from "./approval-intent-source-fences.js";
import { readApprovalIntentSources } from "./approval-intent-sources.js";
import type { ApprovalIntentSources } from "./approval-intent-sources.js";
import { readApprovalRecordFacts } from "./approval-record-facts.js";
import type { ApprovalRecordFactsComplete } from "./approval-record-facts.js";
import { deriveStepUpAuthRef } from "./approval-step-up.js";

export interface IntentApprovalRecordInput {
  readonly facts: ApprovalRecordFactsComplete;
  readonly intent: ApprovalIntent;
  readonly sources: ApprovalIntentSources;
  readonly witness: HumanReviewWitness;
}

export interface IntentActivationRequest {
  readonly humanReview: HumanReviewWitness;
  readonly intent: ApprovalIntent;
  readonly projectId: string;
  readonly sourceFences: ApprovalIntentSourceFenceSnapshot;
}

export interface IntentActivationCommand {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  /** Authenticated envelope fact carried unchanged; goal authority is still server-derived. */
  readonly expectedVersion: number;
  readonly payload: JsonObject;
  readonly principalId: string;
  readonly projectId: string;
}

export type IntentActivationInput = ActivationInput & {
  readonly activation: ActivationInput["activation"] & {
    readonly expectedGoalVersion: number;
    readonly truthClass: "HUMAN_APPROVED";
  };
  readonly humanReview: HumanReviewWitness;
  readonly sourceFences: ApprovalIntentSourceFenceSnapshot;
};

export type IntentActivationAssembly =
  | Readonly<{ readonly input: IntentActivationInput; readonly ok: true }>
  | Readonly<{ readonly code: string; readonly layer: ServiceRefusedBy; readonly ok: false }>;

export const APPROVAL_INTENT_RECORD_INVALID = "APPROVAL_INTENT_RECORD_INVALID" as const;

const missingGoal = (): IntentActivationAssembly => Object.freeze({
  code: "BOOTSTRAP_PREREQUISITE_MISSING",
  layer: "DAEMON_PREREQUISITE",
  ok: false as const,
});

const invalidRecord = (): IntentActivationAssembly => Object.freeze({
  code: APPROVAL_INTENT_RECORD_INVALID,
  layer: "DAEMON_APPROVAL_INTENT",
  ok: false as const,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const entry = Object.getOwnPropertyDescriptor(value, key);
      if (entry !== undefined && "value" in entry) deepFreeze(entry.value);
    }
    Object.freeze(value);
  }
  return value;
}

const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = Object.getOwnPropertyDescriptor(value, key);
  return entry !== undefined && entry.enumerable && "value" in entry ? entry.value : undefined;
};

function durableGoalVersion(ledger: DurableLedger, goalId: string): number | null {
  const version = own(stateOf(ledger, goalId), "version");
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1
    ? version
    : null;
}

/** The validator snapshots all 18 fields; an undefined answer stays a daemon-seam refusal. */
export function composeIntentApprovalRecord(
  input: IntentApprovalRecordInput,
): ApprovalDecisionRecord | undefined {
  const { facts, intent, sources, witness } = input;
  const record = validateApprovalRecord({
    actor: witness.principalId,
    actorKind: "HUMAN",
    applicablePolicyRef: facts.applicablePolicyRef,
    approvalRef: sources.approvalRef,
    approvedNodeScope: sources.approvedNodeScope,
    budgetRef: facts.budgetRef,
    criteriaRef: sources.criteriaRef,
    decision: intent.decision,
    decisionReason: intent.decisionReason,
    dependencyChanges: intent.dependencyChanges,
    exactRevisionHash: sources.exactRevisionHash,
    lifecycle: "DECIDED",
    planQualityAssessmentRef: sources.planQualityAssessmentRef,
    policyDecisionRef: null,
    riskTier: facts.riskTier,
    stepUpAuthRef: facts.stepUpAuthRef,
    truthClass: "HUMAN_APPROVED",
    validity: "CURRENT",
  });
  return record === undefined ? undefined : deepFreeze(record);
}

/**
 * Re-reads the run binding/revision and the goal's domain version from durable state. The
 * activation deliberately has NO `budgetHash`: approval-activation.ts's claimed-hash fence says
 * an omitted expectation has nothing to contradict, while the durable hash remains the server's
 * computed budget-root digest either way. No caller activation bytes participate here.
 */
export function assembleActivationInput(
  store: SqliteEventStore,
  ledger: DurableLedger,
  request: IntentActivationRequest,
): IntentActivationAssembly {
  const { humanReview, intent, projectId, sourceFences } = request;
  const sources = readApprovalIntentSources(store, projectId, intent.runId);
  if (!sources.ok) return Object.freeze({ ...sources });
  if (!sources.binding.ok) return Object.freeze({ ...sources.binding });
  const stepUp = deriveStepUpAuthRef(humanReview, intent.runId);
  if (!stepUp.ok) return Object.freeze({ ...stepUp });
  const facts = readApprovalRecordFacts(
    store,
    { projectId, runId: intent.runId },
    { stepUpAuthRef: stepUp.stepUpAuthRef },
  );
  if (!facts.ok) {
    return Object.freeze({ code: facts.missing, layer: "DAEMON_APPROVAL_INTENT", ok: false });
  }
  const record = composeIntentApprovalRecord({ facts, intent, sources, witness: humanReview });
  if (record === undefined) return invalidRecord();
  const expectedGoalVersion = durableGoalVersion(ledger, sources.goalRef);
  if (expectedGoalVersion === null) return missingGoal();

  const input: IntentActivationInput = Object.freeze({
    activation: Object.freeze({
      expectedGoalVersion,
      truthClass: "HUMAN_APPROVED",
    }),
    approval: record,
    binding: sources.binding.binding,
    goalId: sources.goalRef,
    graphRevisionRef: sources.graphRevisionRef,
    humanReview,
    sourceFences,
  });
  return Object.freeze({ input, ok: true as const });
}

type IntentCommandRequest = Omit<BootstrapRequest, "kind"> & {
  readonly kind: typeof APPROVAL_DECIDE_INTENT_COMMAND_KIND;
};

function intentCommandRequest(command: IntentActivationCommand): BootstrapRequest {
  const request: IntentCommandRequest = Object.freeze({
    ...command,
    kind: APPROVAL_DECIDE_INTENT_COMMAND_KIND,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  });
  return request as unknown as BootstrapRequest;
}

/** Exact accepted-command replay lookup, before any mutable durable source is reread. */
export function replayIntentDecision(
  store: SqliteEventStore,
  command: IntentActivationCommand,
): ServiceOutcome | null {
  return replayOf(store, intentCommandRequest(command));
}

/**
 * The one type widening for this non-bootstrap command's bootstrap-shaped commit request.
 * Runtime bytes retain `approval.decide_intent`; the cast only bridges HandlerContext's older
 * closed kind union, exactly as daemon-command-graph-contracts.ts does for graph commands.
 */
function intentHandlerContext(
  store: SqliteEventStore,
  ledger: DurableLedger,
  request: BootstrapRequest,
  humanReview: HumanReviewWitness,
): HandlerContext {
  return Object.freeze({
    humanReview,
    ledger,
    request,
    store,
  });
}

/** Commits activation, record, and replay observation through one multi-leg decision. */
export function commitIntentActivation(
  store: SqliteEventStore,
  ledger: DurableLedger,
  command: IntentActivationCommand,
  input: IntentActivationInput,
): ServiceOutcome {
  const request = intentCommandRequest(command);
  const context = intentHandlerContext(store, ledger, request, input.humanReview);
  const replay = replayOf(store, context.request);
  if (replay !== null) return replay;
  return activateInitialGraphWithApprovalReplay(context, input, input.sourceFences);
}
