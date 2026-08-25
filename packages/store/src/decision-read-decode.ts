import {
  COMMAND_DECISION_IDENTITY_VERSION,
  COMMAND_DECISION_RECORD_VERSION,
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_DECISION_RESULT_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  DurableStoreError,
  EXPECTED_VERSION_DECISION_COVERAGE,
} from "./store-contracts.js";
import {
  expectedVersionConflictResultBytes,
  identifyCommandDecision,
  identifyCommandDecisionId,
  identifyDecisionResult,
  internalReceiptCommandId,
  rejectionAuditAggregateId,
  rejectionAuditEventId,
  rejectionAuditPayload,
} from "./store-digests.js";
import {
  DecisionLedgerIntegrityError,
  identifyDecisionLegRoster,
} from "./decision-leg-roster.js";
import type { DecisionLegRoster } from "./decision-leg-roster.js";
import type { StoredCommandDecision, StoredReceipt } from "./store-internals.js";
import {
  bytesEqual,
  requireNullableStoredIdentifier,
  requireNullableStoredIntegerAtLeast,
  requireRowBytes,
  requireRowString,
  requireStoredIdentifier,
  requireStoredIntegerAtLeast,
  requireStoredPositiveBigIntText,
  requireStoredSha256,
  requireStoredTimestamp,
} from "./store-rows.js";

/**
 * Ancestor capabilities the decoder borrows. The owning store supplies these as
 * arrow closures so every call late-binds through the prototype chain.
 */
export interface DecisionDecodeContext {
  readonly projectId: string | null;
  readonly requireStoredVersion: <const Version extends string>(
    row: Record<string, unknown>,
    column: string,
    expected: Version,
  ) => Version;
  readonly loadReceipt: (
    commandId: string,
    validateAggregateTail?: boolean,
    liveBindingAlreadyValidated?: boolean,
  ) => StoredReceipt | null;
  readonly assertAggregateTail: (aggregateId: string) => number;
  readonly loadRejectionAuditRow: (
    auditEventId: string,
  ) => Record<string, unknown> | undefined;
  readonly loadDecisionLegRoster: (
    decisionId: string,
    liveBindingAlreadyValidated?: boolean,
  ) => DecisionLegRoster;
}

/**
 * Rebuilds a stored command decision from its row and re-proves every durable
 * digest. `liveBindingAlreadyValidated` stays an explicit parameter because it
 * gates the live-binding check inside `loadReceipt`: paging reads validate the
 * binding once per snapshot, every other path validates per row.
 */
