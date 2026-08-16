import { qualifyReviewAcceptance, buildReviewPackage } from "@moe/review";
import type { ReviewerIndependenceInput } from "@moe/review";
import type { EffectsCommittedDecision, EventDraft, SqliteEventStore } from "@moe/store";

import { readReviewLedger } from "./review-read-model.js";
import {
  NODE_VERIFIER_PRINCIPAL_ID,
  VERIFIER_RECEIPT_COMMAND_KIND,
  VERIFIER_RECEIPT_VERSION,
  decodeVerifierReceiptBytes,
  verifierExecutionDigest,
  verifierReceiptId,
} from "./verifier-receipt-contracts.js";
import type {
  VerifierAuthorityFacts,
  VerifierExecutionInput,
  VerifierReceiptSource,
  VerifierReceiptV1,
} from "./verifier-receipt-contracts.js";

export { NODE_VERIFIER_PRINCIPAL_ID } from "./verifier-receipt-contracts.js";
export type { VerifierAuthorityFacts } from "./verifier-receipt-contracts.js";

export type VerifierReceiptReadResult =
  | Readonly<{
    readonly decision: EffectsCommittedDecision;
    readonly ok: true;
    readonly receipt: VerifierReceiptV1;
    readonly receiptSha256: string;
  }>
  | Readonly<{
    readonly code: "VERIFIER_RECEIPT_INVALID" | "VERIFIER_RECEIPT_NOT_FOUND";
    readonly ok: false;
  }>;

export type VerifierReceiptRecordCode =
  | "VERIFIER_ALREADY_ACCEPTED"
  | "VERIFIER_AUTHORITY_REFUSED"
  | "VERIFIER_LINEAGE_UNREADABLE"
  | "VERIFIER_RECEIPT_INVALID"
  | "VERIFIER_RECEIPT_STALE"
  | "VERIFIER_SOURCE_NOT_CLEAN"
  | "VERIFIER_SOURCE_NOT_FOUND"
  | "EXPECTED_VERSION_CONFLICT";

export type VerifierReceiptRecordResult =
  | Readonly<{
    readonly decision: EffectsCommittedDecision;
    readonly disposition: "DECIDED" | "REPLAYED";
    readonly ok: true;
    readonly receipt: VerifierReceiptV1;
  }>
  | Readonly<{ readonly code: VerifierReceiptRecordCode; readonly ok: false }>;

export interface RecordVerifierReceiptInput {
  readonly authority: VerifierAuthorityFacts;
  readonly decidedAt: string;
  readonly execution: VerifierExecutionInput;
  readonly projectId: string;
  /** Exact clean round observed before verifier execution began. */
  readonly source: Pick<
    VerifierReceiptSource,
    "aggregateVersion" | "decisionId" | "resultSha256"
  >;
  readonly subjectRef: string;
}

const encoder = new TextEncoder();

function reviewerFor(
  subjectRef: string,
  authors: readonly string[],
): ReviewerIndependenceInput {
  return {
    authors,
    authorshipResolved: true,
    // The service id is reserved from sessions and never receives a work claim.
    leaseHistory: [],
    leaseHistoryResolved: true,
    reviewer: NODE_VERIFIER_PRINCIPAL_ID,
    subjectRef,
  };
}

export function readVerifierReceipt(
  store: SqliteEventStore,
  projectId: string,
  receiptId: string,
): VerifierReceiptReadResult {
  let decision;
  try {
    decision = store.getCommandDecision({
      commandId: receiptId,
      principalId: NODE_VERIFIER_PRINCIPAL_ID,
      projectId,
    });
  } catch {
    return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  }
  if (decision === null) return { code: "VERIFIER_RECEIPT_NOT_FOUND", ok: false };
  if (decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== VERIFIER_RECEIPT_COMMAND_KIND
    || decision.key.commandId !== receiptId
    || decision.key.principalId !== NODE_VERIFIER_PRINCIPAL_ID
    || decision.key.projectId !== projectId
    || decision.previousVersion === null
    || decision.currentVersion === null) {
    return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  }
  const decoded = decodeVerifierReceiptBytes(decision.resultBytes);
  if (!decoded.ok) return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  const receipt = decoded.receipt;
  if (receipt.projectId !== projectId || receipt.receiptId !== receiptId
    || decision.targetAggregateId !== receipt.subjectRef
    || decision.previousVersion !== receipt.source.aggregateVersion
    || decision.currentVersion !== receipt.source.aggregateVersion + 1) {
    return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  }
  return {
    decision,
    ok: true,
    receipt,
    receiptSha256: decision.resultSha256,
  };
}

function uniqueAuthors(
  rounds: ReturnType<typeof readReviewLedger>["rounds"],
): readonly string[] {
  return [...new Set(rounds.map((round) => round.principalId))].sort();
}

/**
 * Records one verifier-owned receipt at V+1 where V is the exact clean review
 * round it attests. A competing review command wins the same aggregate CAS and
 * prevents the receipt rather than being accepted against stale bytes.
 */
