/**
 * The production reader for the durable activation ledger.
 *
 * Split from the codec because the codec crossed the 250-line target; decoding
 * bytes and cross-checking an event against the record those bytes carry are
 * separable responsibilities, and the reader is the one worth reading alone.
 *
 * THE READER NEVER RECONSTRUCTS. Every disagreement returns UNKNOWN with an
 * exact code and this module's layer; there is no path that answers from the
 * fields that happened to parse. That is epic rail 4 applied at the one boundary
 * where a wrong answer becomes durable authority: a caller that receives a
 * record here treats it as proof that an activation was committed.
 */

import { validateActivationCommit } from "@moe/runner";
import { parseLeaseRecord } from "@moe/scheduler";
import type { CursorPage, StoreHealth, StoredEvent } from "@moe/store";

import { decodeActivationLedgerRecord } from "./activation-ledger-codec.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  activationLedgerUnknown,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type {
  ActivationLedgerDecodeResult,
  ActivationLedgerRecord,
} from "./activation-ledger-contracts.js";
import {
  FOUNDATION_TRANSITION_EVENT_TYPES,
  decodeFoundationTransition,
  foundationBindingAbsent,
  foundationBindingUnknown,
} from "./foundation-activation-transition.js";
import type {
  FoundationBindingResult,
  FoundationTransition,
} from "./foundation-activation-transition.js";
import {
  TRANSITION_ORDER,
  bindsActivation,
  isQueryText,
  sameLease,
  tracedProject,
} from "./foundation-binding-predicates.js";

/**
 * Answers with the record only when EVERY one of these agrees:
 *
 * 1. exactly one event exists for the aggregate — zero is ABSENT, more is
 *    AMBIGUOUS, and neither is ever resolved by picking one;
 * 2. its type is exactly the ledger's event type;
 * 3. its payload decodes, digest first;
 * 4. the payload's OWN derived aggregate id equals both the aggregate it was
 *    read from and the aggregate the event claims — a payload that derives
 *    somewhere else is evidence about a different activation;
 * 5. the event id equals the record's grantId, which is the durable uniqueness
 *    the store enforces on this ledger's behalf;
 * 6. both successor versions follow their recorded predecessors by exactly one —
 *    the arithmetic `effect-activation.ts:231,235` itself performs.
 */
export function readActivationLedgerRecord(
  aggregateId: string,
  events: readonly StoredEvent[],
): ActivationLedgerDecodeResult {
  if (events.length === 0) return activationLedgerUnknown("ACTIVATION_LEDGER_EVIDENCE_ABSENT");
  if (events.length > 1) return activationLedgerUnknown("ACTIVATION_LEDGER_EVIDENCE_AMBIGUOUS");
  const [event] = events;
  if (event === undefined) return activationLedgerUnknown("ACTIVATION_LEDGER_EVIDENCE_ABSENT");
  if (event.eventType !== ACTIVATION_LEDGER_EVENT_TYPE) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_EVENT_TYPE_UNEXPECTED");
  }
  const decoded = decodeActivationLedgerRecord(event.payload);
  if (!decoded.ok) return decoded;
  const { record } = decoded;
  const derived = deriveActivationAggregateId(
    record.effectIntent.aggregateId,
    record.effectIntent.idempotencyKey,
  );
  if (derived !== aggregateId || derived !== event.aggregateId) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_AGGREGATE_MISMATCH");
  }
  if (event.eventId !== record.grant.grantId) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_EVENT_ID_MISMATCH");
  }
  if (
    record.effectIntent.version !== record.predecessorIntentVersion + 1 ||
    record.attempt.version !== record.predecessorAttemptVersion + 1
  ) {
    return activationLedgerUnknown("ACTIVATION_LEDGER_VERSION_MISMATCH");
  }
  return decoded;
}

/**
 * The Foundation launch history over the SAME aggregate.
 *
 * Sequence 1 stays `readActivationLedgerRecord`'s business, unchanged: this fold
 * isolates that one event and hands it to the strict reader as a SINGLETON, so
 * the reader's exactly-one rule keeps meaning what it meant before a tail
 * existed. Only then is the tail read, and only as the exact ordered optional
 * prefix GRANT_CONSUMED -> PREFLIGHT_REGISTERED -> PROCESS_OBSERVED.
 *
 * EVERY CARRIED IDENTITY IS RECHECKED against the committed activation. A
 * transition that decodes is a well-formed transition; it is not yet evidence
 * about THIS activation, and treating it as such is how a grant consumed on one
 * effect would become authority over another.
 */

