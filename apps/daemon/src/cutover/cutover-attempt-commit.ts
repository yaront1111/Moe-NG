import { ACTIVATION_GENERATION_KEYS, admitActivationBinding } from "@moe/benchmark";
import type { ActivationBindingAdmission } from "@moe/benchmark";
import { reduceCutover } from "@moe/core";
import type {
  CutoverAdmitActivateApprovalCommand,
  CutoverAttemptState,
  CutoverRejectedResult,
} from "@moe/core";
import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandDecisionResponse,
  DurableStoreErrorCode,
} from "@moe/store";

import {
  CUTOVER_ATTEMPT_COMMAND_KIND,
  CUTOVER_ATTEMPT_EVENT_TYPE,
  CUTOVER_ATTEMPT_LAYER,
  cutoverAttemptRefusal,
  deriveCutoverAttemptAggregateId,
  deriveCutoverDecisionId,
  encodeCutoverAttemptEvent,
} from "./cutover-attempt-contracts.js";
import type {
  CutoverAttemptAdmittedRecord,
  CutoverAttemptCode,
  CutoverAttemptRefusal,
  CutoverAttemptStore,
} from "./cutover-attempt-contracts.js";
import { readCutoverAttemptState } from "./cutover-attempt-reader.js";
import type { CutoverAttemptReadResult } from "./cutover-attempt-reader.js";

export interface AdmitCutoverActivateApprovalInput {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly projectId: string;
  readonly record: unknown;
}

type AdmissionRefusal = Exclude<ActivationBindingAdmission, { readonly ok: true }>;

export interface CutoverAttemptReadRefusal {
  readonly code: CutoverAttemptCode | import("@moe/contracts").RuntimeError["code"];
  readonly layer: typeof CUTOVER_ATTEMPT_LAYER | "CUTOVER";
  readonly ok: false;
  readonly storeCode: DurableStoreErrorCode | null;
}

export interface CutoverActivateApprovalAccepted {
  readonly aggregateId: string;
  readonly decisionId: string;
  readonly disposition: "COMMITTED" | "REPLAYED";
  readonly ok: true;
  readonly state: CutoverAttemptState;
}

export type CutoverActivateApprovalResult =
  | CutoverActivateApprovalAccepted
  | CutoverAttemptRefusal
  | CutoverAttemptReadRefusal
  | CutoverRejectedResult
  | AdmissionRefusal;

function readRefusal(
  result: Extract<CutoverAttemptReadResult, { readonly status: "UNREADABLE" }>,
): CutoverAttemptReadRefusal {
  return Object.freeze({
    code: result.code,
    layer: result.layer,
    ok: false as const,
    storeCode: result.storeCode,
  });
}

function storeRefusal(error: unknown): CutoverAttemptRefusal {
  if (!(error instanceof DurableStoreError)) {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_STORE_UNAVAILABLE");
  }
  if (error.code === "EXPECTED_VERSION_CONFLICT") {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_EXPECTED_VERSION_CONFLICT", error.code);
  }
  if (error.code === "STORE_INPUT_INVALID" || error.code === "STORE_LIMIT_EXCEEDED") {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_FIELD_INVALID", error.code);
  }
  return cutoverAttemptRefusal("CUTOVER_ATTEMPT_STORE_UNAVAILABLE", error.code);
}

function admittedRecord(admission: Extract<ActivationBindingAdmission, { readonly ok: true }>):
CutoverAttemptAdmittedRecord | null {
  const grant = admission.binding.authority.grant;
  if (grant === null) return null;
  const generations = Object.fromEntries(
    ACTIVATION_GENERATION_KEYS.map((key) => [key, admission.binding.generations[key]]),
  ) as Readonly<Record<(typeof ACTIVATION_GENERATION_KEYS)[number], string>>;
  return Object.freeze({
    generations: Object.freeze(generations),
    grantedAtEpochMs: grant.grantedAtEpochMs,
    principalId: grant.principalId,
    sourceCommit: admission.binding.sourceCommit,
  });
}

function command(decisionId: string, expectedVersion: number): CutoverAdmitActivateApprovalCommand {
  return Object.freeze({
    commandId: decisionId,
    expectedVersion,
    kind: CUTOVER_ATTEMPT_COMMAND_KIND,
    witness: Object.freeze({ approvalRef: decisionId, truthClass: "HUMAN_APPROVED" as const }),
  });
}

function replayDecisionMatches(
  decision: CommandDecisionRecord | null,
  key: CommandDecisionKey,
  aggregateId: string,
  foldedVersion: number,
): decision is Extract<CommandDecisionRecord, { readonly effectDisposition: "EFFECTS_COMMITTED" }> {
  return decision !== null && decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.commandKind === CUTOVER_ATTEMPT_COMMAND_KIND
    && decision.targetAggregateId === aggregateId
    && decision.expectedVersion === foldedVersion - 1
    && decision.currentVersion === foldedVersion
    && decision.key.commandId === key.commandId
    && decision.key.principalId === key.principalId
    && decision.key.projectId === key.projectId;
}

