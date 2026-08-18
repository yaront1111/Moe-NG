/**
 * The decision-verified provider run for ONE ATTEMPT, read from committed bytes.
 *
 * A caller holding an attempt reference can NAME a run but cannot prove one was
 * committed, that the ledger agreed, or whose session committed it. Here every
 * one of those comes from durable evidence: the codec decodes the bytes, the
 * command decision and its receipt settle whether the ledger committed exactly
 * this event, and `readFoundationActivationByAttempt` supplies the session,
 * effect and epoch. No caller-supplied value ever becomes a fact.
 *
 * THE SCAN IS BOUNDED BY ONE CAPTURED HORIZON plus page and candidate ceilings
 * this module owns. It verifies EVERY reserved provider row before comparing the
 * attempt — filtering first would drop a corrupt neighbour silently, after which
 * a later duplicate reads as the unique match. It never returns on a first hit
 * and never prefers a maximum epoch: the answer is not "one matched" but
 * "exactly one did", so two matches is a refusal rather than a choice.
 *
 * THE PRINCIPAL RULE, and the constraint it places on the WRITER. A committed
 * run is only this attempt's if `decision.key.principalId` is the session that
 * held the durable lease, so that one session cannot commit telemetry against
 * another session's attempt. The provider-run commit is a SEPARATE command whose
 * `CommandDecisionKey` is caller-supplied and forwarded verbatim by the ledger,
 * and it has NO production writer yet, so the task that wires
 * `commitActivationProviderRun` MUST set `key.principalId` to the attempt's
 * `ownerSessionRef` or every record it commits is refused here with
 * PROVIDER_RUN_BINDING_MISMATCH. The ACTIVATION command's own principal is a
 * different question and this reader does not touch it.
 *
 * WHICH CODE ANSWERS WHICH QUESTION, inside a vocabulary this module may not
 * extend. EVIDENCE_MALFORMED: the query text, or a page whose SHAPE or contents
 * contradict the pager's contract; `storeCode` null. EVIDENCE_UNREADABLE: a read
 * that could not be obtained or completed — a store call threw (`storeCode` is
 * the store's own code, verbatim), a decision or receipt was absent, the horizon
 * moved, or a ceiling was reached (`storeCode` null). BINDING_MISMATCH:
 * everything parsed and the bindings disagree; the comparison is ours, so
 * `storeCode` is null. RECORD_UNREADABLE: the canonical bytes themselves.
 * ABSENT and AMBIGUOUS answer the candidate COUNT and nothing else.
 *
 * THE ACTIVATION BINDING'S REFUSAL IS RETURNED VERBATIM, with its own code, its
 * own layer and its own mandatory `storeCode`. Flattening it into this family's
 * codes would make an absent activation indistinguishable from an unreadable
 * store, which is the distinction that decides whether retrying helps.
 */

import type {
  CommandDecisionKey, CommandDecisionRecord, CommandReceipt, CursorPage, StoreHealth, StoredEvent,
} from "@moe/store";

import {
  readFoundationActivationByAttempt, type FoundationAttemptResult,
} from "../activation/activation-attempt-reader.js";
import { isQueryText } from "../activation/foundation-binding-predicates.js";
import { PROVIDER_RUN_EVENT_TYPE, type ProviderRunRecord } from "./provider-run-contracts.js";
import {
  refuseRead, refuseThrown, verifyProviderRunCandidate, type ProviderRunCandidate,
} from "./provider-run-reader-bindings.js";
import type { ProviderRunRefusal } from "./provider-run-refusals.js";

/**
 * SIX READERS AND NO WRITER, so "this reader mutates nothing" is a property of
 * the TYPE rather than a rule to remember. `ProviderRunStore` is deliberately not
 * reused and not widened: it carries `commitExpectedVersionDecision`, and a
 * reader holding it could write. `readEvents` is the sixth because the activation
 * join this module delegates to needs it; it is still a reader, and a port that
 * cannot NAME a commit cannot reach for one.
 */
export interface ProviderRunReadStore {
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  getHealth(): StoreHealth;
  readEventHorizon(): bigint;
  readEvents(aggregateId: string): readonly StoredEvent[];
  readEventsByTypeAfter(
    eventType: string, afterGlobalPosition: bigint, limit?: number,
  ): CursorPage<StoredEvent, bigint>;
}
/** Identity only. No session, epoch or effect: each would be asserted, not proven. */
export interface ProviderRunReadRequest {
  readonly attemptRef: string; readonly projectId: string;
}
/** `horizon` is what the scan was judged against, `record` the ORIGINAL durable
 *  record decoded from the committed bytes, and `sessionId` the DURABLE lease's
 *  owner session — never the requesting principal. */
