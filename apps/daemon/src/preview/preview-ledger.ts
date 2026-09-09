import type { CommandDecisionRecord, EventDraft, SqliteEventStore } from "@moe/store";

import type { PreviewCode } from "./preview-contracts.js";
import {
  PREVIEW_RECEIPT_COMMAND_KIND, PREVIEW_RECEIPT_VERSION, PREVIEW_RUNNER_PRINCIPAL_ID,
  decodePreviewReceiptBytes, previewAggregateId, previewReceiptId,
} from "./preview-receipt-contracts.js";
import type { PreviewReceiptV1, PreviewScreenshot } from "./preview-receipt-contracts.js";

/**
 * Durable reads and writes for the preview receipt, on the goal's PREVIEW aggregate
 * (`preview:<goalId>`) rather than on the goal itself — the same separation the landing ledger
 * makes (`landing:<subjectRef>`), so starting a preview never moves a version the planner or
 * the reviewer is reading against.
 *
 * Every write goes through `commitExpectedVersionDecision` under the runner's reserved
 * principal, and every read re-validates the bytes AND the decision that carries them. Reading
 * back through the decoder is what makes `recordPreviewReceipt`'s return value evidence rather
 * than an intention: the receipt handed to the caller is the receipt the store holds.
 *
 * IDEMPOTENCE IS THE POINT, not a nicety. The id is a function of (projectId, goalId, sha), so a
 * second call for the same revision returns the FIRST receipt with `replayed: true` and starts
 * no second server. Without it a restarted daemon would spawn a second preview that could not
 * bind the port the first one still holds.
 */

const encoder = new TextEncoder();

export type PreviewReceiptReadResult =
  | Readonly<{ readonly ok: true; readonly receipt: PreviewReceiptV1 }>
  | Readonly<{
    readonly code: "PREVIEW_RECEIPT_INVALID" | "PREVIEW_RECEIPT_NOT_FOUND";
    readonly ok: false;
  }>;

export type PreviewRecordResult =
  | Readonly<{ readonly ok: true; readonly receipt: PreviewReceiptV1; readonly replayed: boolean }>
  | Readonly<{
    readonly code: "EXPECTED_VERSION_CONFLICT" | "PREVIEW_RECEIPT_INVALID";
    readonly ok: false;
  }>;

export interface RecordPreviewReceiptInput {
  readonly code: PreviewCode | null;
  readonly decidedAt: string;
  readonly goalId: string;
  readonly pid: number | null;
  readonly projectId: string;
  readonly screenshots: readonly PreviewScreenshot[];
  readonly sha: string;
  readonly url: string | null;
}

/**
 * The runner's OWN committed decision for this receipt id, or null when it never wrote one.
 * Mirrors `landing-ledger.ts:57-73`: the key is re-checked against the record rather than
 * trusted, so a decision written under a different principal, kind or project can never be read
 * back as this runner's receipt.
 */
function ownDecision(
  store: SqliteEventStore, projectId: string, receiptId: string,
): CommandDecisionRecord | "INVALID" | null {
  let decision: CommandDecisionRecord | null;
  try {
    decision = store.getCommandDecision({
      commandId: receiptId, principalId: PREVIEW_RUNNER_PRINCIPAL_ID, projectId,
    });
  } catch {
    return "INVALID";
  }
  if (decision === null) return null;
  if (decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== PREVIEW_RECEIPT_COMMAND_KIND
    || decision.key.commandId !== receiptId
    || decision.key.principalId !== PREVIEW_RUNNER_PRINCIPAL_ID
    || decision.key.projectId !== projectId) return "INVALID";
  return decision;
}

/** The recorded preview for this receipt id, re-validated against the bytes it carries. */
export function readPreviewReceipt(
  store: SqliteEventStore, projectId: string, receiptId: string,
): PreviewReceiptReadResult {
  const decision = ownDecision(store, projectId, receiptId);
  if (decision === null) return { code: "PREVIEW_RECEIPT_NOT_FOUND", ok: false };
  if (decision === "INVALID") return { code: "PREVIEW_RECEIPT_INVALID", ok: false };
  const decoded = decodePreviewReceiptBytes(decision.resultBytes);
  if (!decoded.ok || decoded.receipt.projectId !== projectId
    || decoded.receipt.receiptId !== receiptId
    || decision.targetAggregateId !== previewAggregateId(decoded.receipt.goalId)) {
    return { code: "PREVIEW_RECEIPT_INVALID", ok: false };
  }
  return { ok: true, receipt: decoded.receipt };
}

/**
 * Records one preview run. A run that never started is recorded as REFUSED with its code — an
 * absent receipt is not a refused one, and the operator's screen needs the difference.
 */
export function recordPreviewReceipt(
  store: SqliteEventStore, input: RecordPreviewReceiptInput,
): PreviewRecordResult {
  const receiptId = previewReceiptId(input.projectId, input.goalId, input.sha);
  const historical = readPreviewReceipt(store, input.projectId, receiptId);
  if (historical.ok) return { ok: true, receipt: historical.receipt, replayed: true };
  if (historical.code === "PREVIEW_RECEIPT_INVALID") return { code: historical.code, ok: false };
  const receipt: PreviewReceiptV1 = {
    code: input.code,
    decidedAt: input.decidedAt,
    goalId: input.goalId,
    outcome: input.code === null ? "STARTED" : "REFUSED",
    pid: input.pid,
    projectId: input.projectId,
    receiptId,
    screenshots: input.screenshots,
    sha: input.sha,
    url: input.url,
    version: PREVIEW_RECEIPT_VERSION,
  };
  const resultBytes = encoder.encode(JSON.stringify(receipt));
  // The bytes are validated BEFORE they are committed: a receipt the decoder would refuse must
  // never reach the store, or the read-back would report an invalid record forever.
  if (!decodePreviewReceiptBytes(resultBytes).ok) {
    return { code: "PREVIEW_RECEIPT_INVALID", ok: false };
  }
  const aggregateId = previewAggregateId(input.goalId);
  const event: EventDraft = {
    eventId: `${receiptId}-PreviewRecorded`,
    eventType: receipt.outcome === "STARTED" ? "PreviewStarted" : "PreviewRefused",
    payload: encoder.encode(JSON.stringify({
      code: receipt.code, goalId: receipt.goalId, outcome: receipt.outcome, receiptId,
      sha: receipt.sha,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: PREVIEW_RECEIPT_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "preview-runner-receipt",
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId: receiptId, principalId: PREVIEW_RUNNER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: encoder.encode(JSON.stringify({
      goalId: input.goalId, receiptId, sha: input.sha, version: PREVIEW_RECEIPT_VERSION,
    })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  const persisted = readPreviewReceipt(store, input.projectId, receiptId);
  if (!persisted.ok) return { code: "PREVIEW_RECEIPT_INVALID", ok: false };
  return { ok: true, receipt: persisted.receipt, replayed: false };
}
