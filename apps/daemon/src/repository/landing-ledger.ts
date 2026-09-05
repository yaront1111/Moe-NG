import type { CommandDecisionRecord, EventDraft, SqliteEventStore } from "@moe/store";

import {
  LANDING_BASELINE_COMMAND_KIND, LANDING_BASELINE_VERSION, LANDING_RECEIPT_COMMAND_KIND,
  LANDING_RECEIPT_VERSION, NODE_LANDER_PRINCIPAL_ID, decodeLandingBaselineBytes,
  decodeLandingReceiptBytes, landingAggregateId, landingBaselineId, landingReceiptId,
} from "./landing-receipt-contracts.js";
import type {
  LandingBaselineEntry, LandingBaselineV1, LandingCommit, LandingReceiptV1, LandingRefusal,
} from "./landing-receipt-contracts.js";

/**
 * Durable reads and writes for the lander's two facts, on the node's landing
 * aggregate (`landing:<subjectRef>`) rather than on the node itself, so the
 * review ledger's versions are never moved by a commit the reviewer never saw.
 *
 * Every write goes through `commitExpectedVersionDecision` under the lander's
 * reserved principal; every read re-validates the decision against the bytes
 * it carries, exactly as the verifier receipt ledger does.
 */

const encoder = new TextEncoder();

/** How many aggregate versions back the latest baseline is looked for. */
const BASELINE_PROBE_DEPTH = 64;

export type LandingReceiptReadResult =
  | Readonly<{ readonly decision: CommandDecisionRecord; readonly ok: true; readonly receipt: LandingReceiptV1 }>
  | Readonly<{ readonly code: "LANDING_RECEIPT_NOT_FOUND" | "LANDING_RECEIPT_INVALID"; readonly ok: false }>;

export type LandingRecordResult =
  | Readonly<{ readonly ok: true; readonly receipt: LandingReceiptV1; readonly replayed: boolean }>
  | Readonly<{ readonly code: "EXPECTED_VERSION_CONFLICT" | "LANDING_RECEIPT_INVALID"; readonly ok: false }>;

export type LandingBaselineRecordResult =
  | Readonly<{ readonly baseline: LandingBaselineV1; readonly ok: true }>
  | Readonly<{ readonly code: "EXPECTED_VERSION_CONFLICT" | "LANDING_BASELINE_INVALID"; readonly ok: false }>;

export interface RecordLandingReceiptInput {
  readonly commit: LandingCommit | null;
  readonly decidedAt: string;
  readonly projectId: string;
  readonly refusal: LandingRefusal | null;
  readonly subjectRef: string;
  readonly verifierReceiptId: string;
  readonly workspace: string;
}

export interface RecordLandingBaselineInput {
  readonly entries: readonly LandingBaselineEntry[];
  readonly observedAt: string;
  readonly projectId: string;
  readonly subjectRef: string;
  readonly workspace: string;
}

function ownDecision(
  store: SqliteEventStore, projectId: string, commandId: string, kind: string,
): CommandDecisionRecord | null | "INVALID" {
  let decision: CommandDecisionRecord | null;
  try {
    decision = store.getCommandDecision({
      commandId, principalId: NODE_LANDER_PRINCIPAL_ID, projectId,
    });
  } catch {
    return "INVALID";
  }
  if (decision === null) return null;
  if (decision.effectDisposition !== "EFFECTS_COMMITTED" || decision.commandKind !== kind
    || decision.key.commandId !== commandId || decision.key.principalId !== NODE_LANDER_PRINCIPAL_ID
    || decision.key.projectId !== projectId) return "INVALID";
  return decision;
}

export function readLandingReceipt(
  store: SqliteEventStore, projectId: string, receiptId: string,
): LandingReceiptReadResult {
  const decision = ownDecision(store, projectId, receiptId, LANDING_RECEIPT_COMMAND_KIND);
  if (decision === null) return { code: "LANDING_RECEIPT_NOT_FOUND", ok: false };
  if (decision === "INVALID") return { code: "LANDING_RECEIPT_INVALID", ok: false };
  const decoded = decodeLandingReceiptBytes(decision.resultBytes);
  if (!decoded.ok || decoded.receipt.projectId !== projectId
    || decoded.receipt.receiptId !== receiptId
    || decision.targetAggregateId !== landingAggregateId(decoded.receipt.subjectRef)) {
    return { code: "LANDING_RECEIPT_INVALID", ok: false };
  }
  return { decision, ok: true, receipt: decoded.receipt };
}

/** The most recent baseline recorded for the node, or null when none was. */
export function readLatestLandingBaseline(
  store: SqliteEventStore, projectId: string, subjectRef: string,
): LandingBaselineV1 | null {
  const aggregateId = landingAggregateId(subjectRef);
  const version = store.getAggregateVersion(aggregateId);
  const floor = Math.max(0, version - BASELINE_PROBE_DEPTH);
  for (let at = version - 1; at >= floor; at -= 1) {
    const decision = ownDecision(
      store, projectId, landingBaselineId(projectId, subjectRef, at), LANDING_BASELINE_COMMAND_KIND,
    );
    if (decision === null || decision === "INVALID") continue;
    const decoded = decodeLandingBaselineBytes(decision.resultBytes);
    if (decoded.ok && decoded.baseline.subjectRef === subjectRef
      && decoded.baseline.projectId === projectId) return decoded.baseline;
  }
  return null;
}

