import { RUNTIME_LIFECYCLES, decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { AdmissionHumanApproval } from "@moe/scheduler";
import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION, COMMAND_EFFECT_IDENTITY_VERSION,
} from "@moe/store";
import type {
  CommandDecisionKey, CommandDecisionRecord, CommandReceipt, StoredEvent,
} from "@moe/store";

export interface HumanApprovalAuthorityStore {
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

type RefusalCode =
  | "ADMISSION_GATE_SCOPE_MISMATCH"
  | "ADMISSION_GATE_SUBJECT_MISMATCH"
  | "ADMISSION_GATE_WITNESS_ABSENT";

export type HumanApprovalAuthorityResult =
  | { readonly approval: AdmissionHumanApproval; readonly ok: true }
  | { readonly code: RefusalCode; readonly ok: false };

const HEX64 = /^[0-9a-f]{64}$/u;
const refuse = (code: RefusalCode): HumanApprovalAuthorityResult =>
  Object.freeze({ code, ok: false as const });
const absent = (): HumanApprovalAuthorityResult => refuse("ADMISSION_GATE_WITNESS_ABSENT");
const subject = (): HumanApprovalAuthorityResult => refuse("ADMISSION_GATE_SUBJECT_MISMATCH");

function objectValue(value: JsonValue | undefined): JsonObject | null {
  return value === null || value === undefined || typeof value !== "object"
    || Array.isArray(value) ? null : value as JsonObject;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const single = (values: readonly string[], expected: string): boolean =>
  values.length === 1 && values[0] === expected;

function decodeObject(bytes: Uint8Array): JsonObject | null {
  const decoded = decodeBoundedJsonBytes(bytes);
  return decoded.ok ? objectValue(decoded.value) : null;
}

function decisionAgrees(
  decision: CommandDecisionRecord, event: StoredEvent,
  trace: NonNullable<StoredEvent["decisionTrace"]>, projectId: string,
): boolean {
  const prior = event.aggregateSequence - 1;
  return decision.effectDisposition === "EFFECTS_COMMITTED"
    && decision.resultCode === "EFFECTS_COMMITTED"
    && decision.commandKind === "approval.decide"
    && decision.requestIdentityVersion === COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    && decision.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && decision.key.commandId === trace.commandId
    && decision.key.principalId === trace.principalId
    && decision.key.projectId === projectId
    && decision.targetAggregateId === event.aggregateId
    && decision.expectedVersion === prior
    && decision.observedVersion === prior
    && decision.previousVersion === prior
    && decision.currentVersion === event.aggregateSequence
    && single(decision.businessEventIds, event.eventId)
    && decision.outboxMessageIds.length === 0
    && decision.requestSha256 === trace.requestSha256
    && decision.decidedAt === event.committedAt;
}

function receiptAgrees(
  receipt: CommandReceipt, decision: CommandDecisionRecord, event: StoredEvent,
): boolean {
  const prior = event.aggregateSequence - 1;
  return receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && receipt.commandId === event.commandId
    && receipt.aggregateId === event.aggregateId
    && receipt.previousVersion === prior
    && receipt.currentVersion === event.aggregateSequence
    && single(receipt.eventIds, event.eventId)
    && receipt.outboxMessageIds.length === 0
    && receipt.committedAt === event.committedAt
    && receipt.effectSha256 === decision.effectSha256
    && receipt.requestSha256 === event.requestSha256;
}

function eventOf(store: HumanApprovalAuthorityStore, goalRef: string): StoredEvent | null {
  try {
    const events = store.readEvents(goalRef).filter((event) =>
      event.aggregateId === goalRef && event.eventType === "GoalExecutionEnabled");
    return events.length === 1 ? events[0] ?? null : null;
  } catch {
    return null;
  }
}

/** Re-proves one human gate from event -> command decision -> primary effect receipt. */
export function readHumanApprovalAuthority(input: {
  readonly graphRevisionRef: string;
  readonly goalRef: string;
  readonly nodeKey: string;
  readonly projectId: string;
  readonly store: HumanApprovalAuthorityStore;
}): HumanApprovalAuthorityResult {
  const event = eventOf(input.store, input.goalRef);
  if (event === null || !Number.isSafeInteger(event.aggregateSequence)
    || event.aggregateSequence < 1 || !HEX64.test(event.requestSha256)) return absent();
  const trace = event.decisionTrace;
  if (trace === undefined || !nonEmpty(trace.commandId) || !nonEmpty(trace.principalId)
    || !HEX64.test(trace.requestSha256)
    || trace.requestIdentityVersion !== COMMAND_DECISION_REQUEST_IDENTITY_VERSION) return absent();
  if (trace.commandKind !== "approval.decide" || trace.projectId !== input.projectId) {
    return subject();
  }
  let decision: CommandDecisionRecord | null;
  try {
    decision = input.store.getCommandDecision({
      commandId: trace.commandId, principalId: trace.principalId, projectId: input.projectId,
    });
  } catch {
    return absent();
  }
  if (decision === null) return absent();
  if (!decisionAgrees(decision, event, trace, input.projectId)) return subject();
  let receipt: CommandReceipt | null;
  try {
    receipt = input.store.getCommandReceipt(event.commandId);
  } catch {
    return absent();
  }
  if (receipt === null) return absent();
  if (!receiptAgrees(receipt, decision, event)) return subject();
  const result = decodeObject(decision.resultBytes);
  if (result === null) return absent();
  if (result["goalId"] !== input.goalRef || result["projectId"] !== input.projectId
    || result["activeGraphRevisionRef"] !== input.graphRevisionRef
    || result["lifecycle"] !== "EXECUTION_ENABLED") return subject();
  const payload = decodeObject(event.payload);
  const activation = payload === null ? null : objectValue(payload["activation"]);
  const approval = payload === null ? null : objectValue(payload["approval"]);
  if (activation === null || approval === null) return absent();
  const approvalRef = approval["approvalRef"], actor = approval["actor"];
  const decisionValue = approval["decision"], validity = approval["validity"];
  const scope = approval["approvedNodeScope"];
  if (!nonEmpty(approvalRef) || !nonEmpty(actor) || approval["actorKind"] !== "HUMAN"
    || approval["truthClass"] !== "HUMAN_APPROVED"
    || !RUNTIME_LIFECYCLES.APPROVAL_DECISION.includes(decisionValue as never)
    || !RUNTIME_LIFECYCLES.APPROVAL_VALIDITY.includes(validity as never)
    || !Array.isArray(scope) || !scope.every(nonEmpty)) return absent();
  if (actor !== trace.principalId
    || activation["activeGraphRevisionRef"] !== input.graphRevisionRef
    || activation["graphApprovalRef"] !== approvalRef
    || activation["truthClass"] !== "HUMAN_APPROVED") return subject();
  if (!scope.includes(input.nodeKey)) return refuse("ADMISSION_GATE_SCOPE_MISMATCH");
  return Object.freeze({
    approval: Object.freeze({
      approvalRef,
      decision: decisionValue as AdmissionHumanApproval["decision"],
      validity: validity as AdmissionHumanApproval["validity"],
    }),
    ok: true as const,
  });
}