const SCAN_PAGE_SIZE = 100;

export interface FoundationActivationHistory {
  readonly record: ActivationLedgerRecord;
  readonly transitions: readonly FoundationTransition[];
}

export type FoundationHistoryResult =
  | { readonly ok: true; readonly history: FoundationActivationHistory }
  | { readonly ok: false; readonly result: FoundationBindingResult };

/** The exact store surface the binding reader uses. Every commit method is
 *  absent BY CONSTRUCTION: a reader that cannot name a write cannot perform one.
 *  `maxDecodedBytes` is published by both pagers and declared by neither here,
 *  exactly as the retired sibling had it: the reader never passes it, and a port
 *  naming an argument its only caller does not use invites a fake to answer one. */
export interface FoundationBindingStore {
  getHealth(): StoreHealth;
  readEventHorizon(): bigint;
  readEvents(aggregateId: string): readonly StoredEvent[];
  readEventsByTypeAfter(
    eventType: string, afterGlobalPosition: bigint, limit?: number,
  ): CursorPage<StoredEvent, bigint>;
}

type UnknownCode = Parameters<typeof foundationBindingUnknown>[0];

const unknownHistory = (code: UnknownCode): FoundationHistoryResult =>
  Object.freeze({ ok: false as const, result: foundationBindingUnknown(code) });

