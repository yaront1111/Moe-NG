import type { JsonValue, RuntimeError } from "@moe/contracts";
import { identifyReplayRequest } from "@moe/store";
import type { CommandDecisionKey, CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import { conflictError } from "../bootstrap/bootstrap-conflict-error.js";
import { holderHasLiveSession } from "./work-claim-holder-liveness.js";
import {
  decodeWorkClaimRequestBytes,
  isIsoInstant,
} from "./work-claim-contracts.js";
import type {
  WorkClaimCommandKind,
  WorkClaimIngressRefusalCode,
  WorkClaimPrerequisiteRefusalCode,
  WorkClaimRefusedBy,
  WorkClaimRequest,
} from "./work-claim-contracts.js";
import { readWorkClaimLedger } from "./work-claim-read-model.js";
import type { WorkClaimLedger, WorkClaimRecord } from "./work-claim-read-model.js";

/**
 * The durable handlers: claim, renew, release. One aggregate per work item
 * (`work/<workItemId>`), one decision per accepted command, refusals under the
 * layer that answered. The claimant is always the envelope principal — a
 * payload field could be spoofed. "Expired" is judged against the DAEMON's own
 * `decidedAt` timestamp (injected by the provider), never a caller clock.
 */

export { readWorkClaimLedger } from "./work-claim-read-model.js";
export type { WorkClaimLedger, WorkClaimRecord } from "./work-claim-read-model.js";

export function aggregateIdFor(workItemId: string): string {
  return `work/${workItemId}`;
}

export interface WorkClaimAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: WorkClaimCommandKind;
  readonly ok: true;
}

export interface WorkClaimRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly kind: WorkClaimCommandKind | null;
  readonly ok: false;
  readonly refusedBy: WorkClaimRefusedBy;
}

export type WorkClaimOutcome = WorkClaimAccepted | WorkClaimRefused;

type DaemonCode = WorkClaimIngressRefusalCode | WorkClaimPrerequisiteRefusalCode;

function refuse(
  kind: WorkClaimCommandKind | null,
  code: DaemonCode | string,
  refusedBy: WorkClaimRefusedBy,
  error: RuntimeError | null = null,
): WorkClaimRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code,
    error, kind, ok: false as const, refusedBy,
  });
}

function decisionKey(request: WorkClaimRequest): CommandDecisionKey {
  return {
    commandId: request.commandId,
    principalId: request.principalId,
    projectId: request.projectId,
  };
}

const encoder = new TextEncoder();

/**
 * The canonical request bytes of a command: the exact preimage `commitAccepted`
 * writes and the exact preimage the replay proof re-derives. ONE function on
 * purpose — two copies of a byte construction drift silently, and a drifted
 * copy here would refuse honest replays.
 */
function requestBytesOf(request: WorkClaimRequest): Uint8Array {
  return encoder.encode(JSON.stringify({ kind: request.kind, payload: request.payload }));
}

