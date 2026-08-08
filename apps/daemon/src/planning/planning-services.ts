import type { JsonObject, JsonValue } from "@moe/contracts";
import { applyApprovalCommand, reducePlanningRun } from "@moe/core";
import type { PlanningRunCommand, PlanningRunEvent, PlanningRunState } from "@moe/core";

import {
  commitAccepted,
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
  ServiceOutcome,
} from "../bootstrap/bootstrap-ledger.js";

/**
 * Plan proposal and approval — the two authority-bearing commands in this task.
 *
 * `plan.propose` reaches the core through a caller-supplied ordered command chain folded left
 * through `reducePlanningRun` from durable state. The daemon never synthesises a step and never
 * rewrites an `expectedVersion`: every element of the chain is decided by the core, and the
 * first rejection aborts the whole fold with the core's own code, committing nothing. That is
 * what keeps the run's arrival at PLANNING command-driven rather than hand-editable.
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
  const last = commands[commands.length - 1];
  const lastKind = last !== null && typeof last === "object" && !Array.isArray(last)
    ? (last as JsonObject)["kind"]
    : null;
  if (lastKind !== "plan.propose") {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }

  const prior = stateOf(ledger, runId);
  const folded = foldChain(
    context,
    prior === undefined || prior === null ? undefined : (prior as unknown as PlanningRunState),
    commands,
  );
  if (!folded.ok) return folded.outcome;

  return commitAccepted(store, request, {
    aggregateId: runId,
    eventPayload: folded.events as unknown as JsonValue,
    eventType: "PlanProposed",
    expectedVersion: versionOf(ledger, runId),
    result: {
      state: folded.state,
      submissionHash: folded.state.submissionHash,
    } as unknown as JsonValue,
  });
};

function durableSubmissionHash(context: HandlerContext, runId: string): string | null {
  const run = stateOf(context.ledger, runId);
  if (run === undefined || run === null || typeof run !== "object" || Array.isArray(run)) {
    return null;
  }
  return payloadRef(run as JsonObject, "submissionHash");
}

/**
 * Approval decision.
 *
 * Eligibility, step-up authority and the decision-reason floor all belong to the core's
 * `applyApprovalCommand`, whose reason code is surfaced unchanged. The daemon owns exactly one
 * judgement — that the record's `exactRevisionHash` matches the hash of the durably proposed
 * revision — because design 265 makes the revision diff the daemon's job, not core's.
 */
const decideApproval: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const runId = payloadRef(request.payload, "runId");
  const record = payloadObject(request.payload, "record");
  const command = payloadObject(request.payload, "command");
  if (runId === null || record === null || command === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }

  const proposed = durableSubmissionHash(context, runId);
  if (proposed === null || payloadRef(record, "exactRevisionHash") !== proposed) {
    return refuse(request.kind, "BOOTSTRAP_REVISION_HASH_MISMATCH", "DAEMON_PREREQUISITE");
  }

  const verdict = applyApprovalCommand(record, command);
  if (!verdict.ok) return refuseFromCore(request.kind, verdict.error);

  const approvalId = `${runId}-approval`;
  return commitAccepted(store, request, {
    aggregateId: approvalId,
    eventPayload: { approvalRef: verdict.value.approvalRef, decision: verdict.value.decision },
    eventType: "ApprovalDecided",
    expectedVersion: versionOf(ledger, approvalId),
    result: verdict.value as unknown as JsonValue,
  });
};

export const PLANNING_HANDLERS: HandlerTable = Object.freeze({
  "approval.decide": decideApproval,
  "plan.propose": proposePlan,
});