export function readFoundationActivationHistory(
  aggregateId: string, events: readonly StoredEvent[], projectId: string,
): FoundationHistoryResult {
  if (events.length === 0) {
    return Object.freeze({
      ok: false as const, result: foundationBindingAbsent("FOUNDATION_BINDING_NOT_FOUND"),
    });
  }
  if (events.length > TRANSITION_ORDER.length + 1) {
    return unknownHistory("FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS");
  }
  for (const [index, event] of events.entries()) {
    if (event.aggregateId !== aggregateId || event.aggregateSequence !== index + 1) {
      return unknownHistory("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
    }
    if (!tracedProject(event, projectId)) {
      return unknownHistory("FOUNDATION_BINDING_PROJECT_MISMATCH");
    }
  }
  const [initial, ...tail] = events;
  if (initial === undefined) return unknownHistory("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
  const strict = readActivationLedgerRecord(aggregateId, [initial]);
  if (!strict.ok) {
    return unknownHistory(strict.code === "ACTIVATION_LEDGER_EVIDENCE_AMBIGUOUS"
      ? "FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS" : "FOUNDATION_BINDING_EVIDENCE_MALFORMED");
  }
  const transitions: FoundationTransition[] = [];
  for (const [offset, event] of tail.entries()) {
    const tag = TRANSITION_ORDER[offset];
    if (tag === undefined || event.eventType !== FOUNDATION_TRANSITION_EVENT_TYPES[tag]) {
      return unknownHistory("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
    }
    const decoded = decodeFoundationTransition(event.payload);
    if (!decoded.ok || decoded.transition.tag !== tag) {
      return unknownHistory("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
    }
    if (!bindsActivation(decoded.transition, strict.record, transitions[offset - 1])) {
      return unknownHistory("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
    }
    transitions.push(decoded.transition);
  }
  return Object.freeze({
    history: Object.freeze({ record: strict.record, transitions: Object.freeze(transitions) }),
    ok: true as const,
  });
}

interface ScanOutcome {
  readonly aggregateId: string | null;
  readonly refusal: FoundationBindingResult | null;
}

/**
 * Reads the end of the stream ONCE, before any page.
 *
 * The horizon is what makes the walk finite. The pager takes a fresh snapshot
 * per page, so a concurrent writer can keep answering `hasMore` with a strictly
 * advancing cursor forever; a scan that trusts `hasMore` alone has no
 * termination proof at all, only a well-behaved store. Capturing the far end
 * first turns "walk until the store says stop" into "walk to a value the store
 * can no longer move".
 */
function captureHorizon(store: FoundationBindingStore): bigint | UnknownCode {
  let horizon: unknown;
  try {
    horizon = store.readEventHorizon();
  } catch {
    return "FOUNDATION_BINDING_EVIDENCE_UNREADABLE";
  }
  // An unreadable horizon is a store failure; a horizon that is not a
  // nonnegative bigint is evidence about nothing, and neither may become ABSENT.
  if (typeof horizon !== "bigint" || horizon < 0n) return "FOUNDATION_BINDING_SCAN_INCOMPLETE";
  return horizon;
}

/**
 * A restart-safe completeness proof, not a lookup table.
 *
 * `CoordinationEffectQuery` carries an effectId but not the idempotency key the
 * aggregate id derives from, and schema work is out of scope, so the only honest
 * way to find the activation is to page the public event stream and prove the
 * match is UNIQUE. A truncated, non-monotonic, thrown, or ambiguous scan is
 * UNKNOWN, never the ABSENT a caller would act on.
 *
 * WHAT THIS PAGES, AND WHAT THAT COST BEFORE. It reads the EVENT-TYPE-FILTERED
 * stream, so the work is proportional to committed ACTIVATIONS. The retired walk
 * read every global position and discarded non-activations, making every
 * effect-binding lookup O(total project events) and growing for the life of the
 * project.
 *
 * THE COMPLETENESS PROOF CHANGED, AND IT GOT WEAKER. THIS IS THE HONEST TRADE.
 * The retired walk proved completeness by POSITIONAL CONTIGUITY: it derived each
 * expected position as cursor+1 and refused any disagreement, so it proved it
 * had judged every event WITHOUT trusting the store. Under a type filter matches
 * are sparse BY CONSTRUCTION, so contiguity is false on every healthy ledger and
 * cannot be the proof. Completeness now RESTS ON THE PAGER'S OWN CONTRACT - it
 * trusts `hasMore` where the old walk verified positions itself. What makes that
 * sound is that the contract is pinned on the production surface, not assumed:
 * `packages/store/src/event-read-model-contract.test.ts`, case "pages only exact
 * event-type matches across an interleaved ledger", fixes that at the last match
 * the filtered page reports `hasMore:false` with `nextCursor` at that match even
 * when unfiltered rows still follow. Four guards carry what is left:
 *   - STRICT INCREASE, replacing contiguity as the ordering guarantee: a repeated
 *     or backwards position is INCOMPLETE.
 *   - FILTER HONESTY: the event type is re-checked even though the store filters.
 *     One comparison, and it is what keeps the guard honest if the filter ever
 *     regresses into serving the unfiltered stream.
 *   - THE CURSOR NAMES THE LAST RETURNED POSITION - not cursor + items.length,
 *     which is what the retired check asserted and what a filtered page never is.
 *   - AN EMPTY PAGE MAY NOT CLAIM MORE. With no item to advance on, a page that
 *     says `hasMore` is the never-ending walk, and it is refused rather than
 *     spun on.
 *
 * BOUNDED BY THE CAPTURED HORIZON, NOT BY A PAGE COUNT, exactly as before. A
 * fixed page cap bounds TOTAL PROJECT EVENTS, past which every lookup for every
 * effect refuses forever - a refusal indistinguishable from a real authority
 * answer. Growth past H is not this answer's business: a match beyond H is
 * neither returned nor counted toward ambiguity, and it refuses nothing.
 */
function scanForEffect(store: FoundationBindingStore, effectId: string): ScanOutcome {
  const no = (code: UnknownCode): ScanOutcome =>
    ({ aggregateId: null, refusal: foundationBindingUnknown(code) });
  const horizon = captureHorizon(store);
  if (typeof horizon !== "bigint") return no(horizon);
  let cursor = 0n;
  let found: string | null = null;
  while (cursor < horizon) {
    let read: CursorPage<StoredEvent, bigint>;
    try {
      read = store.readEventsByTypeAfter(ACTIVATION_LEDGER_EVENT_TYPE, cursor, SCAN_PAGE_SIZE);
    } catch {
      return no("FOUNDATION_BINDING_EVIDENCE_UNREADABLE");
    }
    let position = cursor;
    let beyondHorizon = false;
    for (const event of read.items) {
      if (event.globalPosition <= position) return no("FOUNDATION_BINDING_SCAN_INCOMPLETE");
      position = event.globalPosition;
      if (position > horizon) { beyondHorizon = true; break; }
      if (event.eventType !== ACTIVATION_LEDGER_EVENT_TYPE) {
        return no("FOUNDATION_BINDING_SCAN_INCOMPLETE");
      }
      const candidate = readActivationLedgerRecord(event.aggregateId, [event]);
      if (!candidate.ok) return no("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
      if (candidate.record.effectIntent.intentId !== effectId) continue;
      // STILL NO EARLY RETURN ON A HIT: the paging runs to the end of the matches
      // even once one is held, because the answer is not "one matched" but
      // "exactly one did". Cheap matches make this look like dead work; it is the
      // uniqueness semantics, and losing it turns a refusal into a wrong answer.
      if (found !== null && found !== event.aggregateId) {
        return no("FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS");
      }
      found = event.aggregateId;
    }
    if (beyondHorizon) break;
    if (position === cursor) {
      if (read.hasMore) return no("FOUNDATION_BINDING_SCAN_INCOMPLETE");
      break;
    }
    if (read.nextCursor !== position) return no("FOUNDATION_BINDING_SCAN_INCOMPLETE");
    if (!read.hasMore) break;
    cursor = position;
  }
  return { aggregateId: found, refusal: null };
}

/**
 * The current effect/session binding, derived ONLY from committed evidence.
 *
 * `effectId` is answered as the committed `effectIntent.intentId` and
 * `sessionId` as the committed `lease.ownerSessionRef`; the caller's values are
 * used for equality and nothing else, so no caller can name a binding into
 * existence. Coordination time is epoch MILLISECONDS while the scheduler's lease
 * deadline is wall SECONDS, and the scheduler's own overdue rule is
 * `seconds > deadline`, so the deadline second itself is still live.
 */
export function readCurrentEffectSessionBinding(
  store: FoundationBindingStore, projectId: string, effectId: string, sessionId: string,
  nowMilliseconds: number,
): FoundationBindingResult {
  if (!isQueryText(projectId) || !isQueryText(effectId) || !isQueryText(sessionId)) {
    return foundationBindingUnknown("FOUNDATION_BINDING_QUERY_INVALID");
  }
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) {
    return foundationBindingUnknown("FOUNDATION_BINDING_QUERY_INVALID");
  }
  try {
    if (store.getHealth().projectId !== projectId) {
      return foundationBindingUnknown("FOUNDATION_BINDING_PROJECT_MISMATCH");
    }
  } catch {
    return foundationBindingUnknown("FOUNDATION_BINDING_EVIDENCE_UNREADABLE");
  }
  const scan = scanForEffect(store, effectId);
  if (scan.refusal !== null) return scan.refusal;
  if (scan.aggregateId === null) return foundationBindingAbsent("FOUNDATION_BINDING_NOT_FOUND");
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(scan.aggregateId);
  } catch {
    return foundationBindingUnknown("FOUNDATION_BINDING_EVIDENCE_UNREADABLE");
  }
  const history = readFoundationActivationHistory(scan.aggregateId, events, projectId);
  if (!history.ok) return history.result;
  const { record } = history.history;
  if (record.effectIntent.state !== "ACTIVE" || record.attempt.state !== "RUNNING") {
    return foundationBindingAbsent("FOUNDATION_BINDING_TERMINAL");
  }
  const lease = parseLeaseRecord(record.lease);
  const bound = parseLeaseRecord(record.effectIntent.leaseBinding);
  if (lease === null || bound === null) {
    return foundationBindingUnknown("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
  }
  if (!sameLease(lease, bound)) {
    return foundationBindingUnknown("FOUNDATION_BINDING_ACTIVATION_INCOHERENT");
  }
  if (lease.state !== "ACTIVE") return foundationBindingAbsent("FOUNDATION_BINDING_LEASE_INACTIVE");
  if (Math.floor(nowMilliseconds / 1_000) > lease.serverWallDeadline) {
    return foundationBindingAbsent("FOUNDATION_BINDING_LEASE_EXPIRED");
  }
  const commit = validateActivationCommit(record.effectIntent, record.attempt, record.grant);
  if (commit.kind !== "COHERENT" || commit.activationDigest !== record.activationDigest) {
    return foundationBindingUnknown("FOUNDATION_BINDING_ACTIVATION_INCOHERENT");
  }
  if (record.effectIntent.intentId !== effectId || lease.ownerSessionRef !== sessionId) {
    return foundationBindingAbsent("FOUNDATION_BINDING_QUERY_MISMATCH");
  }
  return Object.freeze({
    activationDigest: record.activationDigest, effectId: record.effectIntent.intentId,
    sessionId: lease.ownerSessionRef, status: "BOUND" as const,
  });
}
