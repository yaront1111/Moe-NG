import type { RecoveryCompletionWitness } from "@moe/core";
import { IdempotencyConflictError } from "@moe/store";
import type { CommandDecisionRecord, SqliteEventStore, StoredEvent } from "@moe/store";

import { RECOVERY_COMPLETION_COMMAND_KIND } from "./recovery-completion-digest.js";
import type { RecoveryCompletionRefused } from "./recovery-completion-digest.js";
import {
  completionIdempotencyConflict,
  evidenceAbsent,
  evidenceMismatched,
  storeUnavailable,
} from "./recovery-completion-evidence.js";
import type { RecoveryCompleteRequest } from "./recovery-completion-evidence.js";

const decoder = new TextDecoder();

export interface RecoveryCompletionAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: typeof RECOVERY_COMPLETION_COMMAND_KIND;
  readonly ok: true;
  readonly witness: RecoveryCompletionWitness;
}

export type RecoveryCompletionOutcome = RecoveryCompletionAccepted | RecoveryCompletionRefused;

export const recoveryCompletionEventId = (commandId: string): string =>
  `recovery-complete:${commandId}:recovered`;

export function acceptedRecoveryCompletion(
  decision: CommandDecisionRecord,
  disposition: "DECIDED" | "REPLAYED",
  witness: RecoveryCompletionWitness,
): RecoveryCompletionAccepted {
  return Object.freeze({
    advisoryOnly: false as const,
    authority: "DURABLE_DECISION" as const,
    decision,
    disposition,
    kind: RECOVERY_COMPLETION_COMMAND_KIND,
    ok: true as const,
    witness,
  });
}

function durableEvent(
  store: SqliteEventStore,
  request: RecoveryCompleteRequest,
  prior: CommandDecisionRecord,
): StoredEvent | RecoveryCompletionRefused {
  const previous = prior.previousVersion;
  const wanted = recoveryCompletionEventId(request.commandId);
  if (previous === null || prior.currentVersion !== previous + 1
    || prior.businessEventIds.length !== 1 || prior.businessEventIds[0] !== wanted) {
    return evidenceMismatched("The stored completion decision has no single recovery effect.");
  }
  let event: StoredEvent | undefined;
  try {
    event = store.readAggregateEvents(request.projectId, previous, 1).items[0];
  } catch (error) {
    return storeUnavailable(error);
  }
  if (event === undefined || event.eventId !== wanted || event.eventType !== "ProjectRecovered"
    || event.aggregateSequence !== prior.currentVersion
    || event.decisionTrace?.requestSha256 !== prior.requestSha256) {
    return evidenceAbsent("The stored completion decision has no readable recovered event.");
  }
  return event;
}

function replayDecision(
  store: SqliteEventStore,
  request: RecoveryCompleteRequest,
  prior: CommandDecisionRecord,
  event: StoredEvent,
): CommandDecisionRecord | RecoveryCompletionRefused {
  try {
    const replay = store.commitExpectedVersionDecision({
      commandKind: RECOVERY_COMPLETION_COMMAND_KIND,
      committedResultBytes: prior.resultBytes,
      correlationId: request.correlationId,
      decidedAt: request.decidedAt,
      events: [{
        domainSchemaVersion: event.domainSchemaVersion,
        eventId: event.eventId,
        eventType: event.eventType,
        metadata: event.metadata,
        payload: event.payload,
      }],
      expectedVersion: request.expectedVersion,
      key: {
        commandId: request.commandId,
        principalId: request.principalId,
        projectId: request.projectId,
      },
      requestBytes: request.bytes,
      targetAggregateId: request.projectId,
    });
    return replay.disposition === "REPLAYED"
      && replay.decision.decisionSha256 === prior.decisionSha256
      ? replay.decision
      : evidenceMismatched("The durable replay did not return the stored decision.");
  } catch (error) {
    return error instanceof IdempotencyConflictError
      ? completionIdempotencyConflict()
      : storeUnavailable(error);
  }
}

function witnessOf(event: StoredEvent): RecoveryCompletionWitness | null {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(event.payload));
    const witness = (parsed as { witness?: RecoveryCompletionWitness }).witness;
    return witness ?? null;
  } catch {
    return null;
  }
}

/** Exact request identity is re-adjudicated by the durable store before replay. */
export function answerRecoveryCompletionReplay(
  store: SqliteEventStore,
  request: RecoveryCompleteRequest,
  prior: CommandDecisionRecord,
): RecoveryCompletionOutcome {
  if (prior.commandKind !== RECOVERY_COMPLETION_COMMAND_KIND
    || prior.targetAggregateId !== request.projectId
    || prior.effectDisposition !== "EFFECTS_COMMITTED") {
    return evidenceMismatched("A different command already holds this command identity.");
  }
  const event = durableEvent(store, request, prior);
  if ("ok" in event) return event;
  const replay = replayDecision(store, request, prior, event);
  if ("ok" in replay) return replay;
  const witness = witnessOf(event);
  if (witness === null) return evidenceAbsent("The stored completion event has no witness.");
  if (witness.inventoryReconciliationHash !== request.reconciliationDigest) {
    return evidenceMismatched("The replayed completion bound a different reconciliation record.");
  }
  return acceptedRecoveryCompletion(replay, "REPLAYED", witness);
}
