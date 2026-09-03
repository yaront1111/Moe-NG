import type { CommandDecisionRecord, EventDraft, SqliteEventStore } from "@moe/store";

import {
  NODE_PUBLISHER_PRINCIPAL_ID, PUBLISH_RECEIPT_COMMAND_KIND, PUBLISH_RECEIPT_VERSION,
  REPOSITORY_PUBLISH_COMMAND_KIND, decodePublishReceiptBytes, publishAggregateId, publishReceiptId,
} from "./publish-receipt-contracts.js";
import type { PublishReceiptV1, PublishRefusal } from "./publish-receipt-contracts.js";

/**
 * Durable reads and writes for publishing. A human's `repository.publish` decision
 * (a bootstrap-family command) lands on the goal's publish aggregate
 * (`publish:<goalId>`); the publisher's receipt lands beside it under the
 * publisher's reserved principal. ONE walk of the decision ledger answers every
 * goal's publish state: each request, and the receipt that consumed it.
 */

const encoder = new TextEncoder();
const LEDGER_PAGE_SIZE = 200;

export interface PublishRequest {
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly goalId: string;
  readonly principalId: string;
  readonly remoteUrl: string;
}

export interface GoalPublishState {
  /** Receipts by the decision id they answered. */
  readonly receipts: ReadonlyMap<string, PublishReceiptV1>;
  /** Requests in ledger order; the last one is the current one. */
  readonly requests: readonly PublishRequest[];
}

export type PublishReceiptReadResult =
  | Readonly<{ readonly decision: CommandDecisionRecord; readonly ok: true; readonly receipt: PublishReceiptV1 }>
  | Readonly<{ readonly code: "PUBLISH_RECEIPT_NOT_FOUND" | "PUBLISH_RECEIPT_INVALID"; readonly ok: false }>;

export type PublishRecordResult =
  | Readonly<{ readonly ok: true; readonly receipt: PublishReceiptV1; readonly replayed: boolean }>
  | Readonly<{ readonly code: "EXPECTED_VERSION_CONFLICT" | "PUBLISH_RECEIPT_INVALID"; readonly ok: false }>;

export interface RecordPublishReceiptInput {
  readonly branch: string | null;
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly goalId: string;
  readonly projectId: string;
  readonly refusal: PublishRefusal | null;
  readonly remoteUrl: string;
  readonly sha: string | null;
  readonly url: string | null;
}

function decodeRequest(decision: CommandDecisionRecord): PublishRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decision.resultBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const goalId = (parsed as Record<string, unknown>)["goalId"];
  const remoteUrl = (parsed as Record<string, unknown>)["remoteUrl"];
  if (typeof goalId !== "string" || goalId === "" || typeof remoteUrl !== "string" || remoteUrl === "") return null;
  return Object.freeze({
    decidedAt: decision.decidedAt,
    decisionId: decision.decisionId,
    goalId,
    principalId: decision.key.principalId,
    remoteUrl,
  });
}

/** Every goal's publish requests and receipts, from one walk of the decision ledger. */
export function readPublishLedger(
  store: SqliteEventStore, projectId: string,
): ReadonlyMap<string, GoalPublishState> {
  const requests = new Map<string, PublishRequest[]>();
  const receipts = new Map<string, Map<string, PublishReceiptV1>>();
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, LEDGER_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId || decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      if (!decision.targetAggregateId.startsWith("publish:")) continue;
      if (decision.commandKind === REPOSITORY_PUBLISH_COMMAND_KIND) {
        const request = decodeRequest(decision);
        if (request === null || publishAggregateId(request.goalId) !== decision.targetAggregateId) continue;
        const list = requests.get(request.goalId) ?? [];
        list.push(request);
        requests.set(request.goalId, list);
      } else if (decision.commandKind === PUBLISH_RECEIPT_COMMAND_KIND
        && decision.key.principalId === NODE_PUBLISHER_PRINCIPAL_ID) {
        const decoded = decodePublishReceiptBytes(decision.resultBytes);
        if (!decoded.ok || publishAggregateId(decoded.receipt.goalId) !== decision.targetAggregateId) continue;
        const byDecision = receipts.get(decoded.receipt.goalId) ?? new Map<string, PublishReceiptV1>();
        byDecision.set(decoded.receipt.decisionId, decoded.receipt);
        receipts.set(decoded.receipt.goalId, byDecision);
      }
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const states = new Map<string, GoalPublishState>();
  for (const [goalId, list] of requests) {
    states.set(goalId, Object.freeze({
      receipts: receipts.get(goalId) ?? new Map<string, PublishReceiptV1>(),
      requests: Object.freeze(list),
    }));
  }
  return states;
}

