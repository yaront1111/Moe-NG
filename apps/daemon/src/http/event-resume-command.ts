import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { JsonObject, RuntimeCommandEnvelope } from "@moe/contracts";
import {
  DurableStoreError, IdempotencyConflictError, type CommandDecisionResponse,
  type SqliteEventStore,
} from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import {
  acknowledge, reseatToSnapshot,
} from "@moe/store/subscriptions/subscription-writes.js";

import { DomainRefusal, encoder } from "../daemon-command-dispatch.js";
import { resumeFromSnapshot } from "./event-stream.js";
import type {
  EventRefusedFrame, EventResumeRequest, SubscriptionPort,
} from "./event-stream-contract.js";
import type {
  AuthenticatedPrincipal, DurableDecision,
} from "./http-contract.js";

export const EVENT_STREAM_RESUME_COMMAND_KIND = "events.resume" as const;
export const EVENT_STREAM_RESUME_PAYLOAD_KEYS = Object.freeze([
  "presentedCursor", "projection", "subscriberId",
] as const);
export const EVENT_STREAM_RESUME_LAYER = "DAEMON_EVENT_STREAM_RESUME" as const;
export const EVENT_STREAM_RESUME_IDEMPOTENCY_CONFLICT_CODE =
  "EVENT_STREAM_RESUME_IDEMPOTENCY_CONFLICT" as const;
export const EVENT_STREAM_RESUME_LEGACY_ROUTE_REFUSAL_CODE =
  "EVENT_STREAM_RESUME_COMMAND_REQUIRED" as const;

interface ResumeCommandInput {
  /** Daemon-owned binding for the authenticated principal. Caller payload bytes never set it. */
  readonly authorizedSubscriberId: string | undefined;
  readonly decidedAt: string;
  readonly envelope: RuntimeCommandEnvelope;
  readonly principal: AuthenticatedPrincipal;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

class ResumeApplyRefusal extends Error {
  public readonly refusal: EventRefusedFrame;

