import { DurableStoreError } from "./store-contracts.js";
import {
  expectedVersionConflictResultBytes,
  rejectionAuditAggregateId,
  rejectionAuditEventId,
  rejectionAuditPayload,
} from "./store-digests.js";
import {
  DecisionLedgerIntegrityError,
} from "./decision-leg-roster.js";
import type { DecisionLegRoster } from "./decision-leg-roster.js";
import type { StoredCommandDecision, StoredReceipt } from "./store-internals.js";
import {
  bytesEqual,
  requireRowBytes,
  requireRowString,
  requireStoredIdentifier,
} from "./store-rows.js";

export type DecisionCommonFields = Pick<StoredCommandDecision,
  | "commandKind"
  | "correlationSha256"
  | "coverage"
  | "decidedAt"
  | "decisionId"
  | "decisionIdentityVersion"
  | "decisionPosition"
  | "decisionSha256"
  | "effectIdentityVersion"
  | "effectSha256"
  | "expectedVersion"
  | "key"
  | "legCount"
  | "legRosterSha256"
  | "legRosterVersion"
  | "observedVersion"
  | "receiptCommandId"
  | "recordVersion"
  | "requestIdentityVersion"
  | "requestSha256"
  | "resultBytes"
  | "resultSha256"
  | "resultVersion"
  | "targetAggregateId"
>;

export interface DecisionDispositionInput {
  readonly auditEventId: string | null;
  readonly businessEventCount: number;
  readonly common: DecisionCommonFields;
  readonly currentVersion: number | null;
  readonly legRoster: DecisionLegRoster;
  readonly outboxCount: number;
  readonly previousVersion: number | null;
  readonly receipt: StoredReceipt;
  readonly row: Record<string, unknown>;
}

export interface DecisionDispositionContext {
  readonly assertAggregateTail: (aggregateId: string) => number;
  readonly loadRejectionAuditRow: (
    auditEventId: string,
  ) => Record<string, unknown> | undefined;
}

function assertCommittedRoster(input: DecisionDispositionInput): void {
  const { common, legRoster, receipt } = input;
  const primary = legRoster.legs[0]!;
  if (
    primary.aggregateId !== common.targetAggregateId ||
    primary.expectedVersion !== common.expectedVersion ||
    primary.receiptCommandId !== common.receiptCommandId ||
    primary.receiptRequestSha256 !== receipt.requestSha256 ||
    primary.receiptEffectSha256 !== common.effectSha256
  ) {
    throw new DecisionLedgerIntegrityError();
  }
}

function assertCommittedFields(input: DecisionDispositionInput): void {
  const { common, receipt, row } = input;
  if (
    requireRowString(row, "result_code") !== "EFFECTS_COMMITTED" ||
    input.auditEventId !== null ||
    input.previousVersion === null ||
    input.currentVersion === null ||
    common.observedVersion !== common.expectedVersion ||
    input.previousVersion !== common.expectedVersion ||
    receipt.aggregateId !== common.targetAggregateId ||
    receipt.previousVersion !== input.previousVersion ||
    receipt.currentVersion !== input.currentVersion ||
    receipt.eventIds.length !== input.businessEventCount ||
    receipt.outboxMessageIds.length !== input.outboxCount
  ) {
    throw new DecisionLedgerIntegrityError();
  }
}

function committedDecision(input: DecisionDispositionInput): StoredCommandDecision {
  assertCommittedRoster(input);
  assertCommittedFields(input);
  const { common, currentVersion, previousVersion, receipt } = input;
  if (currentVersion === null || previousVersion === null) {
    throw new DecisionLedgerIntegrityError();
  }
  return {
    ...common,
    auditEventId: null,
    businessEventIds: receipt.eventIds,
    currentVersion,
    effectDisposition: "EFFECTS_COMMITTED",
    outboxMessageIds: receipt.outboxMessageIds,
    previousVersion,
    replayRequestSha256: receipt.requestSha256,
    resultCode: "EFFECTS_COMMITTED",
  };
}

