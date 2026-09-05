import type { JsonObject, JsonValue, RuntimeError } from "@moe/contracts";
import type { ReviewDecisionLayer } from "@moe/review";
import { identifyReplayRequest } from "@moe/store";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  EventDraft,
  SqliteEventStore,
} from "@moe/store";

import type {
  ReviewCommandKind,
  ReviewIngressRefusalCode,
  ReviewPrerequisiteRefusalCode,
  ReviewRefusedBy,
  ReviewRequest,
} from "./review-contracts.js";
import type { ReviewLedger } from "./review-read-model.js";

/** Re-exported so a handler imports its whole composition surface from one module. */
export { readReviewLedger } from "./review-read-model.js";
export type { ReviewLedger, ReviewRoundRecord } from "./review-read-model.js";

/**
 * The durable half of the review composition: a read-only view over committed decisions for one
 * reviewed subject, plus the single commit seam every review handler funnels through.
 *
 * Two guards here are not optional and both come from defects already found on this board
 * (`mem:gotcha-store-decision-fail-open`): the store answers an expected-version mismatch with a
 * `NO_BUSINESS_EFFECT` audit row rather than an exception, so an unchecked composition would
 * claim authority for a command that committed nothing; and the decision key is
 * `(commandId, principalId, projectId)` with NO kind, so reusing a commandId under a different
 * kind would hand back the earlier command's decision dressed as this one.
 */

export interface ReviewAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: ReviewCommandKind;
  readonly ok: true;
}

/**
 * `kernelLayer` carries `@moe/review`'s own `ELIGIBILITY | PACKAGE | FINDINGS | ACCEPTANCE`
 * verbatim when the kernel answered, and is null otherwise. Without it a refusal would say only
 * that the review package refused, losing which of its four gates did — and a test pinning the
 * code alone would stay green if a different gate started answering first.
 */
export interface ReviewRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly kernelLayer: ReviewDecisionLayer | null;
  readonly kind: ReviewCommandKind | null;
  readonly ok: false;
  readonly refusedBy: ReviewRefusedBy;
}

export type ReviewOutcome = ReviewAccepted | ReviewRefused;

export interface HandlerContext {
  readonly ledger: ReviewLedger;
  readonly request: ReviewRequest;
  readonly store: SqliteEventStore;
}

export type CommandHandler = (context: HandlerContext) => ReviewOutcome;

export type HandlerTable = Readonly<Partial<Record<ReviewCommandKind, CommandHandler>>>;

const encoder = new TextEncoder();

/** Every code the daemon's own two layers may emit, taken from the frozen vocabularies. */
export type ReviewDaemonRefusalCode = ReviewIngressRefusalCode | ReviewPrerequisiteRefusalCode;

export type ReviewDaemonLayer = "DAEMON_INGRESS" | "DAEMON_PREREQUISITE";

/**
 * Overloaded on the REFUSING LAYER, and that is the point rather than a convenience.
 *
 * A daemon-layer refusal may only name a code the frozen vocabulary already lists, so emitting one
 * that is not in `REVIEW_INGRESS_REFUSAL_CODES` or `REVIEW_PREREQUISITE_REFUSAL_CODES` is a
 * BUILD failure. This defect was real here — `REVIEW_ESCALATION_REQUIRED` was emitted by
 * `submitRound` while absent from the vocabulary, and nothing caught it, because a `code: string`
 * parameter accepts anything and only the codes a test happens to exercise are ever pinned.
 *
 * The upstream layers keep the wide signature deliberately: `@moe/review`, `@moe/core` and the
 * store own their own code sets, and restating them here would be the second source of truth this
 * whole surface exists to avoid.
 */
export function refuse(
  kind: ReviewCommandKind | null,
  code: ReviewDaemonRefusalCode,
  refusedBy: ReviewDaemonLayer,
): ReviewRefused;
export function refuse(
  kind: ReviewCommandKind | null,
  code: string,
  refusedBy: "REVIEW_KERNEL" | "CORE_POLICY" | "DURABLE_STORE",
  kernelLayer?: ReviewDecisionLayer | null,
  error?: RuntimeError | null,
): ReviewRefused;
export function refuse(
  kind: ReviewCommandKind | null,
  code: string,
  refusedBy: ReviewRefusedBy,
  kernelLayer: ReviewDecisionLayer | null = null,
  error: RuntimeError | null = null,
): ReviewRefused {
  return Object.freeze({
    advisoryOnly: true as const,
    authority: "NONE" as const,
    code,
    error,
    kernelLayer,
    kind,
    ok: false as const,
    refusedBy,
  });
}