export function decodeStoredCommandDecision(
  row: Record<string, unknown>,
  ctx: DecisionDecodeContext,
  liveBindingAlreadyValidated = false,
): StoredCommandDecision {
  const decisionPosition = requireStoredPositiveBigIntText(row, "decision_position");
  const key = Object.freeze({
    commandId: requireStoredIdentifier(row, "command_id"),
    principalId: requireStoredIdentifier(row, "principal_id"),
    projectId: requireStoredIdentifier(row, "project_id"),
  });
  if (ctx.projectId === null || key.projectId !== ctx.projectId) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${decisionPosition} is outside the database project binding`,
    );
  }
  const decisionId = requireStoredSha256(row, "decision_id");
  if (identifyCommandDecisionId(key) !== decisionId) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${decisionPosition} has a mismatched composite identity`,
    );
  }
  const recordVersion = ctx.requireStoredVersion(
    row,
    "record_version",
    COMMAND_DECISION_RECORD_VERSION,
  );
  const coverage = ctx.requireStoredVersion(
    row,
    "coverage",
    EXPECTED_VERSION_DECISION_COVERAGE,
  );
  const requestIdentityVersion = ctx.requireStoredVersion(
    row,
    "request_identity_version",
    COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  );
  const requestSha256 = requireStoredSha256(row, "request_sha256");
  const commandKind = requireStoredIdentifier(row, "command_kind");
  const targetAggregateId = requireStoredIdentifier(row, "target_aggregate_id");
  const expectedVersion = requireStoredIntegerAtLeast(row, "expected_version", 0);
  const observedVersion = requireStoredIntegerAtLeast(row, "observed_version", 0);
  const rawDisposition = requireRowString(row, "effect_disposition");
  if (
    rawDisposition !== "EFFECTS_COMMITTED" &&
    rawDisposition !== "NO_BUSINESS_EFFECT"
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${decisionPosition} has an unsupported effect disposition`,
    );
  }
  const resultVersion = ctx.requireStoredVersion(
    row,
    "result_version",
    COMMAND_DECISION_RESULT_VERSION,
  );
  const resultBytes = requireRowBytes(row, "result_bytes");
  const resultSha256 = requireStoredSha256(row, "result_sha256");
  if (identifyDecisionResult(resultBytes) !== resultSha256) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${decisionPosition} result digest does not match`,
    );
  }
  const decidedAt = requireStoredTimestamp(row, "decided_at");
  const correlationSha256 = requireStoredSha256(row, "correlation_sha256");
  const receiptCommandId = requireStoredIdentifier(row, "receipt_command_id");
  const auditEventId = requireNullableStoredIdentifier(row, "audit_event_id");
  const previousVersion = requireNullableStoredIntegerAtLeast(
    row,
    "previous_version",
    0,
  );
  const currentVersion = requireNullableStoredIntegerAtLeast(row, "current_version", 1);
  const businessEventCount = requireStoredIntegerAtLeast(
    row,
    "business_event_count",
    0,
  );
  const outboxCount = requireStoredIntegerAtLeast(row, "outbox_count", 0);
  const effectIdentityVersion = ctx.requireStoredVersion(
    row,
    "effect_identity_version",
    COMMAND_EFFECT_IDENTITY_VERSION,
  );
  const effectSha256 = requireStoredSha256(row, "effect_sha256");
  const decisionIdentityVersion = ctx.requireStoredVersion(
    row,
    "decision_identity_version",
    COMMAND_DECISION_IDENTITY_VERSION,
  );
  const decisionSha256 = requireStoredSha256(row, "decision_sha256");
  if (receiptCommandId !== internalReceiptCommandId(decisionId)) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${decisionPosition} has a non-canonical internal receipt link`,
    );
  }
  const legRoster = ctx.loadDecisionLegRoster(decisionId, liveBindingAlreadyValidated);
  const primaryLeg = legRoster.legs[0]!;
  const receipt = ctx.loadReceipt(
    receiptCommandId,
    true,
    liveBindingAlreadyValidated,
  );
  if (receipt === null || receipt.effectSha256 !== effectSha256) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${decisionPosition} does not match its effect receipt`,
    );
  }

  let stored: StoredCommandDecision;
  if (rawDisposition === "EFFECTS_COMMITTED") {
    if (
      legRoster.legs.some((leg) => leg.receiptCommandId === null) ||
      primaryLeg.aggregateId !== targetAggregateId ||
      primaryLeg.expectedVersion !== expectedVersion ||
      primaryLeg.receiptCommandId !== receiptCommandId ||
      primaryLeg.receiptRequestSha256 !== receipt.requestSha256 ||
      primaryLeg.receiptEffectSha256 !== effectSha256
    ) {
      throw new DecisionLedgerIntegrityError();
    }
    if (
      requireRowString(row, "result_code") !== "EFFECTS_COMMITTED" ||
      auditEventId !== null ||
      previousVersion === null ||
      currentVersion === null ||
      observedVersion !== expectedVersion ||
      previousVersion !== expectedVersion ||
      receipt.aggregateId !== targetAggregateId ||
      receipt.previousVersion !== previousVersion ||
      receipt.currentVersion !== currentVersion ||
      receipt.eventIds.length !== businessEventCount ||
      receipt.outboxMessageIds.length !== outboxCount
    ) {
      throw new DecisionLedgerIntegrityError();
    }
    stored = {
      auditEventId: null,
      businessEventIds: receipt.eventIds,
      commandKind,
      correlationSha256,
      coverage,
      currentVersion,
      decidedAt,
      decisionId,
      decisionIdentityVersion,
      decisionPosition,
      decisionSha256,
      effectDisposition: "EFFECTS_COMMITTED",
      effectIdentityVersion,
      effectSha256,
      expectedVersion,
      key,
      legCount: legRoster.count,
      legRosterSha256: identifyDecisionLegRoster(legRoster),
      legRosterVersion: legRoster.version,
      observedVersion,
      outboxMessageIds: receipt.outboxMessageIds,
      previousVersion,
      receiptCommandId,
      recordVersion,
      // Read straight off the re-proven receipt: `loadReceipt` re-derives its effect digest from
      // its own rows and the branch above pins that digest to this decision, so this value is
      // durable evidence rather than an unverified column.
      replayRequestSha256: receipt.requestSha256,
      requestIdentityVersion,
      requestSha256,
      resultBytes,
      resultCode: "EFFECTS_COMMITTED",
      resultSha256,
      resultVersion,
      targetAggregateId,
    };
  } else {
    if (
      legRoster.legs.some((leg) => leg.receiptCommandId !== null) ||
      !legRoster.legs.some((leg) =>
        leg.aggregateId === targetAggregateId && leg.expectedVersion === expectedVersion)
    ) {
      throw new DecisionLedgerIntegrityError();
    }
    const expectedAuditEventId = rejectionAuditEventId(decisionId);
    const expectedAuditAggregateId = rejectionAuditAggregateId(decisionId);
    const expectedResultBytes = expectedVersionConflictResultBytes(
      expectedVersion,
      observedVersion,
    );
    if (
      requireRowString(row, "result_code") !== "EXPECTED_VERSION_CONFLICT" ||
      auditEventId !== expectedAuditEventId ||
      previousVersion !== null ||
      currentVersion !== null ||
      observedVersion === expectedVersion ||
      businessEventCount !== 0 ||
      outboxCount !== 0 ||
      receipt.aggregateId !== expectedAuditAggregateId ||
      receipt.previousVersion !== 0 ||
      receipt.currentVersion !== 1 ||
      receipt.eventIds.length !== 1 ||
      receipt.eventIds[0] !== auditEventId ||
      receipt.outboxMessageIds.length !== 0 ||
      ctx.assertAggregateTail(expectedAuditAggregateId) !== 1 ||
      !bytesEqual(resultBytes, expectedResultBytes)
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `no-business-effect command decision ${decisionPosition} has contradictory durable fields`,
      );
    }
    const auditRow = ctx.loadRejectionAuditRow(auditEventId);
    const expectedAuditPayload = rejectionAuditPayload({
      commandId: key.commandId,
      commandKind,
      decisionId,
      expectedVersion,
      observedVersion,
      principalId: key.principalId,
      projectId: key.projectId,
      requestSha256,
      targetAggregateId,
    });
    if (
      auditRow === undefined ||
      requireStoredIdentifier(auditRow, "aggregate_id") !== expectedAuditAggregateId ||
      requireStoredIdentifier(auditRow, "command_id") !== receiptCommandId ||
      requireStoredIdentifier(auditRow, "event_type") !==
        "command.expected-version-rejected" ||
      !bytesEqual(requireRowBytes(auditRow, "payload"), expectedAuditPayload) ||
      requireRowBytes(auditRow, "metadata").byteLength !== 0
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${decisionPosition} has a malformed rejection audit event`,
      );
    }
    stored = {
      auditEventId,
      businessEventIds: [],
      commandKind,
      correlationSha256,
      coverage,
      currentVersion: null,
      decidedAt,
      decisionId,
      decisionIdentityVersion,
      decisionPosition,
      decisionSha256,
      effectDisposition: "NO_BUSINESS_EFFECT",
      effectIdentityVersion,
      effectSha256,
      expectedVersion,
      key,
      legCount: legRoster.count,
      legRosterSha256: identifyDecisionLegRoster(legRoster),
      legRosterVersion: legRoster.version,
      observedVersion,
      outboxMessageIds: [],
      previousVersion: null,
      receiptCommandId,
      recordVersion,
      // The receipt on this branch commits the rejection audit payload, so it carries no
      // evidence about the request bytes. Offering its digest here would let a refusal answer a
      // same-bytes question it never decided.
      replayRequestSha256: null,
      requestIdentityVersion,
      requestSha256,
      resultBytes,
      resultCode: "EXPECTED_VERSION_CONFLICT",
      resultSha256,
      resultVersion,
      targetAggregateId,
    };
  }

  if (identifyCommandDecision(stored) !== decisionSha256) {
    throw new DecisionLedgerIntegrityError();
  }
  return stored;
}