interface RejectionEvidence {
  readonly auditAggregateId: string;
  readonly auditEventId: string;
}

function requireRejectionEvidence(
  input: DecisionDispositionInput,
  ctx: DecisionDispositionContext,
): RejectionEvidence {
  const { common, legRoster, receipt, row } = input;
  if (
    legRoster.legs.some((leg) => leg.receiptCommandId !== null) ||
    !legRoster.legs.some((leg) =>
      leg.aggregateId === common.targetAggregateId &&
      leg.expectedVersion === common.expectedVersion)
  ) {
    throw new DecisionLedgerIntegrityError();
  }
  const auditEventId = rejectionAuditEventId(common.decisionId);
  const auditAggregateId = rejectionAuditAggregateId(common.decisionId);
  const expectedResultBytes = expectedVersionConflictResultBytes(
    common.expectedVersion,
    common.observedVersion,
  );
  if (
    requireRowString(row, "result_code") !== "EXPECTED_VERSION_CONFLICT" ||
    input.auditEventId !== auditEventId ||
    input.previousVersion !== null || input.currentVersion !== null ||
    common.observedVersion === common.expectedVersion ||
    input.businessEventCount !== 0 || input.outboxCount !== 0 ||
    receipt.aggregateId !== auditAggregateId ||
    receipt.previousVersion !== 0 || receipt.currentVersion !== 1 ||
    receipt.eventIds.length !== 1 || receipt.eventIds[0] !== auditEventId ||
    receipt.outboxMessageIds.length !== 0 ||
    ctx.assertAggregateTail(auditAggregateId) !== 1 ||
    !bytesEqual(common.resultBytes, expectedResultBytes)
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `no-business-effect command decision ${common.decisionPosition} has contradictory durable fields`,
    );
  }
  return { auditAggregateId, auditEventId };
}

function assertRejectionAudit(
  input: DecisionDispositionInput,
  ctx: DecisionDispositionContext,
  evidence: RejectionEvidence,
): void {
  const { common } = input;
  const auditRow = ctx.loadRejectionAuditRow(evidence.auditEventId);
  const expectedPayload = rejectionAuditPayload({
    commandId: common.key.commandId,
    commandKind: common.commandKind,
    decisionId: common.decisionId,
    expectedVersion: common.expectedVersion,
    observedVersion: common.observedVersion,
    principalId: common.key.principalId,
    projectId: common.key.projectId,
    requestSha256: common.requestSha256,
    targetAggregateId: common.targetAggregateId,
  });
  if (
    auditRow === undefined ||
    requireStoredIdentifier(auditRow, "aggregate_id") !== evidence.auditAggregateId ||
    requireStoredIdentifier(auditRow, "command_id") !== common.receiptCommandId ||
    requireStoredIdentifier(auditRow, "event_type") !== "command.expected-version-rejected" ||
    !bytesEqual(requireRowBytes(auditRow, "payload"), expectedPayload) ||
    requireRowBytes(auditRow, "metadata").byteLength !== 0
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${common.decisionPosition} has a malformed rejection audit event`,
    );
  }
}

function rejectedDecision(
  input: DecisionDispositionInput,
  ctx: DecisionDispositionContext,
): StoredCommandDecision {
  const evidence = requireRejectionEvidence(input, ctx);
  assertRejectionAudit(input, ctx, evidence);
  return {
    ...input.common,
    auditEventId: evidence.auditEventId,
    businessEventIds: [],
    currentVersion: null,
    effectDisposition: "NO_BUSINESS_EFFECT",
    outboxMessageIds: [],
    previousVersion: null,
    replayRequestSha256: null,
    resultCode: "EXPECTED_VERSION_CONFLICT",
  };
}

export function decodeDecisionDisposition(
  disposition: "EFFECTS_COMMITTED" | "NO_BUSINESS_EFFECT",
  input: DecisionDispositionInput,
  ctx: DecisionDispositionContext,
): StoredCommandDecision {
  return disposition === "EFFECTS_COMMITTED"
    ? committedDecision(input)
    : rejectedDecision(input, ctx);
}