export interface ProviderRunReadSuccess {
  readonly ok: true; readonly horizon: bigint; readonly record: ProviderRunRecord;
  readonly recordDigest: string; readonly sessionId: string;
  readonly stdoutReceiptDigest: ProviderRunRecord["stdoutReceiptDigest"];
}
/** Three vocabularies, none flattened into another. Success carries `ok: true`;
 *  this family's refusal carries `ok: false`; the activation binding's refusal
 *  carries its own `status` and neither gains nor loses a field in transit. */
export type ProviderRunReadResult =
  | Exclude<FoundationAttemptResult, { readonly status: "BOUND" }>
  | ProviderRunReadSuccess | ProviderRunRefusal;
/** Matches the activation attempt reader's page size: one discipline, one shape. */
export const PROVIDER_RUN_READER_PAGE_SIZE = 100;
/** Reached, not exceeded: with a strict `>`, 64 pages of 100 could never fire it. */
export const PROVIDER_RUN_READER_MAX_CANDIDATES = 6_400;
export const PROVIDER_RUN_READER_MAX_PAGES = 64;
const MALFORMED = "PROVIDER_RUN_EVIDENCE_MALFORMED", MISMATCH = "PROVIDER_RUN_BINDING_MISMATCH";
const UNREADABLE = "PROVIDER_RUN_EVIDENCE_UNREADABLE";

/** A filtered scan has no positional contiguity, so the pager's contract is the
 *  completeness proof and its shape is re-checked here before it is trusted. */
function wellShaped(page: unknown): page is CursorPage<StoredEvent, bigint> {
  if (page === null || typeof page !== "object") return false;
  const { hasMore, items, nextCursor } = page as Record<string, unknown>;
  if (typeof hasMore !== "boolean" || !Array.isArray(items)) return false;
  if (items.length > PROVIDER_RUN_READER_PAGE_SIZE) return false;
  // Each ROW too, not just the array: `items: [null]` satisfies `Array.isArray`
  // and then CRASHES on the first field read, and a crash is not a refusal.
  if (items.some((item) => item === null || typeof item !== "object")) return false;
  return nextCursor === null || typeof nextCursor === "bigint";
}
/**
 * Pages ONLY the reserved provider-run event type, to bounded exhaustion. NO
 * EARLY RETURN ON A HIT and no preference for a maximum epoch: a second match on
 * a later page is the difference between a refusal and a confident wrong answer,
 * and a reader that stopped at the first would pass every other case in the
 * suite. A row beyond the horizon refuses, because an answer must not come from
 * a ledger that moved.
 */
function scanForAttempt(
  store: ProviderRunReadStore, projectId: string, attemptRef: string, horizon: bigint,
): ProviderRunCandidate | ProviderRunRefusal | null {
  let cursor = 0n, pages = 0, candidates = 0;
  let match: ProviderRunCandidate | null = null;
  while (cursor < horizon) {
    pages += 1;
    if (pages > PROVIDER_RUN_READER_MAX_PAGES) return refuseRead(UNREADABLE);
    let page: CursorPage<StoredEvent, bigint>;
    try {
      page = store.readEventsByTypeAfter(
        PROVIDER_RUN_EVENT_TYPE, cursor, PROVIDER_RUN_READER_PAGE_SIZE);
    } catch (error) { return refuseThrown(error); }
    if (!wellShaped(page)) return refuseRead(MALFORMED);
    let position = cursor;
    for (const event of page.items) {
      candidates += 1;
      // A truncated scan is refused rather than answered: silent truncation is
      // exactly how a duplicate hides behind a confident unique match.
      if (candidates >= PROVIDER_RUN_READER_MAX_CANDIDATES) return refuseRead(UNREADABLE);
      if (typeof event.globalPosition !== "bigint" || event.globalPosition <= position) {
        return refuseRead(MALFORMED);
      }
      position = event.globalPosition;
      // Past the horizon is the ledger having MOVED, which is the fact `settle`
      // refuses on, so it takes that code and not MALFORMED: the pager was right.
      if (position > horizon) return refuseRead(UNREADABLE);
      if (event.eventType !== PROVIDER_RUN_EVENT_TYPE) return refuseRead(MALFORMED);
      // EVERY reserved row is verified BEFORE the attempt is compared: a corrupt
      // neighbour skipped here would let a later duplicate read as unique.
      const verified = verifyProviderRunCandidate(store, event, projectId);
      if ("ok" in verified) return verified;
      if (verified.record.providerRunRef.attemptRef !== attemptRef) continue;
      if (match !== null) return refuseRead("PROVIDER_RUN_EVIDENCE_AMBIGUOUS");
      match = verified;
    }
    if (position === cursor) {
      if (page.hasMore) return refuseRead(MALFORMED);
      break;
    }
    if (page.nextCursor !== position) return refuseRead(MALFORMED);
    if (!page.hasMore) break;
    cursor = position;
  }
  return match;
}

