import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { CommandDecisionRecord, EventDraft, SqliteEventStore, StoredEvent } from "@moe/store";

import {
  NODE_PUBLISHER_PRINCIPAL_ID, PUBLISH_RECEIPT_COMMAND_KIND, PUBLISH_RECEIPT_VERSION,
  REMOTE_BOUND_EVENT_TYPE, REPOSITORY_PUBLISH_COMMAND_KIND, admitRemoteUrl,
  decodePublishReceiptBytes, publishAggregateId, publishReceiptId, remoteAggregateId,
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

/** Restated by hand: the binding payload carries these three keys and nothing else. */
const REMOTE_BOUND_KEYS = ["boundAt", "boundBy", "remoteUrl"] as const;

/** The project's current remote: which url, when it was bound, and by which principal. */
export type ProjectRemote = Readonly<{ boundAt: string; boundBy: string; remoteUrl: string }>;

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

/**
 * The remote the operator bound for this project, or null while none is readable.
 *
 * FAIL CLOSED, and deliberately: the LAST binding is the operator's current answer, so an
 * unreadable or no-longer-admissible last binding reads as null rather than falling back to the
 * remote it replaced. Silently resolving a superseded remote would push a goal's branch somewhere
 * the operator has already moved away from, which is worse than refusing.
 *
 * `admitRemoteUrl` is re-applied on the READ as well as the write: a stored url stays subject to
 * today's admission rule, so tightening that rule retires old bindings instead of grandfathering
 * them into a push.
 */
export function readProjectRemote(store: SqliteEventStore, projectId: string): ProjectRemote | null {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(remoteAggregateId(projectId));
  } catch {
    return null;
  }
  let latest: StoredEvent | null = null;
  for (const event of events) {
    if (event.eventType !== REMOTE_BOUND_EVENT_TYPE) continue;
    if (latest === null || event.aggregateSequence >= latest.aggregateSequence) latest = event;
  }
  return latest === null ? null : decodeBinding(latest.payload);
}

function decodeBinding(payload: Uint8Array): ProjectRemote | null {
  const decoded = decodeBoundedJsonBytes(payload);
  if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null
    || Array.isArray(decoded.value)) {
    return null;
  }
  const record = decoded.value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== REMOTE_BOUND_KEYS.length || !REMOTE_BOUND_KEYS.every((key) => keys.includes(key))) {
    return null;
  }
  const { boundAt, boundBy } = record;
  const remoteUrl = admitRemoteUrl(record["remoteUrl"]);
  if (remoteUrl === null || typeof boundAt !== "string" || boundAt === ""
    || typeof boundBy !== "string" || boundBy === "") {
    return null;
  }
  return Object.freeze({ boundAt, boundBy, remoteUrl });
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