function admittedMatches(
  durable: CutoverAttemptAdmittedRecord | null,
  candidate: CutoverAttemptAdmittedRecord,
): boolean {
  return durable !== null && durable.grantedAtEpochMs === candidate.grantedAtEpochMs
    && durable.principalId === candidate.principalId && durable.sourceCommit === candidate.sourceCommit
    && ACTIVATION_GENERATION_KEYS.every((key) =>
      durable.generations[key] === candidate.generations[key]);
}

function answerReplayed(
  store: CutoverAttemptStore,
  projectId: string,
  aggregateId: string,
  decisionId: string,
  admitted: CutoverAttemptAdmittedRecord,
): CutoverActivateApprovalResult {
  const durable = readCutoverAttemptState(store, { projectId });
  if (durable.status === "UNREADABLE") return readRefusal(durable);
  if (durable.status !== "PRESENT" || durable.state.lifecycle !== "ACTIVATE_APPROVED"
    || durable.state.activateApprovalRef !== decisionId || !admittedMatches(durable.admitted, admitted)) {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_REPLAY_DIVERGED");
  }
  return Object.freeze({
    aggregateId,
    decisionId,
    disposition: "REPLAYED" as const,
    ok: true as const,
    state: durable.state,
  });
}

interface PreparedApproval {
  readonly admitted: CutoverAttemptAdmittedRecord;
  readonly aggregateId: string;
  readonly approvalCommand: CutoverAdmitActivateApprovalCommand;
  readonly decisionId: string;
  readonly key: CommandDecisionKey;
  readonly nextState: CutoverAttemptState;
  readonly replayCandidate: boolean;
}

function commitApproval(
  store: CutoverAttemptStore,
  input: AdmitCutoverActivateApprovalInput,
  prepared: PreparedApproval,
): CutoverActivateApprovalResult {
  const { admitted, aggregateId, approvalCommand, decisionId, key, nextState } = prepared;
  const bytes = encodeCutoverAttemptEvent({ admitted, command: approvalCommand });
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: CUTOVER_ATTEMPT_COMMAND_KIND, committedResultBytes: bytes,
      correlationId: input.correlationId, decidedAt: input.decidedAt,
      events: [{ eventId: decisionId, eventType: CUTOVER_ATTEMPT_EVENT_TYPE, payload: bytes }],
      expectedVersion: approvalCommand.expectedVersion, key, requestBytes: bytes,
      targetAggregateId: aggregateId,
    });
  } catch (error) {
    return storeRefusal(error);
  }
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_EXPECTED_VERSION_CONFLICT", response.decision.resultCode);
  }
  if (response.disposition === "REPLAYED") {
    return answerReplayed(store, input.projectId, aggregateId, decisionId, admitted);
  }
  if (prepared.replayCandidate) return cutoverAttemptRefusal("CUTOVER_ATTEMPT_REPLAY_DIVERGED");
  return Object.freeze({ aggregateId, decisionId, disposition: "COMMITTED" as const,
    ok: true as const, state: nextState });
}

export function admitCutoverActivateApproval(
  store: CutoverAttemptStore,
  input: AdmitCutoverActivateApprovalInput,
): CutoverActivateApprovalResult {
  const admission = admitActivationBinding(input.record);
  if (!admission.ok) return admission;
  const fold = readCutoverAttemptState(store, { projectId: input.projectId });
  if (fold.status === "UNREADABLE") return readRefusal(fold);
  const state = fold.status === "PRESENT" ? fold.state : undefined;
  const foldedVersion = fold.status === "PRESENT" ? fold.version : 0;
  if (state !== undefined && state.version !== foldedVersion) {
    return cutoverAttemptRefusal("CUTOVER_ATTEMPT_VERSION_DESYNC");
  }
  const admitted = admittedRecord(admission);
  if (admitted === null) return cutoverAttemptRefusal("CUTOVER_ATTEMPT_FIELD_INVALID");
  const decisionId = deriveCutoverDecisionId(admission.binding);
  const aggregateId = deriveCutoverAttemptAggregateId(input.projectId);
  const key = { commandId: decisionId, principalId: admitted.principalId, projectId: input.projectId };
  const replayCandidate = state?.lifecycle === "ACTIVATE_APPROVED"
    && state.activateApprovalRef === decisionId;
  let expectedVersion = foldedVersion;
  if (replayCandidate) {
    let prior: CommandDecisionRecord | null;
    try {
      prior = store.getCommandDecision(key);
    } catch (error) {
      return storeRefusal(error);
    }
    if (!replayDecisionMatches(prior, key, aggregateId, foldedVersion)) {
      return cutoverAttemptRefusal("CUTOVER_ATTEMPT_REPLAY_DIVERGED");
    }
    expectedVersion = prior.expectedVersion;
  }
  const approvalCommand = command(decisionId, expectedVersion);
  let nextState = state;
  if (!replayCandidate) {
    const reduced = reduceCutover(state, approvalCommand);
    if (!reduced.ok) return reduced;
    nextState = reduced.state;
  }
  if (nextState === undefined) return cutoverAttemptRefusal("CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE");
  return commitApproval(store, input, {
    admitted, aggregateId, approvalCommand, decisionId, key, nextState, replayCandidate,
  });
}
