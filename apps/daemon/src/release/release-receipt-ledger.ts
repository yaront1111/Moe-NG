import type { CommandDecisionRecord, EventDraft, SqliteEventStore } from "@moe/store";

import { releaseDossierAggregateId } from "./release-dossier-contracts.js";
import type { ReleaseDecideCode } from "./release-decide-contracts.js";
import {
  RELEASE_RECEIPT_COMMAND_KIND, RELEASE_RECEIPT_PRINCIPAL_ID, RELEASE_RECEIPT_VERSION,
  decodeReleaseReceiptBytes, releaseReceiptId,
} from "./release-receipt-contracts.js";
import type { ReleaseReceiptV1 } from "./release-receipt-contracts.js";

/**
 * Durable reads and writes for the release receipt, on the SAME aggregate the dossier
 * lands on (`release:<goalId>`) — the decision and the evidence it was taken against sit
 * beside each other, and neither moves a version a reader of the goal never saw.
 *
 * Mirrors release-dossier-ledger.ts: every write goes through
 * `commitExpectedVersionDecision` under a reserved principal, and every read
 * re-validates the decision against the bytes it carries rather than trusting that
 * whatever is in the store is what this module wrote.
 *
 * A REFUSED release is recorded, not omitted. An absent receipt says "no one tried"; a
 * REFUSED receipt says "someone tried and it did not open, for this reason" — and the
 * failure this whole module exists to prevent is the third possibility, a refused
 * release that left a record claiming success.
 */

const encoder = new TextEncoder();

export type ReleaseReceiptReadResult =
  | Readonly<{
    readonly decision: CommandDecisionRecord;
    readonly ok: true;
    readonly receipt: ReleaseReceiptV1;
  }>
  | Readonly<{
    readonly code: "RELEASE_RECEIPT_NOT_FOUND" | "RELEASE_RECEIPT_INVALID";
    readonly ok: false;
  }>;

export type ReleaseReceiptRecordResult =
  | Readonly<{ readonly ok: true; readonly receipt: ReleaseReceiptV1; readonly replayed: boolean }>
  | Readonly<{
    readonly code: "EXPECTED_VERSION_CONFLICT" | "RELEASE_RECEIPT_INVALID";
    readonly ok: false;
  }>;

export interface RecordReleaseReceiptInput {
  readonly decidedAt: string;
  readonly dossierSha256: string;
  readonly goalId: string;
  readonly outcome: ReleaseReceiptV1["outcome"];
  readonly prUrl: string | null;
  readonly projectId: string;
  readonly refusalCode: ReleaseDecideCode | null;
  readonly sha: string;
}

function ownDecision(
  store: SqliteEventStore, projectId: string, commandId: string,
): CommandDecisionRecord | null | "INVALID" {
  let decision: CommandDecisionRecord | null;
  try {
    decision = store.getCommandDecision({
      commandId, principalId: RELEASE_RECEIPT_PRINCIPAL_ID, projectId,
    });
  } catch {
    return "INVALID";
  }
  if (decision === null) return null;
  if (decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== RELEASE_RECEIPT_COMMAND_KIND
    || decision.key.commandId !== commandId
    || decision.key.principalId !== RELEASE_RECEIPT_PRINCIPAL_ID
    || decision.key.projectId !== projectId) return "INVALID";
  return decision;
}

export function readReleaseReceipt(
  store: SqliteEventStore, projectId: string, receiptId: string,
): ReleaseReceiptReadResult {
  const decision = ownDecision(store, projectId, receiptId);
  if (decision === null) return { code: "RELEASE_RECEIPT_NOT_FOUND", ok: false };
  if (decision === "INVALID") return { code: "RELEASE_RECEIPT_INVALID", ok: false };
  const decoded = decodeReleaseReceiptBytes(decision.resultBytes);
  if (!decoded.ok || decoded.receipt.projectId !== projectId
    || decoded.receipt.receiptId !== receiptId
    || decision.targetAggregateId !== releaseDossierAggregateId(decoded.receipt.goalId)) {
    return { code: "RELEASE_RECEIPT_INVALID", ok: false };
  }
  return { decision, ok: true, receipt: decoded.receipt };
}

/**
 * Record one release decision. The id is a pure function of
 * (project, goal, sha, outcome, refusalCode), so re-recording the SAME decision replays
 * the stored record instead of appending a second one, while a later attempt at the same
 * sha that reaches a DIFFERENT outcome is its own fact rather than a silent no-op against
 * the first. See `releaseReceiptId` for why the outcome and code are in the key.
 */
export function recordReleaseReceipt(
  store: SqliteEventStore, input: RecordReleaseReceiptInput,
): ReleaseReceiptRecordResult {
  const receiptId = releaseReceiptId(
    input.projectId, input.goalId, input.sha, input.outcome, input.refusalCode,
  );
  const historical = readReleaseReceipt(store, input.projectId, receiptId);
  if (historical.ok) return { ok: true, receipt: historical.receipt, replayed: true };
  if (historical.code === "RELEASE_RECEIPT_INVALID") return { code: historical.code, ok: false };
  const receipt: ReleaseReceiptV1 = {
    dossierSha256: input.dossierSha256,
    goalId: input.goalId,
    outcome: input.outcome,
    prUrl: input.prUrl,
    projectId: input.projectId,
    receiptId,
    refusalCode: input.refusalCode,
    sha: input.sha,
    version: RELEASE_RECEIPT_VERSION,
  };
  const resultBytes = encoder.encode(JSON.stringify(receipt));
  if (!decodeReleaseReceiptBytes(resultBytes).ok) {
    return { code: "RELEASE_RECEIPT_INVALID", ok: false };
  }
  const aggregateId = releaseDossierAggregateId(input.goalId);
  const event: EventDraft = {
    eventId: `${receiptId}-ReleaseReceiptRecorded`,
    eventType: "ReleaseReceiptRecorded",
    payload: encoder.encode(JSON.stringify({
      byteLength: resultBytes.byteLength, goalId: input.goalId, outcome: input.outcome,
      receiptId, sha: input.sha,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: RELEASE_RECEIPT_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "release-receipt",
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: {
      commandId: receiptId, principalId: RELEASE_RECEIPT_PRINCIPAL_ID, projectId: input.projectId,
    },
    requestBytes: encoder.encode(JSON.stringify({
      goalId: input.goalId, outcome: input.outcome, receiptId, sha: input.sha,
      version: RELEASE_RECEIPT_VERSION,
    })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  const persisted = readReleaseReceipt(store, input.projectId, receiptId);
  if (!persisted.ok) return { code: "RELEASE_RECEIPT_INVALID", ok: false };
  return { ok: true, receipt: persisted.receipt, replayed: false };
}
