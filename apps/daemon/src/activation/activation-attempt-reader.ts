/**
 * The durable activation binding for ONE ATTEMPT, read from committed evidence.
 *
 * A provider reader holding opaque request bytes can name an attempt but cannot
 * prove whose authenticated session it is. Here the caller supplies a project and
 * an attempt; aggregate, effect, epoch and owner session come from the committed
 * activation, so no caller can name a binding into existence.
 *
 * SEPARATE FROM `activation-ledger-reader.ts` BY CONSTRUCTION: that reader is at
 * its size rail and answers the CURRENT binding with a clock in hand. This one is
 * a lifecycle-free projection that delegates history judgement back to it.
 *
 * EVERY CANDIDATE IS VERIFIED BEFORE THE ATTEMPT IS COMPARED: filtering first
 * would skip a malformed neighbour and return a partial answer as authority. The
 * walk is bounded by ONE captured horizon and by nothing else, never
 * early-returns, and never picks a match by order or epoch.
 */
import { validateActivationCommit } from "@moe/runner";
import { parseLeaseRecord } from "@moe/scheduler";
import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionRecord, CommandDecisionKey, CommandReceipt, CursorPage,
  DurableStoreErrorCode, StoreHealth, StoredEvent,
} from "@moe/store";

import {
  ACTIVATION_LEDGER_COMMAND_KIND, ACTIVATION_LEDGER_EVENT_TYPE,
} from "./activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "./activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "./activation-ledger-reader.js";
import { FOUNDATION_ACTIVATION_BINDING_LAYER } from "./foundation-activation-transition.js";
import type {
  FoundationBindingAbsentCode, FoundationBindingUnknownCode,
} from "./foundation-activation-transition.js";
import { isQueryText, sameLease } from "./foundation-binding-predicates.js";

/** Commit, apply, raw handle and the UNFILTERED pager are absent BY CONSTRUCTION. */
export interface ActivationAttemptStore {
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  getHealth(): StoreHealth;
  readEventHorizon(): bigint;
  readEvents(aggregateId: string): readonly StoredEvent[];
  readEventsByTypeAfter(
    eventType: string, afterGlobalPosition: bigint, limit?: number,
  ): CursorPage<StoredEvent, bigint>;
}
/** Primitives only: holdable without holding the record. */
export interface FoundationAttemptBinding {
  readonly activationAggregateId: string; readonly activationDigest: string;
  readonly attemptId: string; readonly effectIntentId: string; readonly epoch: number;
  readonly ownerSessionRef: string; readonly projectId: string; readonly status: "BOUND";
}
export interface FoundationAttemptAbsent {
  readonly code: FoundationBindingAbsentCode; readonly status: "ABSENT";
  readonly layer: typeof FOUNDATION_ACTIVATION_BINDING_LAYER;
}
/** `storeCode` is MANDATORY: the sibling `FoundationBindingResult` has no such
 *  field, so an underlying refusal used to arrive with its origin flattened
 *  away. It carries the public `DurableStoreError.code` only, never a message. */
export interface FoundationAttemptUnknown {
  readonly code: FoundationBindingUnknownCode; readonly status: "UNKNOWN";
  readonly layer: typeof FOUNDATION_ACTIVATION_BINDING_LAYER;
  readonly storeCode: DurableStoreErrorCode | null;
}
type AttemptRefusal = FoundationAttemptAbsent | FoundationAttemptUnknown;
type DecisionTrace = NonNullable<StoredEvent["decisionTrace"]>;
export type FoundationAttemptResult = AttemptRefusal | FoundationAttemptBinding;
const PAGE_SIZE = 100;
const INCOMPLETE = "FOUNDATION_BINDING_SCAN_INCOMPLETE";
const MALFORMED = "FOUNDATION_BINDING_EVIDENCE_MALFORMED";
const INCOHERENT = "FOUNDATION_BINDING_ACTIVATION_INCOHERENT";
const UNREADABLE = "FOUNDATION_BINDING_EVIDENCE_UNREADABLE";
const NOT_FOUND: FoundationAttemptAbsent = Object.freeze({
  code: "FOUNDATION_BINDING_NOT_FOUND" as const,
  layer: FOUNDATION_ACTIVATION_BINDING_LAYER, status: "ABSENT" as const,
});
const no = (
  code: FoundationBindingUnknownCode, storeCode: DurableStoreErrorCode | null = null,
): FoundationAttemptUnknown => Object.freeze({
  code, layer: FOUNDATION_ACTIVATION_BINDING_LAYER, status: "UNKNOWN" as const, storeCode,
});
const unreadable = (error: unknown): FoundationAttemptUnknown =>
  no(UNREADABLE, error instanceof DurableStoreError ? error.code : null);
