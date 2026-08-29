import type { JsonObject, JsonValue } from "@moe/contracts";
import {
  applyApprovalCommand, decideApprovalAuthority, grantHumanAuthority, reducePlanningRun,
} from "@moe/core";
import type {
  HumanAuthorityGate,
  PlanningRunCommand,
  PlanningRunEvent,
  PlanningRunState,
} from "@moe/core";

import {
  commitAcceptedLegs,
  payloadObject,
  payloadRef,
  refuse,
  refuseFromCore,
  stateOf,
  versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type {
  CommandHandler,
  HandlerContext,
  HandlerTable,
  HumanReviewWitness,
  ServiceOutcome,
} from "../bootstrap/bootstrap-ledger.js";
import { activateInitialGraph } from "./approval-activation.js";
import {
  approvalDelayDisposition,
  persistApprovalGate,
  planningStateFromDurableRecord,
  readApprovalGate,
} from "./approval-gate.js";
import { readApprovalPolicySettings } from "./approval-policy-settings.js";
import { verifyApprovedRunBinding } from "./approval-run-binding.js";
import {
  callerSuppliedAuthorityBodies,
  classifyPlanningChain,
} from "./planning-authority-finalize-ingress.js";
import { commitFinalizedSubmission } from "./planning-authority-finalize.js";
import { buildPlanningAuthorityLeg } from "./planning-authority-persistence.js";

/**
 * Plan proposal and approval — the two authority-bearing commands in this task.
 *
 * `plan.propose` reaches the core through a caller-supplied ordered command chain folded left
 * through `reducePlanningRun` from durable state. The daemon never synthesises a step and never
 * rewrites an `expectedVersion`: every element of the chain is decided by the core, and the
 * first rejection aborts the whole fold with the core's own code, committing nothing. That is
 * what keeps the run's arrival at PLANNING command-driven rather than hand-editable.
 *
 * The chain has TWO terminals, and design 201/1021 is why both live under this one kind:
 * finalization belongs to the same compound submission, as a LATER runner-proven boundary
 * (design 289/310/342) judged against the drained durable state. They are mutually exclusive —
 * each business effect owes its own durable decision — so a mixed chain is refused, not merged.
 */

interface FoldRejected {
  readonly outcome: ServiceOutcome;
  readonly ok: false;
}

interface FoldAccepted {
  readonly events: readonly PlanningRunEvent[];
  readonly ok: true;
  readonly state: PlanningRunState;
}

type FoldResult = FoldAccepted | FoldRejected;

function commandList(payload: JsonObject): readonly JsonValue[] | null {
  const value = payload["commands"];
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function foldChain(
  context: HandlerContext,
  prior: PlanningRunState | undefined,
  commands: readonly JsonValue[],
): FoldResult {
  let state = prior;
  const events: PlanningRunEvent[] = [];
  for (const entry of commands) {
    const verdict = reducePlanningRun(state, entry as unknown as PlanningRunCommand);
    if (!verdict.ok) {
      // The core's third arm is a typed UNSUPPORTED that carries no RuntimeError; its `reason`
      // is the stable code, so surfacing it unchanged keeps the layer marker honest either way.
      const outcome = "unsupported" in verdict
        ? refuse(context.request.kind, verdict.reason, "CORE_REDUCER")
        : refuseFromCore(context.request.kind, verdict.error);
      return { ok: false, outcome };
    }
    state = verdict.state;
    events.push(...verdict.events);
  }
  if (state === undefined) {
    return {
      ok: false,
      outcome: refuse(context.request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS"),
    };
  }
  return { events, ok: true, state };
}

const proposePlan: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const runId = payloadRef(request.payload, "runId");
  const commands = commandList(request.payload);
  if (runId === null || commands === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const terminal = classifyPlanningChain(commands);
  if (terminal.kind === "UNSUPPORTED") {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (terminal.kind === "REFUSED") return refuse(request.kind, terminal.code, "DAEMON_INGRESS");
  // The durable record is the ONLY body source at finalize, so authority content presented by
  // the caller is refused here, before the fold, rather than quietly ignored by the reducer.
  if (terminal.kind === "FINALIZE" && callerSuppliedAuthorityBodies(request.payload, commands)) {
    return refuse(request.kind, "PLANNING_FINALIZE_BODIES_SUPPLIED", "DAEMON_INGRESS");
  }

  const prior = stateOf(ledger, runId);
  const priorState = planningStateFromDurableRecord(prior);
  const folded = foldChain(
    context,
    priorState === undefined ? undefined : (priorState as unknown as PlanningRunState),
    commands,
  );
  if (!folded.ok) return folded.outcome;
  if (terminal.kind === "FINALIZE") return commitFinalizedSubmission(context, runId, prior, folded);

  // Built BEFORE any durable write, so a refusal leaves no event and no decision behind. Every
  // accepted propose now carries the authority leg: the single-aggregate legacy path is retired
  // by task-16a6a2b1, which closed D1's optional-at-the-edge decision, so a terminal without an
  // authority member is refused here rather than committed on one aggregate.
  const authority = buildPlanningAuthorityLeg({
    lastCommand: commands[commands.length - 1], request, runId, state: folded.state, store,
  });
  if (authority.kind === "REFUSED") return refuse(request.kind, authority.code, authority.layer);
  const carried = authority.binding;
  const result = persistApprovalGate({
    ...carried,
    state: folded.state as unknown as JsonValue,
    submissionHash: folded.state.submissionHash,
  }, prior, request.payload["humanAuthorityGate"]);
  // ONE decision either way. With bodies, the run leg stays primary and the authority leg rides
  // the same commit, so plan and criteria content cannot survive without PlanProposed.
  const plan = {
    aggregateId: runId,
    eventPayload: folded.events as unknown as JsonValue,
    eventType: "PlanProposed",
    expectedVersion: versionOf(ledger, runId),
    result,
  };
  // THREE legs at most, one decision. A body row cannot survive a refused propose, and an
  // accepted propose cannot half-land: the store fences all three together or writes none.
  const extraLegs = authority.graphBodyLeg === undefined
    ? [authority.leg]
    : [authority.leg, authority.graphBodyLeg];
  return commitAcceptedLegs(store, request, plan, extraLegs);
};

interface DurableRun {
  readonly gate: HumanAuthorityGate | null;
  readonly goalRef: string;
  /** The whole durable record, carried so the run binding reads the SAME fold this gate did. */
  readonly record: JsonValue;
  readonly submissionHash: string;
}

/**
 * The operator's own dispatch IS the human review the policy is waiting for.
 *
 * Reached only when `decideApprovalAuthority` refused at the APPROVAL_POLICY
 * layer for want of a human AND the composition root attached a server-assembled
 * {@link HumanReviewWitness} — evidence that the AUTHENTICATED principal on this
 * very request is the configured operator, the same human seat
 * OPERATOR_PRINCIPAL_KINDS reserves `approval.decide` for. A gate-layer refusal
 * never reaches here: an explicit GO gate on the run outranks any click.
 *
 * The grant is minted from the witness through the core's own
 * `grantHumanAuthority` — never from caller bytes — and the verdict is then
 * RE-DERIVED by handing the granted gate back to `decideApprovalAuthority`,
 * which consults the gate first by construction. This module decides nothing
 * about the grant's validity; the kernel does, both ways.
 */
function operatorReviewAuthority(
  witness: HumanReviewWitness,
  runId: string,
  decidedAt: string,
  policy: ReturnType<typeof readApprovalPolicySettings>,
): ReturnType<typeof decideApprovalAuthority> {
  const granted = grantHumanAuthority(
    { gateId: `approval-review:${runId}`, grant: null, workRef: runId },
    { kind: "HUMAN", principalId: witness.principalId },
    Date.parse(decidedAt),
  );
  if (!granted.ok) return granted;
  return decideApprovalAuthority({ gate: granted.gate, policy });
}

/**
 * The durably proposed run. `goalRef` is read from the run rather than from the request so the
 * activation cannot be redirected at a goal this plan was never proposed for.
 */
function durableRun(context: HandlerContext, runId: string): DurableRun | null {
  const run = stateOf(context.ledger, runId);
  if (run === undefined || run === null || typeof run !== "object" || Array.isArray(run)) {
    return null;
  }
  const submissionHash = payloadRef(run as JsonObject, "submissionHash");
  const state = payloadObject(run as JsonObject, "state");
  const goalRef = state === null ? null : payloadRef(state, "goalRef");
  if (submissionHash === null || goalRef === null) return null;
  return { gate: readApprovalGate(run, runId).gate, goalRef, record: run, submissionHash };
}

/**
 * Approval decision — J1's SECOND human action, which design 299 makes one click and one
 * transaction: the plan/graph decision and the initial-graph activation commit together or not
 * at all. `activateInitialGraph` therefore performs the single durable commit for both halves;
 * returning early from any gate above it is what makes a partial approval unrepresentable.
 *
 * Eligibility, step-up authority and the decision-reason floor all belong to the core's
 * `applyApprovalCommand`, whose reason code is surfaced unchanged. The daemon owns exactly one
 * judgement — that the record's `exactRevisionHash` matches the hash of the durably proposed
 * revision — because design 265 makes the revision diff the daemon's job, not core's.
 */
const decideApproval: CommandHandler = (context): ServiceOutcome => {
  const { request } = context;
  const runId = payloadRef(request.payload, "runId");
  const record = payloadObject(request.payload, "record");
  const command = payloadObject(request.payload, "command");
  const activation = payloadObject(request.payload, "activation");
  const graphRevisionRef = payloadRef(request.payload, "graphRevisionRef");
  if (runId === null || record === null || command === null || activation === null
    || graphRevisionRef === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  // The approval record is durable authority attributed to a human. Its actor is therefore a
  // claim to compare with the authenticated envelope principal, never an identity to trust or
  // silently rewrite. Refuse before any authority decision or durable write can observe it.
  if (record["actor"] !== request.principalId) {
    return refuse(request.kind, "BOOTSTRAP_APPROVAL_ACTOR_UNBOUND", "DAEMON_INGRESS");
  }

  const run = durableRun(context, runId);
  // An unknown run is a MISSING prerequisite, not a hash disagreement. Collapsing the two made
  // a wrong runId report as revision drift — measured live: a dispatch naming a run the ledger
  // never committed was answered with the hash code, and the operator chased the wrong field.
  if (run === null) {
    return refuse(request.kind, "BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE");
  }
  if (payloadRef(record, "exactRevisionHash") !== run.submissionHash) {
    return refuse(request.kind, "BOOTSTRAP_REVISION_HASH_MISMATCH", "DAEMON_PREREQUISITE");
  }

  // The policy comes from the daemon's own settings and from nowhere else. There is no
  // default and no payload branch: a caller cannot present one, so self-approval is
  // unrepresentable here rather than merely blocked by the registry's allow-list next door.
  const policy = readApprovalPolicySettings(process.env);
  const decided = decideApprovalAuthority({ gate: run.gate, policy });
  // ONLY the policy's want-of-a-human refusal escalates, and only under a
  // server-assembled witness: requests decoded without one — every path that
  // cannot prove its principal is the operator — keep refusing byte-for-byte
  // as before, and a HUMAN_AUTHORITY_GATE refusal (an explicit GO on the run)
  // stands regardless of who is clicking.
  const authority = !decided.ok
    && decided.code === "APPROVAL_HUMAN_REVIEW_REQUIRED"
    && decided.layer === "APPROVAL_POLICY"
    && context.humanReview !== undefined
    ? operatorReviewAuthority(context.humanReview, runId, request.decidedAt, policy)
    : decided;
  if (!authority.ok) return refuse(request.kind, authority.code, authority.layer);
  // The delay is bounded HERE, where a timer would live, and it REFUSES rather than clamps:
  // `delayMs` is a safe non-negative integer, wider than `setTimeout` accepts, and above
  // 2**31-1 a timer would clamp it to 1ms — turning the most conservative configuration a
  // board can write into an immediate proceed. Refusing keeps that inversion unreachable.
  if (approvalDelayDisposition(authority.delayMs) !== "IMMEDIATE") {
    return refuse(request.kind, "APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY");
  }

  const verdict = applyApprovalCommand(record, command);
  if (!verdict.ok) return refuseFromCore(request.kind, verdict.error);
  // This surface composes J1's approve-and-activate action, so an activation may only ride an
  // APPROVE. A typed decline is J4's journey and is not expressible here; letting a non-approval
  // through would activate a graph the human refused.
  if (verdict.value.decision !== "APPROVE") {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_PREREQUISITE");
  }

  // WHICH run was approved, verified against durable state — the last gate before the single
  // durable commit, so a refusal here still leaves nothing committed. It sits AFTER the
  // authority gate deliberately: those refusals answer who may approve at all, and moving this
  // check above them would let a not-reviewable run answer for an unsatisfied human gate.
  const bound = verifyApprovedRunBinding({
    graphRevisionRef, run: run.record, runId, store: context.store,
  });
  if (!bound.ok) return refuse(request.kind, bound.code, bound.layer);

  return activateInitialGraph(context, {
    activation,
    approval: verdict.value,
    binding: bound.binding,
    goalId: run.goalRef,
    graphRevisionRef,
    humanReview: context.humanReview,
  });
};

export const PLANNING_HANDLERS: HandlerTable = Object.freeze({
  "approval.decide": decideApproval,
  "plan.propose": proposePlan,
});