export function readPublishReceipt(
  store: SqliteEventStore, projectId: string, receiptId: string,
): PublishReceiptReadResult {
  let decision: CommandDecisionRecord | null;
  try {
    decision = store.getCommandDecision({
      commandId: receiptId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, projectId,
    });
  } catch {
    return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
  }
  if (decision === null) return { code: "PUBLISH_RECEIPT_NOT_FOUND", ok: false };
  if (decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== PUBLISH_RECEIPT_COMMAND_KIND
    || decision.key.commandId !== receiptId || decision.key.projectId !== projectId) {
    return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
  }
  const decoded = decodePublishReceiptBytes(decision.resultBytes);
  if (!decoded.ok || decoded.receipt.receiptId !== receiptId || decoded.receipt.projectId !== projectId
    || decision.targetAggregateId !== publishAggregateId(decoded.receipt.goalId)) {
    return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
  }
  return { decision, ok: true, receipt: decoded.receipt };
}

export function recordPublishReceipt(
  store: SqliteEventStore, input: RecordPublishReceiptInput,
): PublishRecordResult {
  const receiptId = publishReceiptId(input.projectId, input.goalId, input.decisionId);
  const historical = readPublishReceipt(store, input.projectId, receiptId);
  if (historical.ok) return { ok: true, receipt: historical.receipt, replayed: true };
  if (historical.code === "PUBLISH_RECEIPT_INVALID") return { code: historical.code, ok: false };
  const receipt: PublishReceiptV1 = {
    branch: input.branch,
    decidedAt: input.decidedAt,
    decisionId: input.decisionId,
    goalId: input.goalId,
    outcome: input.refusal === null ? "PUSHED" : "REFUSED",
    projectId: input.projectId,
    receiptId,
    refusal: input.refusal,
    remoteUrl: input.remoteUrl,
    sha: input.sha,
    url: input.url,
    version: PUBLISH_RECEIPT_VERSION,
  };
  const resultBytes = encoder.encode(JSON.stringify(receipt));
  if (!decodePublishReceiptBytes(resultBytes).ok) return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
  const aggregateId = publishAggregateId(input.goalId);
  const event: EventDraft = {
    eventId: `${receiptId}-PublishRecorded`,
    eventType: receipt.outcome === "PUSHED" ? "RepositoryPublished" : "RepositoryPublishRefused",
    payload: encoder.encode(JSON.stringify({
      decisionId: input.decisionId, goalId: input.goalId, outcome: receipt.outcome, receiptId,
      sha: input.sha,
    })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: PUBLISH_RECEIPT_COMMAND_KIND,
    committedResultBytes: resultBytes,
    correlationId: "node-publisher-receipt",
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId: receiptId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: encoder.encode(JSON.stringify({
      decisionId: input.decisionId, goalId: input.goalId, receiptId, version: PUBLISH_RECEIPT_VERSION,
    })),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  }
  const persisted = readPublishReceipt(store, input.projectId, receiptId);
  if (!persisted.ok) return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
  return { ok: true, receipt: persisted.receipt, replayed: false };
}
