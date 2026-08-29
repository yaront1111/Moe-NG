import type { JsonObject, JsonValue } from "@moe/contracts";
import { reduceGoal } from "@moe/core";
import type { ApprovalDecisionRecord, GoalCommand, GoalState } from "@moe/core";
import type { ExpectedVersionDecisionLeg } from "@moe/store";

import {
  commitAcceptedLegs,
  refuse,
  refuseFromCore,
  stateOf,
  versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type {
  CommitPlan,
  HandlerContext,
  HumanReviewWitness,
  ServiceOutcome,
} from "../bootstrap/bootstrap-ledger.js";
import { resolveApprovalBudgetRoot } from "../budget/budget-genesis-leg.js";
import type { ApprovalBudgetRoot } from "../budget/budget-genesis-leg.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import { observeActiveGraphSlot } from "./active-graph-slot.js";
import type { ApprovedRunBinding } from "./approval-run-binding.js";
import { withPolicyRiskLeg } from "./policy-risk-leg.js";

/**
 * The activation half of J1's second human action (design 299).
 *
 * It lives beside the approval handler rather than inside it because the pair must commit
 * through ONE decision: the store fences one PRIMARY aggregate per decision, so the only way the
 * approval and the activation can be all-or-nothing is for both to ride it. That decision
 * targets the GOAL — the aggregate whose lifecycle has to advance for J1's third action to be
 * reachable — and carries the decided approval record in its event payload, which is why the
 * committed result is a bare `GoalState` and nothing else: `snapshotGoalState` accepts exactly
 * the twelve state keys, so a wrapper here would make the goal unreadable to the next command.
 *
 * A SECOND LEG MAY RIDE THAT DECISION: the project's genesis budget root (task-1de7b81a).
 * A witnessed qualifying approval may add a THIRD, the policy-risk record for the CURRENT active
 * graph. When that risk leg exists, a read-only active-graph-slot fence follows it; zero risk means
 * zero slot fence. The registry witness is the only source of `approvedBy`; the request principal
 * and approval actor are never substitutes. A missing active graph or rejected risk leg omits
 * that authority without vetoing a core-valid approval, while the risk reader remains fail-closed
 * when no record exists. Every accepted leg still commits atomically through
 * `commitAcceptedLegs`, with the goal fixed at `legs[0]`.
 *
 * Nothing in this module decides. The witness is assembled from values the core has already
 * produced or will itself validate, and every rejection is the core's own.
 */

export interface ActivationInput {
  /** The caller's `PlanningActivationWitness`; only the core reads its fields. */
  readonly activation: JsonObject;
  readonly approval: ApprovalDecisionRecord;
  /** The verified approved-run identity; durable-only, see `durableActivationWitness`. */
  readonly binding: ApprovedRunBinding;
  readonly goalId: string;
  readonly graphRevisionRef: string;
  /** Registry-minted service authority; never part of either activation witness. */
  readonly humanReview?: HumanReviewWitness | undefined;
}

/**
 * `graphApprovalRef` is the core's OWN decided `approvalRef`, never a payload field. A caller
 * therefore cannot present an activation that names some other approval: the only approval an
 * activation can cite is the one this very command just decided.
 *
 * THREE KEYS AND EXACTLY THREE. `validActivation` (goal-validation.ts:154) is
 * `exact(value, ACTIVATION_KEYS)`, so a fourth key here is not additive — it makes the whole
 * command `illegal` at the core. That is why the run binding rides the DURABLE copy below
 * instead, and why the two witnesses are separate functions rather than one shape with an
 * optional field: a single shape would be one careless spread away from reaching the reducer.
 * `humanReview` likewise remains on `ActivationInput` only and is never spread into this shape.
 */
function activationWitness(input: ActivationInput): JsonObject {
  return {
    activeGraphRevisionRef: input.graphRevisionRef,
    graphApprovalRef: input.approval.approvalRef,
    truthClass: input.activation["truthClass"] ?? null,
  };
}

/**
 * The DAEMON-OWNED durable copy: the core's three keys plus the verified approved-run identity.
 *
 * The core never reads `eventPayload` back — it is the daemon's own record of what it decided —
 * so extending this copy is additive where extending the command witness is fatal. Every added
 * value was read out of a durable record by `verifyApprovedRunBinding`; none is copied from the
 * request. `readApprovedNodeScope` (goal-close-prerequisite.ts:66-97), the only existing durable
 * consumer of this event, reads `payload.approval` and never `payload.activation`, so it is
 * unaffected — asserted by its own suite rather than argued here.
 */
function durableActivationWitness(
  input: ActivationInput, witness: JsonObject, budgetHash: string,
): JsonObject {
  return {
    ...witness,
    authorityRef: input.binding.authorityRef,
    bodiesDigest: input.binding.bodiesDigest,
    // The SERVER's digest over the root record it built, never the caller's field — that one was
    // only ever compared. This is the durable answer to "which budget authorization does this
    // activation bind", which until now had no producer at all.
    budgetHash,
    envelopeDigest: input.binding.envelopeDigest,
    runId: input.binding.runId,
  };
}

/**
 * The durable budget root this approval binds to — minted here when the project has none, read
 * when it already has one, and in both cases identified by a digest the SERVER recomputes.
 *
 * Every identity comes from a durable record or from the request ENVELOPE (never its payload):
 * the project off the request, the goal off the run's own record, the revision off the binding
 * `verifyApprovedRunBinding` already compared against durable state.
 */
function budgetRootFor(context: HandlerContext, input: ActivationInput): ApprovalBudgetRoot {
  const { request, store } = context;
  return resolveApprovalBudgetRoot(store, {
    approvedRun: {
      runBinding: input.binding,
      verifiedGraphRevisionRef: input.graphRevisionRef,
    },
    context: {
      commandId: request.commandId,
      correlationId: request.correlationId,
      decidedAt: request.decidedAt,
      principalId: request.principalId,
    },
    goalRef: input.goalId,
    projectId: request.projectId,
  });
}

export function activateInitialGraph(
  context: HandlerContext,
  input: ActivationInput,
): ServiceOutcome {
  const { ledger, request, store } = context;
  const prior = stateOf(ledger, input.goalId);
  const witness = activationWitness(input);
  const command = {
    commandId: request.commandId,
    // The witness declares which goal version the human approved against; the core's
    // `validExpectedVersion` and version check are what judge it.
    expectedVersion: input.activation["expectedGoalVersion"],
    kind: "goal.activate_initial_graph",
    witness,
  } as unknown as GoalCommand;

  const verdict = reduceGoal(
    prior === undefined || prior === null ? undefined : (prior as unknown as GoalState),
    command,
  );
  if (!verdict.ok) return refuseFromCore(request.kind, verdict.error);

  // THE BUDGET ROOT. When it has to be minted it is CAPTURED, not committed: nothing durable
  // happens here, so an approval that refuses past this point leaves no root behind. A refusal
  // is forwarded with the code and layer that produced it — a budget writer and a budget reader
  // fail differently and an operator repairs them differently, so neither is restamped as a
  // planning refusal.
  const root = budgetRootFor(context, input);
  if (!root.ok) return refuse(request.kind, root.code, root.layer);
  // The caller's hash is COMPARED, never adopted. Both sides of the durable fact are
  // server-computed — the root record and the digest over it — so a caller can at most PREDICT
  // what the server will build, and a prediction that disagrees refuses before anything is
  // durable. Omitting the field is not a bypass and grants nothing: the durable value is the
  // server's either way, and a caller that states no expectation simply has none to contradict.
  const claimed = input.activation["budgetHash"];
  if (claimed !== undefined && claimed !== root.digest) {
    return refuse(request.kind, "BOOTSTRAP_BUDGET_HASH_MISMATCH", "DAEMON_PREREQUISITE");
  }

  const plan: CommitPlan = {
    aggregateId: input.goalId,
    eventPayload: {
      activation: durableActivationWitness(input, witness, root.digest),
      approval: input.approval,
      events: verdict.events,
    } as unknown as JsonValue,
    eventType: "GoalExecutionEnabled",
    expectedVersion: versionOf(ledger, input.goalId),
    result: verdict.state as unknown as JsonValue,
  };
  // LEGS[0] STAYS THE GOAL. `commitAcceptedLegs` builds the primary leg exactly as the
  // single-aggregate path builds its only one and APPENDS the extras, so the decision record a
  // reader sees is unchanged in shape and the replay identity of this command does not move.
  // Path B has no graph-revision activation leg of its own, so the durable CURRENT projection is
  // the risk subject. A projection or builder refusal omits only risk authority; the approval
  // itself remains valid and readers continue to answer UNKNOWN from the absent record.
  const slot = observeActiveGraphSlot(store, request.projectId);
  const active = readCurrentActiveGraph(store, request.projectId);
  const riskLegs = withPolicyRiskLeg(store, [], {
    approval: input.approval,
    approvedBy: input.humanReview?.principalId ?? null,
    commandId: request.commandId,
    decidedAt: request.decidedAt,
    projectId: request.projectId,
    subject: active.ok
      ? { subjectRef: active.graphContentHash, subjectRevision: active.graphEpoch }
      : null,
  });
  const slotFenceLegs: readonly ExpectedVersionDecisionLeg[] = riskLegs.length === 0
    ? []
    : [Object.freeze({
      aggregateId: slot.aggregateId,
      events: Object.freeze([]),
      expectedVersion: slot.version,
    })];
  const extraLegs = root.source === "GENESIS"
    ? [root.leg, ...riskLegs, ...slotFenceLegs]
    : [...riskLegs, ...slotFenceLegs];
  return commitAcceptedLegs(store, request, plan, extraLegs);
}