  public constructor(refusal: EventRefusedFrame) {
    super(`${refusal.code}: ${refusal.detail}`);
    this.name = "ResumeApplyRefusal";
    this.refusal = refusal;
  }
}

function domainRefusal(code: string, detail: string, httpStatus = 422): never {
  throw new DomainRefusal(code, EVENT_STREAM_RESUME_LAYER, detail, httpStatus);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function requestOf(
  envelope: RuntimeCommandEnvelope,
  principal: AuthenticatedPrincipal,
  authorizedSubscriberId: string | undefined,
): EventResumeRequest {
  const payload = envelope.payload as JsonObject;
  if (!exactKeys(payload, EVENT_STREAM_RESUME_PAYLOAD_KEYS)) {
    return domainRefusal(
      "EVENT_STREAM_RESUME_INPUT_INVALID",
      "payload must contain exactly presentedCursor, projection, and subscriberId",
    );
  }
  const projection = payload["projection"];
  const subscriberId = payload["subscriberId"];
  const cursor = payload["presentedCursor"];
  if (typeof projection !== "string" || projection.length === 0
    || typeof subscriberId !== "string" || subscriberId.length === 0
    || typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
    return domainRefusal(
      "EVENT_STREAM_RESUME_INPUT_INVALID",
      "payload fields must carry a projection, subscriber, and cursor object",
    );
  }
  const cursorRecord = cursor as Readonly<Record<string, unknown>>;
  if (!exactKeys(cursorRecord, ["generation", "position"])) {
    return domainRefusal(
      "EVENT_STREAM_RESUME_INPUT_INVALID",
      "presentedCursor must contain exactly generation and position",
    );
  }
  const generation = cursorRecord["generation"];
  const position = cursorRecord["position"];
  if (!Number.isSafeInteger(generation) || (generation as number) < 1
    || typeof position !== "string" || position.length === 0) {
    return domainRefusal(
      "EVENT_STREAM_RESUME_INPUT_INVALID",
      "presentedCursor generation and position are invalid",
    );
  }
  if (authorizedSubscriberId === undefined || authorizedSubscriberId.length === 0) {
    return domainRefusal(
      "EVENT_STREAM_RESUME_AUTHORITY_UNAVAILABLE",
      `no event subscriber is bound to authenticated principal ${principal.principalId}`,
      503,
    );
  }
  if (subscriberId !== authorizedSubscriberId
    || envelope.targetAggregateId !== authorizedSubscriberId) {
    return domainRefusal(
      "EVENT_STREAM_RESUME_SESSION_MISMATCH",
      "subscriberId and targetAggregateId must equal the daemon-authorized event subscriber",
    );
  }
  return Object.freeze({
    presentedCursor: Object.freeze({ generation: generation as number, position }),
    projection,
    subscriberId,
  });
}

function transactionPort(
  store: SqliteEventStore,
  database: DatabaseSync,
): SubscriptionPort {
  const port: SubscriptionPort = {
    acknowledge: (request) => acknowledge(database, request),
    readPage: (request) => readSubscriptionPage(store, database, request),
    reseat: (request) => reseatToSnapshot(database, request),
  };
  return Object.freeze(port);
}

function requestBytesOf(
  input: ResumeCommandInput,
  request: EventResumeRequest,
): Uint8Array {
  const { envelope, principal, projectId } = input;
  return encoder.encode(JSON.stringify({
    commandId: envelope.commandId,
    commandKind: EVENT_STREAM_RESUME_COMMAND_KIND,
    correlationId: envelope.correlationId,
    expectedVersion: envelope.expectedVersion,
    ...(envelope.graphRevisionHash === undefined
      ? {} : { graphRevisionHash: envelope.graphRevisionHash }),
    ...(envelope.leaseAuthority === undefined
      ? {} : { leaseAuthority: envelope.leaseAuthority }),
    payload: request,
    ...(envelope.policyRevisionHash === undefined
      ? {} : { policyRevisionHash: envelope.policyRevisionHash }),
    principalId: principal.principalId,
    projectId,
    requestDigest: envelope.requestDigest,
    targetAggregateId: envelope.targetAggregateId,
  }));
}

function eventIdOf(input: ResumeCommandInput): string {
  const digest = createHash("sha256").update(JSON.stringify({
    commandId: input.envelope.commandId,
    principalId: input.principal.principalId,
    projectId: input.projectId,
  })).digest("hex");
  return `event-stream-resume:${digest}`;
}

function unwrapApplyRefusal(error: unknown): never {
  if (error instanceof IdempotencyConflictError) {
    return domainRefusal(
      EVENT_STREAM_RESUME_IDEMPOTENCY_CONFLICT_CODE,
      error.message,
      409,
    );
  }
  if (error instanceof DurableStoreError && error.code === "PROJECTION_APPLY_FAILED"
    && error.cause instanceof ResumeApplyRefusal) {
    const { refusal } = error.cause;
    throw new DomainRefusal(refusal.code, refusal.layer, refusal.detail);
  }
  throw error;
}

/** Commits the durable command decision and the sanctioned cursor reseat in one transaction. */
export function runEventResumeCommand(input: ResumeCommandInput): DurableDecision {
  const request = requestOf(
    input.envelope, input.principal, input.authorizedSubscriberId,
  );
  const requestBytes = requestBytesOf(input, request);
  const resultBytes = encoder.encode(JSON.stringify({ outcome: "RESEATED" }));
  let response: CommandDecisionResponse;
  try {
    response = input.store.commitExpectedVersionDecisionWithApply({
      commandKind: EVENT_STREAM_RESUME_COMMAND_KIND,
      committedResultBytes: resultBytes,
      correlationId: input.envelope.correlationId,
      decidedAt: input.decidedAt,
      events: [{
        eventId: eventIdOf(input),
        eventType: "EventStreamResumeCommitted",
        payload: requestBytes,
      }],
      expectedVersion: input.envelope.expectedVersion,
      key: {
        commandId: input.envelope.commandId,
        principalId: input.principal.principalId,
        projectId: input.projectId,
      },
      requestBytes,
      targetAggregateId: input.envelope.targetAggregateId,
    }, ({ database }) => {
      const outcome = resumeFromSnapshot(transactionPort(input.store, database), request);
      if (outcome.outcome === "REFUSED") throw new ResumeApplyRefusal(outcome);
      if (outcome.cursor.generation !== request.presentedCursor.generation
        || outcome.cursor.position !== request.presentedCursor.position) {
        throw new Error("the reseated cursor differs from the cursor admitted by the stream seam");
      }
    });
  } catch (error) {
    return unwrapApplyRefusal(error);
  }
  return Object.freeze({
    commandId: response.decision.key.commandId,
    disposition: response.disposition,
    effectId: response.decision.decisionId,
    resultCode: response.decision.resultCode,
  });
}
