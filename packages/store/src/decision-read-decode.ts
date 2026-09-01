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
  identifyCommandDecision,
  identifyCommandDecisionId,
  identifyDecisionResult,
  internalReceiptCommandId,
} from "./store-digests.js";
import {
  DecisionLedgerIntegrityError,
  identifyDecisionLegRoster,
} from "./decision-leg-roster.js";
import type { DecisionLegRoster } from "./decision-leg-roster.js";
import {
  decodeDecisionDisposition,
} from "./decision-read-disposition.js";
import type {
  DecisionCommonFields,
} from "./decision-read-disposition.js";
import type { StoredCommandDecision, StoredReceipt } from "./store-internals.js";
import {
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

/** Ancestor capabilities the decoder borrows through late-bound closures. */
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

function decodeIdentity(row: Record<string, unknown>, ctx: DecisionDecodeContext) {
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
  return { decisionId, decisionPosition, key };
}

function decodeRequestFields(
  row: Record<string, unknown>,
  ctx: DecisionDecodeContext,
  decisionPosition: bigint,
) {
  const recordVersion = ctx.requireStoredVersion(
    row, "record_version", COMMAND_DECISION_RECORD_VERSION,
  );
  const coverage = ctx.requireStoredVersion(
    row, "coverage", EXPECTED_VERSION_DECISION_COVERAGE,
  );
  const requestIdentityVersion = ctx.requireStoredVersion(
    row, "request_identity_version", COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  );
  const requestSha256 = requireStoredSha256(row, "request_sha256");
  const commandKind = requireStoredIdentifier(row, "command_kind");
  const targetAggregateId = requireStoredIdentifier(row, "target_aggregate_id");
  const expectedVersion = requireStoredIntegerAtLeast(row, "expected_version", 0);
  const observedVersion = requireStoredIntegerAtLeast(row, "observed_version", 0);
  const rawDisposition = requireRowString(row, "effect_disposition");
  if (rawDisposition !== "EFFECTS_COMMITTED" && rawDisposition !== "NO_BUSINESS_EFFECT") {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${decisionPosition} has an unsupported effect disposition`,
    );
  }
  const disposition: "EFFECTS_COMMITTED" | "NO_BUSINESS_EFFECT" = rawDisposition;
  return {
    commandKind, coverage, expectedVersion, observedVersion,
    rawDisposition: disposition,
    recordVersion, requestIdentityVersion, requestSha256, targetAggregateId,
  };
}

function decodeResultFields(
  row: Record<string, unknown>,
  ctx: DecisionDecodeContext,
  decisionPosition: bigint,
) {
  const resultVersion = ctx.requireStoredVersion(
    row, "result_version", COMMAND_DECISION_RESULT_VERSION,
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
  const previousVersion = requireNullableStoredIntegerAtLeast(row, "previous_version", 0);
  const currentVersion = requireNullableStoredIntegerAtLeast(row, "current_version", 1);
  const businessEventCount = requireStoredIntegerAtLeast(row, "business_event_count", 0);
  const outboxCount = requireStoredIntegerAtLeast(row, "outbox_count", 0);
  const effectIdentityVersion = ctx.requireStoredVersion(
    row, "effect_identity_version", COMMAND_EFFECT_IDENTITY_VERSION,
  );
  const effectSha256 = requireStoredSha256(row, "effect_sha256");
  const decisionIdentityVersion = ctx.requireStoredVersion(
    row, "decision_identity_version", COMMAND_DECISION_IDENTITY_VERSION,
  );
  const decisionSha256 = requireStoredSha256(row, "decision_sha256");
  return {
    auditEventId, businessEventCount, correlationSha256, currentVersion, decidedAt,
    decisionIdentityVersion, decisionSha256, effectIdentityVersion, effectSha256,
    outboxCount, previousVersion, receiptCommandId,
    resultBytes, resultSha256, resultVersion,
  };
}

function assertCanonicalReceiptId(
  decisionId: string,
  decisionPosition: bigint,
  receiptCommandId: string,
): void {
  if (receiptCommandId !== internalReceiptCommandId(decisionId)) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${decisionPosition} has a non-canonical internal receipt link`,
    );
  }
}

function requireEffectReceipt(
  common: DecisionCommonFields,
  ctx: DecisionDecodeContext,
  liveBindingAlreadyValidated: boolean,
): StoredReceipt {
  const receipt = ctx.loadReceipt(common.receiptCommandId, true, liveBindingAlreadyValidated);
  if (receipt === null || receipt.effectSha256 !== common.effectSha256) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `command decision ${common.decisionPosition} does not match its effect receipt`,
    );
  }
  return receipt;
}

/** Rebuilds a stored decision and re-proves every durable digest. */
export function decodeStoredCommandDecision(
  row: Record<string, unknown>,
  ctx: DecisionDecodeContext,
  liveBindingAlreadyValidated = false,
): StoredCommandDecision {
  const identity = decodeIdentity(row, ctx);
  const request = decodeRequestFields(row, ctx, identity.decisionPosition);
  const { rawDisposition, ...requestFields } = request;
  const result = decodeResultFields(row, ctx, identity.decisionPosition);
  const {
    auditEventId, businessEventCount, currentVersion, outboxCount, previousVersion,
    ...resultFields
  } = result;
  assertCanonicalReceiptId(
    identity.decisionId,
    identity.decisionPosition,
    resultFields.receiptCommandId,
  );
  const legRoster = ctx.loadDecisionLegRoster(
    identity.decisionId,
    liveBindingAlreadyValidated,
  );
  const common: DecisionCommonFields = {
    ...identity,
    ...requestFields,
    ...resultFields,
    legCount: legRoster.count,
    legRosterSha256: identifyDecisionLegRoster(legRoster),
    legRosterVersion: legRoster.version,
  };
  const receipt = requireEffectReceipt(common, ctx, liveBindingAlreadyValidated);
  const stored = decodeDecisionDisposition(rawDisposition, {
    auditEventId,
    businessEventCount,
    common,
    currentVersion,
    legRoster,
    outboxCount,
    previousVersion,
    receipt,
    row,
  }, ctx);
  if (identifyCommandDecision(stored) !== common.decisionSha256) {
    throw new DecisionLedgerIntegrityError();
  }
  return stored;
}
