import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { runEventResumeCommand } from "./http/event-resume-command.js";
import {
  createEventStreamAccessPort, createEventStreamSubscriberResolver,
} from "./http/event-stream-access.js";
import type { AuthenticatedPrincipal, DurableDecision } from "./http/http-contract.js";
import { runApprovalIntentCommand } from "./planning/approval-intent.js";
import { runContinuationCommand } from "./recovery/continuation-command.js";
import { runResourceConfirmReleasedCommand }
  from "./work/resource-confirm-released-command.js";
import { runResourceReconcileCommand } from "./work/resource-reconcile-command.js";
import { humanReviewWitness } from "./bootstrap/bootstrap-ledger.js";
import { DomainRefusal } from "./daemon-command-dispatch.js";
import { OPERATOR_CAPABILITIES } from "./daemon-command-vocabulary.js";

/**
 * The commands assembled AT THEIR OWN EDGE rather than trimmed into the registry's shared
 * request record. Each one's request shape is exact and disjoint from that record -- it is
 * identity plus an adapter observation, a proof reference, or a resume cursor -- so it is
 * built here from the ENVELOPE and the AUTHENTICATED principal instead of being
 * materialized as request bytes like the codec-backed families.
 *
 * Every refusal below carries its service's OWN code and refusing layer: nothing here
 * restamps a downstream refusal with an ingress layer.
 */
export interface CommandEdgeContext {
  readonly decidedAt: string;
  readonly envelope: RuntimeCommandEnvelope;
  /** Daemon-owned event reader binding. `undefined` leaves events.resume fail-closed. */
  readonly eventSubscriberId: string | undefined;
  readonly operatorPrincipalId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/**
 * `approval.decide_intent` — the DAEMON-OWNED approval seam (task-6646f888).
 *
 * THE WITNESS IS MINTED HERE, on exactly the terms the bootstrap path's is: the authenticated
 * principal compared against the daemon's CONFIGURED operator. It is never decoded from request
 * bytes, so no payload can present one, and the seam refuses without it -- which is what keeps a
 * PROCEED_WITHOUT_HUMAN policy from letting an unwitnessed dispatch mint a human's approval.
 *
 * Every refusal travels back UNRESTAMPED: the seam already carries the code and the layer of
 * whichever authority answered, so this edge forwards them rather than substituting one of its own.
 */
export function runApprovalIntentEdge(context: CommandEdgeContext): DurableDecision {
  const { decidedAt, envelope, operatorPrincipalId, principal, projectId, store } = context;
  const outcome = runApprovalIntentCommand({
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    decidedAt,
    humanReview: principal.principalId === operatorPrincipalId
      ? humanReviewWitness(principal.principalId, envelope.commandId)
      : undefined,
    payload: envelope.payload,
    principalId: principal.principalId,
    projectId,
    store,
  });
  if (!outcome.ok) throw new DomainRefusal(outcome.code, outcome.refusedBy, outcome.code);
  return Object.freeze({
    commandId: envelope.commandId,
    disposition: "DECIDED" as const,
    effectId: envelope.commandId,
    resultCode: outcome.authority,
  });
}

export function runContinuationEdge(context: CommandEdgeContext): DurableDecision {
  const { decidedAt, envelope, principal, projectId, store } = context;
  const outcome = runContinuationCommand(store, {
    correlationId: envelope.correlationId,
    decidedAt,
    payload: envelope.payload,
    principalId: principal.principalId,
    projectId,
  });
  if (!outcome.ok) throw new DomainRefusal(outcome.code, outcome.layer, outcome.message);
  return Object.freeze({
    commandId: envelope.commandId,
    disposition: outcome.replayed ? "REPLAYED" : "DECIDED",
    effectId: outcome.bindingRef,
    resultCode: outcome.resultCode,
  });
}

export function runEventResumeEdge(context: CommandEdgeContext): DurableDecision {
  const { decidedAt, envelope, operatorPrincipalId, principal, projectId, store } = context;
  const resolveSubscriberId = createEventStreamSubscriberResolver({
    clock: () => Date.parse(decidedAt),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorPrincipalId,
    operatorSubscriberId: context.eventSubscriberId,
    projectId,
    store,
  });
  const granted = createEventStreamAccessPort({
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorPrincipalId, projectId, resolveSubscriberId, store,
  }).authorize(principal);
  if (!granted.ok && granted.code === "EVENT_STREAM_OPERATOR_AUTHORITY_REQUIRED") {
    throw new DomainRefusal(
      "EVENT_STREAM_RESUME_OPERATOR_AUTHORITY_REQUIRED",
      "DAEMON_AUTHORIZATION",
      "the shared control-room reader requires operator or approved pairing authority",
      granted.httpStatus,
    );
  }
  return runEventResumeCommand({
    authorizedSubscriberId: granted.ok ? granted.subscriberId : undefined,
    decidedAt, envelope, principal, projectId, store,
  });
}

/**
 * Its request is identity plus one adapter observation, assembled from the ENVELOPE and
 * the AUTHENTICATED principal.
 */
export function runResourceReconcileEdge(context: CommandEdgeContext): DurableDecision {
  const { envelope, principal, projectId, store } = context;
  const outcome = runResourceReconcileCommand(store, {
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    payload: envelope.payload,
    principalId: principal.principalId,
    projectId,
  });
  if (!outcome.ok) {
    throw new DomainRefusal(
      outcome.code, outcome.refusedBy, outcome.upstreamCode ?? outcome.code,
    );
  }
  return Object.freeze({
    commandId: envelope.commandId,
    disposition: "DECIDED" as const,
    effectId: outcome.attemptRef,
    // The ANSWER's own authority word, read off the durable reader's result:
    // a literal here would be this seam restating what the record already says.
    resultCode: outcome.authority,
  });
}

/**
 * ITS OWN EDGE, never folded into `runResourceReconcileEdge` above: that seam is the
 * ATTEMPT's authority over its own resources, and admitting a proven release there would
 * let an attempt clear the quarantine its own uncertainty created. Its request is identity
 * plus a proof reference, assembled from the ENVELOPE and the AUTHENTICATED principal.
 */
export function runResourceConfirmReleasedEdge(context: CommandEdgeContext): DurableDecision {
  const { envelope, principal, projectId, store } = context;
  const outcome = runResourceConfirmReleasedCommand(store, {
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    payload: envelope.payload,
    principalId: principal.principalId,
    projectId,
  });
  if (!outcome.ok) {
    throw new DomainRefusal(
      outcome.code, outcome.refusedBy, outcome.upstreamCode ?? outcome.code,
    );
  }
  return Object.freeze({
    commandId: envelope.commandId,
    disposition: "DECIDED" as const,
    effectId: outcome.attemptRef,
    // The ANSWER's own authority word, read off the durable reader's result.
    resultCode: outcome.authority,
  });
}