/** A `@moe/review` validator refused: its code and its layer are surfaced unchanged. */
export function refuseFromKernel(
  kind: ReviewCommandKind,
  code: string,
  layer: ReviewDecisionLayer,
): ReviewRefused {
  return refuse(kind, code, "REVIEW_KERNEL", layer);
}

export function decisionKey(request: ReviewRequest): CommandDecisionKey {
  return {
    commandId: request.commandId,
    principalId: request.principalId,
    projectId: request.projectId,
  };
}

export interface CommitPlan {
  readonly aggregateId: string;
  readonly eventPayload: JsonValue;
  readonly eventType: string;
  readonly expectedVersion: number;
  readonly result: JsonValue;
}

function eventDraft(request: ReviewRequest, plan: CommitPlan): EventDraft {
  return {
    eventId: `${request.commandId}-${plan.eventType}`,
    eventType: plan.eventType,
    payload: encoder.encode(JSON.stringify(plan.eventPayload)),
  };
}

/**
 * The bytes a review command is decided AND replay-checked against. One definition, so the
 * replay fence in `replayOf` compares exactly what `commitAccepted` stored.
 */
function requestBytesOf(request: ReviewRequest): Uint8Array {
  return encoder.encode(JSON.stringify({ kind: request.kind, payload: request.payload }));
}

/**
 * The single durable seam. Every accepted review command commits exactly one decision here, so
 * "one durable terminal decision" is a property of this function rather than of four call sites.
 */
export function commitAccepted(
  store: SqliteEventStore,
  request: ReviewRequest,
  plan: CommitPlan,
): ReviewOutcome {
  const response = store.commitExpectedVersionDecision({
    commandKind: request.kind,
    committedResultBytes: encoder.encode(JSON.stringify(plan.result)),
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [eventDraft(request, plan)],
    expectedVersion: plan.expectedVersion,
    key: decisionKey(request),
    requestBytes: requestBytesOf(request),
    targetAggregateId: plan.aggregateId,
  });
  // The store does not throw on a version mismatch: it writes a NO_BUSINESS_EFFECT audit row and
  // reports the conflict in `resultCode`. Reporting that as accepted would claim authority for a
  // command that committed nothing, so the store's own code is surfaced under its own layer.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse(request.kind, response.decision.resultCode, "DURABLE_STORE");
  }
  return Object.freeze({
    advisoryOnly: false as const,
    authority: "DURABLE_DECISION" as const,
    decision: response.decision,
    disposition: response.disposition,
    kind: request.kind,
    ok: true as const,
  });
}

/**
 * Idempotent replay lookup, which MUST run before any handler: `recordReviewRound` refuses a
 * round that does not advance, so an identical second request would be refused as append-only
 * and could never be recognised as the replay it is.
 */
export function replayOf(store: SqliteEventStore, request: ReviewRequest): ReviewOutcome | null {
  const existing = store.getCommandDecision(decisionKey(request));
  if (existing === null) return null;
  // The decision key carries no kind, so without this the earlier command's decision would come
  // back as an accepted replay of a command that was never decided. The short-circuit happens
  // before any store write, so the store's own command-id guard never sees it.
  if (existing.commandKind !== request.kind) {
    return refuse(request.kind, "REVIEW_COMMAND_ID_REUSED", "DAEMON_PREREQUISITE");
  }
  // A refused decision's receipt carries no request digest (it commits the rejection audit
  // payload), so nothing here could prove the resubmit is the command that was decided: fall
  // through and decide it again from scratch. This must stay AHEAD of the byte compare below.
  if (existing.effectDisposition !== "EFFECTS_COMMITTED") return null;
  // The key does not cover the payload either. A caller reusing a commandId under the SAME kind
  // with DIFFERENT bytes (another subject, another round, other findings) would otherwise be
  // handed the earlier decision as an accepted replay: durable authority for a command never
  // decided with those bytes. Recomputed from the STORED decision's own fence, so the resubmitted
  // bytes are the only free variable and a match is byte equality; the bootstrap and work-claim
  // families close the same hole the same way.
  if (identifyReplayRequest(existing, requestBytesOf(request)) !== existing.replayRequestSha256) {
    return refuse(request.kind, "REVIEW_COMMAND_BYTES_CONFLICT", "DAEMON_PREREQUISITE");
  }
  return Object.freeze({
    advisoryOnly: false as const,
    authority: "DURABLE_DECISION" as const,
    decision: existing,
    disposition: "REPLAYED" as const,
    kind: request.kind,
    ok: true as const,
  });
}

export function payloadRef(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function payloadObject(payload: JsonObject, key: string): JsonObject | null {
  const value = payload[key];
  if (value === null || value === undefined || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  return value as JsonObject;
}

export function payloadArray(payload: JsonObject, key: string): readonly JsonValue[] | null {
  const value = payload[key];
  return Array.isArray(value) ? value : null;
}