export function recordVerifierReceipt(
  store: SqliteEventStore,
  input: RecordVerifierReceiptInput,
): VerifierReceiptRecordResult {
  const ledger = readReviewLedger(store, input.projectId, input.subjectRef);
  if (ledger.unreadable) return { code: "VERIFIER_LINEAGE_UNREADABLE", ok: false };
  if (ledger.accepted !== undefined) return { code: "VERIFIER_ALREADY_ACCEPTED", ok: false };
  const sourceRound = ledger.rounds[ledger.rounds.length - 1];
  if (sourceRound === undefined) return { code: "VERIFIER_SOURCE_NOT_FOUND", ok: false };
  if (sourceRound.aggregateVersion !== input.source.aggregateVersion
    || sourceRound.decisionId !== input.source.decisionId
    || sourceRound.resultSha256 !== input.source.resultSha256) {
    return { code: "VERIFIER_RECEIPT_STALE", ok: false };
  }
  if (sourceRound.routing.route !== "ACCEPT") {
    return { code: "VERIFIER_SOURCE_NOT_CLEAN", ok: false };
  }
  const receiptId = verifierReceiptId(
    input.projectId,
    input.subjectRef,
    sourceRound.decisionId,
  );
  const historical = readVerifierReceipt(store, input.projectId, receiptId);
  if (historical.ok) {
    if (historical.decision.currentVersion !== ledger.version) {
      return { code: "VERIFIER_RECEIPT_STALE", ok: false };
    }
    return {
      decision: historical.decision,
      disposition: "REPLAYED",
      ok: true,
      receipt: historical.receipt,
    };
  }
  if (historical.code === "VERIFIER_RECEIPT_INVALID") {
    return { code: historical.code, ok: false };
  }
  if (ledger.version !== sourceRound.aggregateVersion) {
    return { code: "VERIFIER_RECEIPT_STALE", ok: false };
  }
  if (input.authority.packageItems.some((item) => item.kind === "DAEMON_RECEIPT")) {
    return { code: "VERIFIER_AUTHORITY_REFUSED", ok: false };
  }
  const authors = uniqueAuthors(ledger.rounds);
  if (authors.length === 0 || authors.includes(NODE_VERIFIER_PRINCIPAL_ID)) {
    return { code: "VERIFIER_AUTHORITY_REFUSED", ok: false };
  }
  const source = {
    aggregateVersion: sourceRound.aggregateVersion,
    authors,
    decisionId: sourceRound.decisionId,
    resultSha256: sourceRound.resultSha256,
  };
  const evidenceSha256 = verifierExecutionDigest(
    input.projectId,
    input.subjectRef,
    source,
    input.execution,
  );
  const packageItems = [
    ...input.authority.packageItems,
    {
      digest: evidenceSha256,
      kind: "DAEMON_RECEIPT",
      locator: `verifier:${input.subjectRef}:${sourceRound.decisionId}`,
    },
  ];
  const built = buildReviewPackage(packageItems);
  if (!built.ok) return { code: "VERIFIER_AUTHORITY_REFUSED", ok: false };
  const qualified = qualifyReviewAcceptance({
    calibration: input.authority.calibration,
    lineage: ledger.lineage,
    policy: input.authority.policy,
    proof: "PASSED",
    reviewer: reviewerFor(input.subjectRef, authors),
    reviewInputDigest: built.value.reviewInputDigest,
  });
  if (!qualified.ok) return { code: "VERIFIER_AUTHORITY_REFUSED", ok: false };
  const receipt: VerifierReceiptV1 = {
    calibration: input.authority.calibration,
    execution: {
      ...input.execution,
      evidenceSha256,
      exitCode: 0,
    },
    packageItems,
    policy: input.authority.policy,
    projectId: input.projectId,
    proof: "PASSED",
    receiptId,
    reviewInputDigest: built.value.reviewInputDigest,
    source,
    subjectRef: input.subjectRef,
    version: VERIFIER_RECEIPT_VERSION,
  };
  const resultBytes = encoder.encode(JSON.stringify(receipt));
  const checked = decodeVerifierReceiptBytes(resultBytes);
  if (!checked.ok) return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  const event: EventDraft = {
    eventId: `${receiptId}-VerifierReceiptRecorded`,
    eventType: "VerifierReceiptRecorded",
    payload: encoder.encode(JSON.stringify({
      receiptId,
      sourceDecisionId: sourceRound.decisionId,
      subjectRef: input.subjectRef,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: VERIFIER_RECEIPT_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "node-verifier-receipt",
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: sourceRound.aggregateVersion,
    key: {
      commandId: receiptId,
      principalId: NODE_VERIFIER_PRINCIPAL_ID,
      projectId: input.projectId,
    },
    requestBytes: encoder.encode(JSON.stringify({
      evidenceSha256,
      receiptId,
      sourceDecisionId: sourceRound.decisionId,
      version: VERIFIER_RECEIPT_VERSION,
    })),
    targetAggregateId: input.subjectRef,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  const persisted = readVerifierReceipt(store, input.projectId, receiptId);
  if (!persisted.ok) return { code: "VERIFIER_RECEIPT_INVALID", ok: false };
  return {
    decision: persisted.decision,
    disposition: response.disposition,
    ok: true,
    receipt: persisted.receipt,
  };
}
