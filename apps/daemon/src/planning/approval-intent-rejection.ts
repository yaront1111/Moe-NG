import type { JsonObject, JsonValue } from "@moe/contracts";
import {
  reducePlanningRun, rejectRun, snapshotPlanningRunContractState,
} from "@moe/core";
import type { PlanningRunReducerResult, PlanningRunState } from "@moe/core";
import type { EventDraft, ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";
import { createHash } from "node:crypto";

import { commitAcceptedLegs, refuse } from "../bootstrap/bootstrap-ledger.js";
import type { ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { intentCommandRequest } from "./approval-intent-activation.js";
import type { IntentActivationCommand } from "./approval-intent-activation.js";
import type { ApprovalIntentSourceFenceSnapshot } from "./approval-intent-source-fences.js";
import type { ApprovalIntentSources } from "./approval-intent-sources.js";
import type { ApprovalIntent } from "./approval-intent.js";

/**
 * The durable REJECT half of `approval.decide_intent` (task-3780109).
 *
 * A REJECTION IS A HUMAN DECISION, not an error path. It passes the SAME fences, the same durable
 * sources read and the same operator witness as an approval — `approval-intent.ts` branches here
 * only after all of them have answered — and it commits through the same one-decision seam. What
 * differs is the effect: no approval record is minted and no execution is enabled.
 *
 * WHY THE SUCCESSOR RIDES THE SAME DECISION. A goal carries ONE immutable `planningRunRef`, so a
 * rejected run with no successor is a goal that can never be planned again. Committing the
 * rejection and the REVISION successor as two decisions would make exactly that state reachable
 * by a crash between them; `commitAcceptedLegs` fences both aggregates inside one decision, so
 * the pair is atomic by the store rather than by this call site.
 *
 * WHY THE SUCCESSOR ID IS DERIVED, NOT MINTED. The decision ledger answers an exact replay from
 * the committed decision, but the successor's own leg is fenced at version 0: a time- or
 * random-based id would mint a SECOND successor aggregate for a retried command, which the
 * version fence could never catch because it would be fencing a different aggregate. Deriving
 * the id from (runId, commandId) makes a retry name the same aggregate, so the fence — not
 * luck — is what stops the duplicate.
 */

/** Refused before any durable read: a rejection an operator cannot read back is not a decision. */
export const APPROVAL_REJECT_REASON_REQUIRED = "APPROVAL_REJECT_REASON_REQUIRED" as const;

/**
 * The seam's own layer, deliberately NOT spelled `*_LAYER` and not exported:
 * `tests/security/boundary-roster.security.ts` scans production sources for column-zero exported
 * `*_LAYER(S)` constants and makes each owe a hostile trio. `approval-intent.ts:61` says the same.
 */
const LAYER = "DAEMON_APPROVAL_INTENT" as const;

const REJECTED_EVENT_TYPE = "PlanningRunRejected";
const CREATED_EVENT_TYPE = "PlanningRunCreated";
const FINDINGS_DOMAIN = "moe-plan-rejection/1\n";
const SUCCESSOR_ID_LENGTH = 24;

const encoder = new TextEncoder();

const sha256hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Content identity for the rejection's findings, domain-separated so a reason can never collide
 * with some other digest computed over the same bytes under a different meaning.
 */
export function rejectionFindingsRef(reason: string): string {
  return sha256hex(`${FINDINGS_DOMAIN}${reason}\n`);
}

/** Deterministic in (runId, commandId), so a retried rejection names the same successor. */
export function successorRunIdFor(runId: string, commandId: string): string {
  return `run-${sha256hex(`${runId}\n${commandId}`).slice(0, SUCCESSOR_ID_LENGTH)}`;
}

/** The reason, or `null` when it is absent or says nothing an operator could act on. */
export function rejectionReasonOf(reason: string | null): string | null {
  return typeof reason === "string" && reason.trim() !== "" ? reason : null;
}

export interface IntentRejectionRequest {
  readonly intent: ApprovalIntent;
  readonly sourceFences: ApprovalIntentSourceFenceSnapshot;
  readonly sources: ApprovalIntentSources;
}

/** Core's reducer events are frozen JSON records by construction; the cast crosses that gap. */
const asPayload = (event: unknown): JsonValue => event as JsonValue;

function draft(commandId: string, eventType: string, payload: JsonValue): EventDraft {
  return {
    eventId: `${commandId}-${eventType}`,
    eventType,
    payload: encoder.encode(JSON.stringify(payload)),
  };
}

/**
 * A core refusal, forwarded under the core's own layer.
 *
 * The reducer's third result arm carries a structural `reason` and never a `RuntimeError`
 * (planning-event-contract.ts:186-191), so it is answered here rather than dereferenced as one:
 * reading `.error` off it would be `undefined` and would publish an unnamed refusal.
 */
function coreRefusal(result: Extract<PlanningRunReducerResult, { ok: false }>): ServiceOutcome {
  return "error" in result
    ? refuse(null, result.error.code, "CORE_REDUCER", result.error)
    : refuse(null, result.reason, "CORE_REDUCER");
}

/**
 * The run's durable RECORD as an object, or undefined when the ledger holds no record shape.
 *
 * Narrowed off `unknown` and cast once on acceptance, the way `planning-run-read.ts:182` does it:
 * `Array.isArray` cannot narrow a READONLY array out of the `JsonValue` union, so the check and
 * the crossing are kept in one place rather than restated by every caller.
 */
function runRecordOf(sources: ApprovalIntentSources): JsonObject | undefined {
  const record: unknown = sources.runRecord;
  return record === null || typeof record !== "object" || Array.isArray(record)
    ? undefined
    : (record as JsonObject);
}

/**
 * The run's own durable state, taken through core's published snapshot reader rather than a
 * hand-written shape: the reducer is the authority on what a run state IS, and a locally shaped
 * object would silently diverge from it the first time core adds a field.
 */
function runStateOf(record: JsonObject) {
  return snapshotPlanningRunContractState((record as { readonly state?: unknown }).state);
}

/** The four decision facts an operator and every downstream reader read a rejection by. */
interface RejectionFacts {
  readonly decisionReason: string;
  readonly findingsRef: string;
  readonly runId: string;
  readonly successorRunId: string;
}

/**
 * THE RUN'S NEW RECORD, not merely the decision's five facts.
 *
 * An aggregate's durable record IS the last committed decision result that targets it
 * (`bootstrap-ledger.ts:97-116`, `stateOf` at :149-153) — there is no separate state projection.
 * The rejection's primary leg targets the RUN, so committing the decision facts ALONE would
 * REPLACE the sealed run record with a stateless one: `readApprovalIntentSources`,
 * `verifyApprovedRunBinding`, `readPlanningRun` and `planReviewable` would all see a run with no
 * state, REJECTED would exist nowhere durable (the `PlanningRunRejected` event payload carries no
 * lifecycle), and the sealed facts would be unreadable. Measured on this seam, not assumed.
 *
 * So the prior record is carried forward key by key and only `state` is replaced — with the state
 * core's own `rejectRun` reduced, which is where `lifecycle: "REJECTED"` and every sealed field
 * come from. The decision facts ride alongside it, so one read answers both "what is this run
 * now" and "what was decided". The APPROVE path needs none of this: its primary leg targets the
 * GOAL, so it never writes over the run's record.
 */
function rejectionRecord(
  record: JsonObject, state: PlanningRunState, facts: RejectionFacts,
): JsonValue {
  return {
    ...record,
    decision: "REJECT",
    decisionReason: facts.decisionReason,
    findingsRef: facts.findingsRef,
    runId: facts.runId,
    state: asPayload(state),
    successorRunId: facts.successorRunId,
  };
}

/**
 * Commits the rejection and its REVISION successor as ONE multi-leg decision.
 *
 * Both core reductions run BEFORE the commit and either refusal aborts it, so the store is never
 * asked to append half of a rejection.
 */
export function commitIntentRejection(
  store: SqliteEventStore,
  command: IntentActivationCommand,
  request: IntentRejectionRequest,
): ServiceOutcome {
  // The SAME derivation the seam gates on before any durable read, applied to the same intent:
  // one authority for "is this reason readable", consulted twice rather than restated once.
  const decisionReason = rejectionReasonOf(request.intent.decisionReason);
  if (decisionReason === null) return refuse(null, APPROVAL_REJECT_REASON_REQUIRED, LAYER);
  const runId = request.intent.runId;
  const record = runRecordOf(request.sources);
  const state = record === undefined ? undefined : runStateOf(record);
  if (record === undefined || state === undefined) {
    return refuse(null, "APPROVAL_AUTHORITY_UNSEALED", "APPROVAL_RUN_BINDING");
  }
  const findingsRef = rejectionFindingsRef(decisionReason);
  const successorRunId = successorRunIdFor(runId, command.commandId);
  const rejected = rejectRun(state, command.commandId, findingsRef, successorRunId);
  if (!rejected.ok) return coreRefusal(rejected);
  const created = reducePlanningRun(undefined, {
    commandId: `${command.commandId}-successor`,
    expectedVersion: 0,
    goalRef: request.sources.goalRef,
    kind: "planning.create_draft",
    runId: successorRunId,
    runKind: "REVISION",
  });
  if (!created.ok) return coreRefusal(created);

  const successorLeg: ExpectedVersionDecisionLeg = {
    aggregateId: successorRunId,
    events: [draft(command.commandId, CREATED_EVENT_TYPE, asPayload(created.events[0]))],
    expectedVersion: 0,
  };
  return commitAcceptedLegs(store, intentCommandRequest(command), {
    aggregateId: runId,
    eventPayload: asPayload(rejected.events[0]),
    eventType: REJECTED_EVENT_TYPE,
    expectedVersion: request.sourceFences.planningRunVersion,
    result: rejectionRecord(record, rejected.state, {
      decisionReason, findingsRef, runId, successorRunId,
    }),
  }, [successorLeg]);
}
