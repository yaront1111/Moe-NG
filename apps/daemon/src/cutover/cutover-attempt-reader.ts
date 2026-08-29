import { reduceCutover } from "@moe/core";
import type { CutoverAttemptState, CutoverRejectedResult } from "@moe/core";
import { DurableStoreError } from "@moe/store";
import type { DurableStoreErrorCode, StoredEvent } from "@moe/store";

import {
  CUTOVER_ATTEMPT_COMMAND_KIND,
  CUTOVER_ATTEMPT_EVENT_TYPE,
  CUTOVER_ATTEMPT_LAYER,
  decodeCutoverAttemptEvent,
  deriveCutoverAttemptAggregateId,
} from "./cutover-attempt-contracts.js";
import type {
  CutoverAttemptAdmittedRecord,
  CutoverAttemptCode,
  CutoverAttemptStore,
} from "./cutover-attempt-contracts.js";

export interface CutoverAttemptPresent {
  readonly admitted: CutoverAttemptAdmittedRecord | null;
  readonly state: CutoverAttemptState;
  readonly status: "PRESENT";
  readonly version: number;
}

export interface CutoverAttemptAbsent {
  readonly code: "CUTOVER_ATTEMPT_STATE_ABSENT";
  readonly layer: typeof CUTOVER_ATTEMPT_LAYER;
  readonly status: "ABSENT";
}

export interface CutoverAttemptUnreadable {
  readonly code: CutoverAttemptCode;
  readonly layer: typeof CUTOVER_ATTEMPT_LAYER;
  readonly status: "UNREADABLE";
  readonly storeCode: DurableStoreErrorCode | null;
}

export interface CutoverAttemptReducerUnreadable {
  readonly code: CutoverRejectedResult["error"]["code"];
  readonly layer: "CUTOVER";
  readonly status: "UNREADABLE";
  readonly storeCode: null;
}

export type CutoverAttemptReadResult =
  | CutoverAttemptPresent
  | CutoverAttemptAbsent
  | CutoverAttemptUnreadable
  | CutoverAttemptReducerUnreadable;

function unreadable(
  code: CutoverAttemptCode,
  storeCode: DurableStoreErrorCode | null = null,
): CutoverAttemptUnreadable {
  return Object.freeze({ code, layer: CUTOVER_ATTEMPT_LAYER, status: "UNREADABLE" as const, storeCode });
}

function storeUnreadable(error: unknown): CutoverAttemptUnreadable {
  return unreadable(
    "CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE",
    error instanceof DurableStoreError ? error.code : null,
  );
}

function reducerUnreadable(result: CutoverRejectedResult): CutoverAttemptReducerUnreadable {
  return Object.freeze({
    code: result.error.code,
    layer: result.layer,
    status: "UNREADABLE" as const,
    storeCode: null,
  });
}

function foldEvents(
  events: readonly StoredEvent[], aggregateId: string, projectId: string,
): CutoverAttemptReadResult {
  let state: CutoverAttemptState | undefined;
  let admitted: CutoverAttemptAdmittedRecord | null = null;
  for (const [index, event] of events.entries()) {
    if (event.aggregateSequence !== index + 1) return unreadable("CUTOVER_ATTEMPT_SEQUENCE_INVALID");
    if (event.aggregateId !== aggregateId) return unreadable("CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE");
    if (event.eventType !== CUTOVER_ATTEMPT_EVENT_TYPE) {
      return unreadable("CUTOVER_ATTEMPT_EVENT_TYPE_UNEXPECTED");
    }
    const decoded = decodeCutoverAttemptEvent(event.payload);
    if (!decoded.ok) return unreadable(decoded.code, decoded.storeCode);
    const trace = event.decisionTrace;
    const commandId = trace?.commandId ?? event.commandId;
    if (commandId !== decoded.value.command.commandId || (trace !== undefined
      && (trace.commandKind !== decoded.value.command.kind || trace.projectId !== projectId))) {
      return unreadable("CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE");
    }
    const isApproval = decoded.value.command.kind === CUTOVER_ATTEMPT_COMMAND_KIND;
    if ((isApproval && decoded.value.admitted === null) || (!isApproval && decoded.value.admitted !== null)) {
      return unreadable("CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE");
    }
    const reduced = reduceCutover(state, decoded.value.command);
    if (!reduced.ok) return reducerUnreadable(reduced);
    state = reduced.state;
    if (isApproval) admitted = decoded.value.admitted;
  }
  if (state === undefined) return unreadable("CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE");
  return Object.freeze({ admitted, state, status: "PRESENT" as const, version: events.length });
}

export function readCutoverAttemptState(
  store: Pick<CutoverAttemptStore, "readEvents">,
  input: Readonly<{ projectId: string }>,
): CutoverAttemptReadResult {
  const aggregateId = deriveCutoverAttemptAggregateId(input.projectId);
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(aggregateId);
  } catch (error) {
    return storeUnreadable(error);
  }
  if (events.length === 0) {
    return Object.freeze({
      code: "CUTOVER_ATTEMPT_STATE_ABSENT",
      layer: CUTOVER_ATTEMPT_LAYER,
      status: "ABSENT" as const,
    });
  }
  return foldEvents(events, aggregateId, input.projectId);
}
