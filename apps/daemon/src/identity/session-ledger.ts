import type { JsonObject, JsonValue, RuntimeError } from "@moe/contracts";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  EventDraft,
  SqliteEventStore,
} from "@moe/store";

import type {
  SessionCommandKind,
  SessionIngressRefusalCode,
  SessionPrerequisiteRefusalCode,
  SessionRefusedBy,
  SessionRequest,
} from "./session-contracts.js";
import type { SessionLedger } from "./session-read-model.js";

/** Re-exported so a handler imports its whole composition surface from one module. */
export { readSessionLedger } from "./session-read-model.js";
export type { SessionLedger, SessionRecord } from "./session-read-model.js";

/**
 * The durable half of the session composition: the single commit seam every session handler
 * funnels through, plus the replay lookup that must precede it. Mirrors `review/review-ledger.ts`
 * including both guards that came from defects found on this board: the store answers an
 * expected-version mismatch with a `NO_BUSINESS_EFFECT` audit row rather than an exception, and
 * the decision key is `(commandId, principalId, projectId)` with NO kind.
 */

/** One aggregate per session, deterministically derived so replays land on the same stream. */
export function aggregateIdFor(sessionId: string): string {
  return `session/${sessionId}`;
}

export interface SessionAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: SessionCommandKind;
  readonly ok: true;
}

export interface SessionRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly kind: SessionCommandKind | null;
  readonly ok: false;
  readonly refusedBy: SessionRefusedBy;
}

export type SessionOutcome = SessionAccepted | SessionRefused;

export interface HandlerContext {
  readonly ledger: SessionLedger;
  readonly request: SessionRequest;
  /** Principal-id namespaces a session id may NOT collide with. */
  readonly reservedPrincipalIds?: readonly string[];
  readonly store: SqliteEventStore;
}

export type CommandHandler = (context: HandlerContext) => SessionOutcome;

export type HandlerTable = Readonly<Partial<Record<SessionCommandKind, CommandHandler>>>;

const encoder = new TextEncoder();

/** Every code the daemon's own two layers may emit, taken from the frozen vocabularies. */
export type SessionDaemonRefusalCode =
  | SessionIngressRefusalCode
  | SessionPrerequisiteRefusalCode;

export type SessionDaemonLayer = "DAEMON_INGRESS" | "DAEMON_PREREQUISITE";

/**
 * Overloaded on the REFUSING LAYER: a daemon-layer refusal may only name a code the frozen
 * vocabulary already lists, so emitting one absent from `SESSION_INGRESS_REFUSAL_CODES` or
 * `SESSION_PREREQUISITE_REFUSAL_CODES` is a BUILD failure. The store keeps the wide signature
 * because it owns its own code set, and restating it here would be a second source of truth.
 */
export function refuse(
  kind: SessionCommandKind | null,
  code: SessionDaemonRefusalCode,
  refusedBy: SessionDaemonLayer,
): SessionRefused;
export function refuse(
  kind: SessionCommandKind | null,
  code: string,
  refusedBy: "DURABLE_STORE",
): SessionRefused;
export function refuse(
  kind: SessionCommandKind | null,
  code: string,
  refusedBy: SessionRefusedBy,
): SessionRefused {
  return Object.freeze({
    advisoryOnly: true as const,
    authority: "NONE" as const,
    code,
    error: null,
    kind,
    ok: false as const,
    refusedBy,
  });
}

export function decisionKey(request: SessionRequest): CommandDecisionKey {
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

function eventDraft(request: SessionRequest, plan: CommitPlan): EventDraft {
  return {
    eventId: `${request.commandId}-${plan.eventType}`,
    eventType: plan.eventType,
    payload: encoder.encode(JSON.stringify(plan.eventPayload)),
  };
}

/**
 * The single durable seam. Every accepted session command commits exactly one decision here, so
 * "one durable terminal decision" is a property of this function rather than of three call sites.
 */
export function commitAccepted(
  store: SqliteEventStore,
  request: SessionRequest,
  plan: CommitPlan,
): SessionOutcome {
  const response = store.commitExpectedVersionDecision({
    commandKind: request.kind,
    committedResultBytes: encoder.encode(JSON.stringify(plan.result)),
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [eventDraft(request, plan)],
    expectedVersion: plan.expectedVersion,
    key: decisionKey(request),
    requestBytes: encoder.encode(JSON.stringify({ kind: request.kind, payload: request.payload })),
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
 * Idempotent replay lookup, which MUST run before any handler: `openSession` refuses a second
 * open of the same session id, so an identical retried request would be refused as a duplicate
 * and could never be recognised as the replay it is.
 */
export function replayOf(store: SqliteEventStore, request: SessionRequest): SessionOutcome | null {
  const existing = store.getCommandDecision(decisionKey(request));
  if (existing === null) return null;
  // The decision key carries no kind, so without this the earlier command's decision would come
  // back as an accepted replay of a command that was never decided. The short-circuit happens
  // before any store write, so the store's own command-id guard never sees it.
  if (existing.commandKind !== request.kind) {
    return refuse(request.kind, "SESSION_COMMAND_ID_REUSED", "DAEMON_PREREQUISITE");
  }
  if (existing.effectDisposition !== "EFFECTS_COMMITTED") return null;
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