/**
 * The decision-verified provider run bound to `attemptRef`, or a refusal that
 * grants nothing. Two identity fields and no session, epoch, effect, limit or
 * clock: every one of those is read from durable evidence rather than accepted.
 */
export function readCurrentProviderRun(
  store: ProviderRunReadStore, request: ProviderRunReadRequest,
): ProviderRunReadResult {
  const { attemptRef, projectId } = request;
  if (!isQueryText(projectId) || !isQueryText(attemptRef)) return refuseRead(MALFORMED);
  // The project gate answers BEFORE any page is read: a store scoped to another
  // project holds no evidence about this one, and scanning it would be a fact
  // borrowed from the wrong ledger.
  try {
    if (store.getHealth().projectId !== projectId) return refuseRead(MISMATCH);
  } catch (error) { return refuseThrown(error); }
  let horizon: bigint;
  try { horizon = store.readEventHorizon(); } catch (error) { return refuseThrown(error); }
  if (typeof horizon !== "bigint" || horizon < 0n) return refuseRead(MALFORMED);
  const scan = scanForAttempt(store, projectId, attemptRef, horizon);
  if (scan === null) return settle(store, horizon, refuseRead("PROVIDER_RUN_EVIDENCE_ABSENT"));
  if ("ok" in scan) return settle(store, horizon, scan);
  return settle(store, horizon, bindActivation(store, projectId, attemptRef, scan, horizon));
}

/**
 * The ACTIVATION JOIN — the only authority for this run's session, effect and
 * epoch. It is obtained from the landed `readFoundationActivationByAttempt`
 * rather than re-derived here: a second lookup would be a second answer that can
 * disagree with the first. Nothing is INFERRED — not the session from attempt
 * order, not currentness or terminality from a recorded attempt, not the exit
 * from anything.
 *
 * The binding's refusal is returned VERBATIM, keeping its own code, its own
 * layer and its own mandatory `storeCode`. Flattening it would make an absent
 * activation indistinguishable from an unreadable store, which is the
 * distinction that decides whether retrying helps.
 */
function bindActivation(
  store: ProviderRunReadStore, projectId: string, attemptRef: string,
  candidate: ProviderRunCandidate, horizon: bigint,
): ProviderRunReadResult {
  const binding = readFoundationActivationByAttempt(store, projectId, attemptRef);
  if (binding.status !== "BOUND") return binding;
  const ref = candidate.record.providerRunRef;
  // ATTEMPT AND PROJECT ARE REQUIRED BY CONSTRUCTION, not compared here. The scan
  // admits a candidate only when `ref.attemptRef` equals the requested attempt,
  // and the binding is looked up by that same attempt and project, so both
  // equalities hold on every path reaching this line. An `if` over either could
  // never fail, and a guard that cannot fail advertises protection it does not
  // give. EFFECT, EPOCH and PRINCIPAL are free of the lookup key, and each is
  // reddened by its own case in the suite.
  if (ref.effectIntentId !== binding.effectIntentId) return refuseRead(MISMATCH);
  if (ref.epoch !== binding.epoch) return refuseRead(MISMATCH);
  // THE PRINCIPAL RULE. The provider-run commit is a separate command with its
  // own key, and requiring its principal to be the session that held the lease is
  // what stops one session committing telemetry against another's attempt.
  if (candidate.decision.key.principalId !== binding.ownerSessionRef) return refuseRead(MISMATCH);
  return Object.freeze({
    horizon,
    ok: true as const,
    // The ORIGINAL durable record the codec decoded, never a rebuilt lookalike.
    record: candidate.record,
    recordDigest: candidate.digest,
    sessionId: binding.ownerSessionRef,
    stdoutReceiptDigest: candidate.record.stdoutReceiptDigest,
  });
}

/** Re-reads the horizon and only then hands back an answer. A ledger that moved
 *  under the scan means the scan judged evidence that no longer exists, and a
 *  partial answer from it would be a confident wrong one. */
function settle(
  store: ProviderRunReadStore, horizon: bigint, answer: ProviderRunReadResult,
): ProviderRunReadResult {
  let settled: bigint;
  try { settled = store.readEventHorizon(); } catch (error) { return refuseThrown(error); }
  if (settled !== horizon) return refuseRead(UNREADABLE);
  return answer;
}