interface Verified {
  readonly epoch: number; readonly ownerSessionRef: string; readonly record: ActivationLedgerRecord;
}
/** The `instanceof` pair is load-bearing: two non-binary payloads both report an
 *  `undefined` byteLength, so without it a contract-breaking store would reach
 *  `.every` and CRASH where this reader has to refuse. */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left instanceof Uint8Array && right instanceof Uint8Array &&
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
/** The aggregate's head must BE the indexed row, not merely resemble it. */
const sameEvent = (held: StoredEvent, indexed: StoredEvent): boolean =>
  held.eventId === indexed.eventId && held.aggregateId === indexed.aggregateId &&
  held.aggregateSequence === 1 && held.eventType === indexed.eventType &&
  held.commandId === indexed.commandId && held.requestSha256 === indexed.requestSha256 &&
  sameBytes(held.payload, indexed.payload);
/** A filtered scan has no positional contiguity, so the pager's contract is the
 *  completeness proof and its shape is re-checked here before it is trusted. */
function wellShaped(page: unknown): page is CursorPage<StoredEvent, bigint> {
  if (page === null || typeof page !== "object") return false;
  const { hasMore, items, nextCursor } = page as Record<string, unknown>;
  if (typeof hasMore !== "boolean" || !Array.isArray(items)) return false;
  if (items.length > PAGE_SIZE) return false;
  return nextCursor === null || typeof nextCursor === "bigint";
}
/** The decision half; its `requestSha256` is the SCOPED-COMMAND digest, compared
 *  to the TRACE's and never to the event's. */
const decisionAgrees = (
  decision: CommandDecisionRecord, event: StoredEvent, trace: DecisionTrace, projectId: string,
): boolean =>
  decision.effectDisposition === "EFFECTS_COMMITTED" && decision.expectedVersion === 0 &&
  decision.observedVersion === 0 && decision.previousVersion === 0 &&
  decision.currentVersion === 1 && decision.commandKind === ACTIVATION_LEDGER_COMMAND_KIND &&
  decision.key.commandId === trace.commandId && decision.key.principalId === trace.principalId &&
  decision.key.projectId === projectId && decision.targetAggregateId === event.aggregateId &&
  decision.businessEventIds.length === 1 && decision.businessEventIds[0] === event.eventId &&
  decision.outboxMessageIds.length === 0 && decision.requestSha256 === trace.requestSha256 &&
  sameBytes(decision.resultBytes, event.payload);
/** The effect half; its `requestSha256` is the EFFECT digest, a DIFFERENT domain,
 *  compared to the event's and never to the trace's. */
const receiptAgrees = (receipt: CommandReceipt, event: StoredEvent, effect: string): boolean =>
  receipt.commandId === event.commandId && receipt.aggregateId === event.aggregateId &&
  receipt.previousVersion === 0 && receipt.currentVersion === 1 &&
  receipt.eventIds.length === 1 && receipt.eventIds[0] === event.eventId &&
  receipt.outboxMessageIds.length === 0 && receipt.committedAt.length > 0 &&
  receipt.effectSha256 === effect && receipt.requestSha256 === event.requestSha256;
const bindingOf = (
  aggregateId: string, projectId: string, verified: Verified,
): FoundationAttemptBinding => Object.freeze({
  activationAggregateId: aggregateId, activationDigest: verified.record.activationDigest,
  attemptId: verified.record.attempt.attemptId,
  effectIntentId: verified.record.effectIntent.intentId, epoch: verified.epoch,
  ownerSessionRef: verified.ownerSessionRef, projectId, status: "BOUND" as const,
});

/** One candidate, judged whole and in provenance order: trace, decision, receipt,
 *  then the aggregate its bytes claim. The DECISION is keyed by the trace's command
 *  id and the RECEIPT by `event.commandId`; swapping those two reads null. */