/**
 * The FIRST baseline recorded for the node: what was dirty when the node was first staffed.
 * A node re-staffed after a dead seat gets a fresh baseline that already contains that seat's
 * files, so the latest baseline alone reads the node's own earlier output as operator dirt.
 */
export function readEarliestLandingBaseline(
  store: SqliteEventStore, projectId: string, subjectRef: string,
): LandingBaselineV1 | null {
  const aggregateId = landingAggregateId(subjectRef);
  const version = store.getAggregateVersion(aggregateId);
  for (let at = 0; at < version; at += 1) {
    const decision = ownDecision(
      store, projectId, landingBaselineId(projectId, subjectRef, at), LANDING_BASELINE_COMMAND_KIND,
    );
    if (decision === null || decision === "INVALID") continue;
    const decoded = decodeLandingBaselineBytes(decision.resultBytes);
    if (decoded.ok && decoded.baseline.subjectRef === subjectRef
      && decoded.baseline.projectId === projectId) return decoded.baseline;
  }
  return null;
}

export function recordLandingBaseline(
  store: SqliteEventStore, input: RecordLandingBaselineInput,
): LandingBaselineRecordResult {
  const aggregateId = landingAggregateId(input.subjectRef);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const baselineId = landingBaselineId(input.projectId, input.subjectRef, expectedVersion);
  const baseline: LandingBaselineV1 = {
    entries: input.entries,
    observedAt: input.observedAt,
    projectId: input.projectId,
    subjectRef: input.subjectRef,
    version: LANDING_BASELINE_VERSION,
    workspace: input.workspace,
  };
  const resultBytes = encoder.encode(JSON.stringify(baseline));
  if (!decodeLandingBaselineBytes(resultBytes).ok) {
    return { code: "LANDING_BASELINE_INVALID", ok: false };
  }
  const event: EventDraft = {
    eventId: `${baselineId}-LandingBaselineRecorded`,
    eventType: "LandingBaselineRecorded",
    payload: encoder.encode(JSON.stringify({
      baselineId, entries: input.entries.length, subjectRef: input.subjectRef,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: LANDING_BASELINE_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "node-lander-baseline",
    decidedAt: input.observedAt,
    events: [event],
    expectedVersion,
    key: { commandId: baselineId, principalId: NODE_LANDER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: encoder.encode(JSON.stringify({
      baselineId, subjectRef: input.subjectRef, version: LANDING_BASELINE_VERSION,
    })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  return { baseline, ok: true };
}

export function recordLandingReceipt(
  store: SqliteEventStore, input: RecordLandingReceiptInput,
): LandingRecordResult {
  const receiptId = landingReceiptId(input.projectId, input.subjectRef, input.verifierReceiptId);
  const historical = readLandingReceipt(store, input.projectId, receiptId);
  if (historical.ok) return { ok: true, receipt: historical.receipt, replayed: true };
  if (historical.code === "LANDING_RECEIPT_INVALID") return { code: historical.code, ok: false };
  const receipt: LandingReceiptV1 = {
    commit: input.commit,
    decidedAt: input.decidedAt,
    outcome: input.commit === null ? "REFUSED" : "COMMITTED",
    projectId: input.projectId,
    receiptId,
    refusal: input.refusal,
    subjectRef: input.subjectRef,
    verifierReceiptId: input.verifierReceiptId,
    version: LANDING_RECEIPT_VERSION,
    workspace: input.workspace,
  };
  const resultBytes = encoder.encode(JSON.stringify(receipt));
  if (!decodeLandingReceiptBytes(resultBytes).ok) return { code: "LANDING_RECEIPT_INVALID", ok: false };
  const aggregateId = landingAggregateId(input.subjectRef);
  const event: EventDraft = {
    eventId: `${receiptId}-LandingRecorded`,
    eventType: receipt.outcome === "COMMITTED" ? "LandingCommitted" : "LandingRefused",
    payload: encoder.encode(JSON.stringify({
      outcome: receipt.outcome, receiptId, sha: input.commit?.sha ?? null, subjectRef: input.subjectRef,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: LANDING_RECEIPT_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "node-lander-receipt",
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId: receiptId, principalId: NODE_LANDER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: encoder.encode(JSON.stringify({
      receiptId, subjectRef: input.subjectRef, verifierReceiptId: input.verifierReceiptId,
      version: LANDING_RECEIPT_VERSION,
    })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  const persisted = readLandingReceipt(store, input.projectId, receiptId);
  if (!persisted.ok) return { code: "LANDING_RECEIPT_INVALID", ok: false };
  return { ok: true, receipt: persisted.receipt, replayed: false };
}
