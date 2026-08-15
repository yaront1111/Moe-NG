import type { JsonValue, RuntimeError } from "@moe/contracts";
import type { CommandDecisionKey, CommandDecisionRecord, SqliteEventStore } from "@moe/store";

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
): WorkClaimRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code,
    error: null, kind, ok: false as const, refusedBy,
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
    requestBytes: encoder.encode(JSON.stringify({ kind: request.kind, payload: request.payload })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse(request.kind, response.decision.resultCode, "DURABLE_STORE");
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
  if (existing.effectDisposition !== "EFFECTS_COMMITTED") return null;
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
    return refuse(request.kind, "WORK_CLAIM_NOT_CLAIMANT", "DAEMON_PREREQUISITE");
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