function verifyCandidate(
  store: ActivationAttemptStore, event: StoredEvent, projectId: string, horizon: bigint,
): AttemptRefusal | Verified {
  const trace = event.decisionTrace;
  if (trace === undefined || trace.projectId !== projectId) {
    return no("FOUNDATION_BINDING_PROJECT_MISMATCH");
  }
  if (trace.commandKind !== ACTIVATION_LEDGER_COMMAND_KIND) return no(INCOHERENT);
  const key = { commandId: trace.commandId, principalId: trace.principalId, projectId };
  let decision: CommandDecisionRecord | null;
  try { decision = store.getCommandDecision(key); } catch (error) { return unreadable(error); }
  if (decision === null) return no(UNREADABLE);
  if (!decisionAgrees(decision, event, trace, projectId)) return no(INCOHERENT);
  let receipt: CommandReceipt | null;
  try { receipt = store.getCommandReceipt(event.commandId); } catch (e) { return unreadable(e); }
  if (receipt === null) return no(UNREADABLE);
  if (!receiptAgrees(receipt, event, decision.effectSha256)) return no(INCOHERENT);
  let events: readonly StoredEvent[];
  try { events = store.readEvents(event.aggregateId); } catch (error) { return unreadable(error); }
  if (events.some((held) => held.globalPosition > horizon)) return no(INCOMPLETE);
  const [head] = events;
  if (head === undefined || !sameEvent(head, event)) return no(MALFORMED);
  const history = readFoundationActivationHistory(event.aggregateId, events, projectId);
  if (!history.ok) {
    return history.result.status === "UNKNOWN" ? no(history.result.code) : NOT_FOUND;
  }
  const { record } = history.history;
  const lease = parseLeaseRecord(record.lease);
  const bound = parseLeaseRecord(record.effectIntent.leaseBinding);
  if (lease === null || bound === null) return no(MALFORMED);
  if (!sameLease(lease, bound)) return no(INCOHERENT);
  const commit = validateActivationCommit(record.effectIntent, record.attempt, record.grant);
  if (commit.kind !== "COHERENT" || commit.activationDigest !== record.activationDigest) {
    return no(INCOHERENT);
  }
  return { epoch: lease.epoch, ownerSessionRef: lease.ownerSessionRef, record };
}
/** Pages ONLY the activation event type, BOUNDED BY THE CAPTURED HORIZON AND NOT
 *  BY A PAGE OR CANDIDATE COUNT: a fixed cap bounds TOTAL PROJECT ACTIVATIONS,
 *  past which every attempt lookup refuses forever on an append-only ledger — a
 *  refusal indistinguishable from a real authority answer. Termination is the
 *  strict per-page position increase under that horizon. No early return on a
 *  hit: the answer is not "one matched" but "exactly one did", and a second match
 *  on a later page is the difference between a refusal and a wrong answer. A row
 *  beyond the horizon refuses: a binding must not come from a ledger that moved. */
function scanForAttempt(
  store: ActivationAttemptStore, projectId: string, attemptId: string, horizon: bigint,
): AttemptRefusal | FoundationAttemptBinding | null {
  let cursor = 0n;
  let binding: FoundationAttemptBinding | null = null;
  while (cursor < horizon) {
    let page: CursorPage<StoredEvent, bigint>;
    try {
      page = store.readEventsByTypeAfter(ACTIVATION_LEDGER_EVENT_TYPE, cursor, PAGE_SIZE);
    } catch (error) { return unreadable(error); }
    if (!wellShaped(page)) return no(INCOMPLETE);
    let position = cursor;
    for (const event of page.items) {
      if (typeof event.globalPosition !== "bigint" || event.globalPosition <= position) {
        return no(INCOMPLETE);
      }
      position = event.globalPosition;
      if (position > horizon) return no(INCOMPLETE);
      if (event.eventType !== ACTIVATION_LEDGER_EVENT_TYPE) return no(INCOMPLETE);
      const verified = verifyCandidate(store, event, projectId, horizon);
      if ("code" in verified) return verified;
      if (verified.record.attempt.attemptId !== attemptId) continue;
      if (binding !== null && binding.activationAggregateId !== event.aggregateId) {
        return no("FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS");
      }
      binding = bindingOf(event.aggregateId, projectId, verified);
    }
    if (position === cursor) {
      if (page.hasMore) return no(INCOMPLETE);
      break;
    }
    if (page.nextCursor !== position) return no(INCOMPLETE);
    if (!page.hasMore) break;
    cursor = position;
  }
  return binding;
}

/** The activation bound to `attemptId`, or a refusal that grants nothing. Three
 *  arguments after the store, all identity: no session, effect, epoch, limit or
 *  clock, because each would be asserted by the caller rather than proven. */
export function readFoundationActivationByAttempt(
  store: ActivationAttemptStore, projectId: string, attemptId: string,
): FoundationAttemptResult {
  if (!isQueryText(projectId) || !isQueryText(attemptId)) {
    return no("FOUNDATION_BINDING_QUERY_INVALID");
  }
  try {
    if (store.getHealth().projectId !== projectId) return no("FOUNDATION_BINDING_PROJECT_MISMATCH");
  } catch (error) { return unreadable(error); }
  let horizon: bigint;
  try { horizon = store.readEventHorizon(); } catch (error) { return unreadable(error); }
  if (typeof horizon !== "bigint" || horizon < 0n) return no(INCOMPLETE);
  const scan = scanForAttempt(store, projectId, attemptId, horizon);
  if (scan !== null && scan.status !== "BOUND") return scan;
  let settled: bigint;
  try { settled = store.readEventHorizon(); } catch (error) { return unreadable(error); }
  // A horizon that moved means the scan judged a ledger that no longer exists.
  if (settled !== horizon) return no(INCOMPLETE);
  return scan ?? NOT_FOUND;
}