function commitAccepted(
  store: SqliteEventStore,
  request: WorkClaimRequest,
  eventType: string,
  expectedVersion: number,
  result: JsonValue,
  aggregateId: string,
): WorkClaimOutcome {
  const response = store.commitExpectedVersionDecision({
    commandKind: request.kind,
    committedResultBytes: encoder.encode(JSON.stringify(result)),
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [{
      eventId: `${request.commandId}-${eventType}`,
      eventType,
      payload: encoder.encode(JSON.stringify(result)),
    }],
    expectedVersion,
    key: decisionKey(request),
    requestBytes: requestBytesOf(request),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse(
      request.kind, response.decision.resultCode, "DURABLE_STORE",
      conflictError(response.decision),
    );
  }
  return Object.freeze({
    advisoryOnly: false as const, authority: "DURABLE_DECISION" as const,
    decision: response.decision, disposition: response.disposition,
    kind: request.kind, ok: true as const,
  });
}

function replayOf(store: SqliteEventStore, request: WorkClaimRequest): WorkClaimOutcome | null {
  const existing = store.getCommandDecision(decisionKey(request));
  if (existing === null) return null;
  if (existing.commandKind !== request.kind) {
    return refuse(request.kind, "WORK_CLAIM_COMMAND_ID_REUSED", "DAEMON_PREREQUISITE");
  }
  // A refused decision carries no same-bytes evidence (`replayRequestSha256` is
  // null), so nothing could prove the resubmit is the command that was decided;
  // it is decided again from scratch. Must stay AHEAD of the byte compare below.
  if (existing.effectDisposition !== "EFFECTS_COMMITTED") return null;
  // The decision key covers neither the kind (guarded above) nor the payload,
  // so reusing a commandId with DIFFERENT bytes would otherwise be handed the
  // stored result as an accepted replay — authority for a command never decided
  // with those bytes — and the store's own conflict arm never sees it, because
  // this short-circuit answers before any store write. Recomputed from the
  // STORED decision's own fence, so the resubmitted bytes are the only free
  // variable and a match is byte equality; an honest replay still matches after
  // its aggregate has advanced.
  if (identifyReplayRequest(existing, requestBytesOf(request)) !== existing.replayRequestSha256) {
    return refuse(request.kind, "WORK_CLAIM_COMMAND_BYTES_CONFLICT", "DAEMON_PREREQUISITE");
  }
  return Object.freeze({
    advisoryOnly: false as const, authority: "DURABLE_DECISION" as const,
    decision: existing, disposition: "REPLAYED" as const,
    kind: request.kind, ok: true as const,
  });
}

/**
 * An OPEN claim still fencing others: unexpired at the daemon's decide time.
 * Both instants are canonical fixed-width ISO, so lexicographic order is time
 * order. Version racing is left to the store: two concurrent claims carrying
 * the same observed expectedVersion race there and the second commit refuses.
 */
export function activeClaim(
  record: WorkClaimRecord | undefined, decidedAt: string,
): WorkClaimRecord | null {
  if (record === undefined || record.status === "RELEASED") return null;
  return record.expiresAt > decidedAt ? record : null;
}

function claimInputs(request: WorkClaimRequest): {
  expiresAt: string | null; workItemId: string | null;
} {
  const workItemId = request.payload["workItemId"];
  const expiresAt = request.payload["expiresAt"];
  return {
    expiresAt: isIsoInstant(expiresAt) ? expiresAt : null,
    workItemId: typeof workItemId === "string" && workItemId.length > 0 ? workItemId : null,
  };
}

function decide(
  ledger: WorkClaimLedger, store: SqliteEventStore, request: WorkClaimRequest,
): WorkClaimOutcome {
  const { expiresAt, workItemId } = claimInputs(request);
  if (workItemId === null || (request.kind !== "work.release" && expiresAt === null)) {
    return refuse(request.kind, "WORK_CLAIM_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const existing = ledger.claims.get(workItemId);
  const held = activeClaim(existing, request.decidedAt);

  if (request.kind === "work.claim") {
    if (held !== null && held.claimedBy !== request.principalId) {
      return refuse(request.kind, "WORK_CLAIM_HELD", "DAEMON_PREREQUISITE");
    }
    const result: JsonValue = {
      claimedBy: request.principalId, expiresAt: expiresAt as string,
      status: "OPEN", workItemId,
    };
    return commitAccepted(
      store, request, "WorkClaimed",
      request.expectedVersion, result, aggregateIdFor(workItemId),
    );
  }

  if (held === null || existing === undefined) {
    return refuse(request.kind, "WORK_CLAIM_NOT_FOUND", "DAEMON_PREREQUISITE");
  }
  if (held.claimedBy !== request.principalId) {
    // RELEASE, and only release, widens for a holder that is no longer live.
    // A seat claims under its own bearer, and that secret dies with the wrapper
    // process, so before this the claim's 30-minute expiry was the ONLY exit
    // from a dead seat's hold — nobody on the board, operator included, could
    // hand the item back. Renewal stays claimant-only: it is the holder's
    // keepalive, and letting a stranger extend a fence it does not own would be
    // a new authority rather than a recovery.
    //
    // A LIVE holder is NEVER overridden, and neither is one this daemon cannot
    // read: `null` (unreadable or throwing session ledger) fails closed with the
    // same code, because corrupt bytes are not evidence that a seat is gone.
    const live = request.kind === "work.release"
      ? holderHasLiveSession(store, request.projectId, held.claimedBy, request.decidedAt)
      : true;
    if (live !== false) {
      return refuse(request.kind, "WORK_CLAIM_NOT_CLAIMANT", "DAEMON_PREREQUISITE");
    }
  }
  const result: JsonValue = request.kind === "work.release"
    ? { claimedBy: held.claimedBy, expiresAt: held.expiresAt, status: "RELEASED", workItemId }
    : { claimedBy: held.claimedBy, expiresAt: expiresAt as string, status: "OPEN", workItemId };
  return commitAccepted(
    store, request, request.kind === "work.release" ? "WorkReleased" : "WorkClaimRenewed",
    request.expectedVersion, result, aggregateIdFor(workItemId),
  );
}

export function runWorkClaimCommand(store: SqliteEventStore, input: unknown): WorkClaimOutcome {
  const decoded = decodeWorkClaimRequestBytes(input);
  if (!decoded.ok) return refuse(null, decoded.code, "DAEMON_INGRESS");
  const request = decoded.request;
  const replayed = replayOf(store, request);
  if (replayed !== null) return replayed;
  const ledger = readWorkClaimLedger(store, request.projectId);
  if (ledger.unreadable) {
    return refuse(request.kind, "WORK_CLAIM_LEDGER_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  return decide(ledger, store, request);
}
