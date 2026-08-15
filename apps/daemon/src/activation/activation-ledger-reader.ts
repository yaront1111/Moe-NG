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

import type { StoredEvent } from "@moe/store";

import { decodeActivationLedgerRecord } from "./activation-ledger-codec.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  activationLedgerUnknown,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type { ActivationLedgerDecodeResult } from "./activation-ledger-contracts.js";

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

const TRANSITION_ORDER = Object.freeze([
  "GRANT_CONSUMED", "PREFLIGHT_REGISTERED", "PROCESS_OBSERVED",
] as const);
const MAX_SCAN_PAGES = 64, SCAN_PAGE_SIZE = 100, MAX_QUERY_CHARS = 400;
const LEASE_FIELDS = Object.freeze([
  "leaseId", "kind", "ownerSessionRef", "leaseToken", "epoch", "state", "serverWallDeadline",
  "bootId", "monotonicObservation", "authorityHashRef", "version",
] as const);

export interface FoundationActivationHistory {
  readonly record: ActivationLedgerRecord;
  readonly transitions: readonly FoundationTransition[];
}

export type FoundationHistoryResult =
  | { readonly ok: true; readonly history: FoundationActivationHistory }
  | { readonly ok: false; readonly result: FoundationBindingResult };

/** The exact store surface the binding reader uses. Every commit method is
 *  absent BY CONSTRUCTION: a reader that cannot name a write cannot perform one. */
export interface FoundationBindingStore {
  getHealth(): StoreHealth;
  readEvents(aggregateId: string): readonly StoredEvent[];
  readEventsAfter(afterGlobalPosition: bigint, limit?: number): CursorPage<StoredEvent, bigint>;
}

type UnknownCode = Parameters<typeof foundationBindingUnknown>[0];

const unknownHistory = (code: UnknownCode): FoundationHistoryResult =>
  Object.freeze({ ok: false as const, result: foundationBindingUnknown(code) });

function tracedProject(event: StoredEvent, projectId: string): boolean {
  return event.decisionTrace !== undefined && event.decisionTrace.projectId === projectId;
}

/** Rechecks one decoded transition against the committed activation it claims. */
function bindsActivation(
  transition: FoundationTransition, record: ActivationLedgerRecord,
  previous: FoundationTransition | undefined,
): boolean {
  if (transition.activationDigest !== record.activationDigest) return false;
  if (transition.grantId !== record.grant.grantId) return false;
  if (transition.intentId !== record.effectIntent.intentId) return false;
  if (transition.attemptId !== record.attempt.attemptId) return false;
  if (transition.wrapperIdentity !== record.grant.wrapperIdentity) return false;
  if (transition.tag === "GRANT_CONSUMED") return true;
  if (transition.lockIdentity === null || transition.processIdentity === null) return false;
  if (transition.bootstrapCredentialDigest === null || transition.registeredAt === null) return false;
  if (transition.tag !== "PROCESS_OBSERVED") return true;
  // The observed process must hold the lock its own preflight reserved, under a
  // DIFFERENT process identity: a preflight re-presented under the observed tag
  // would otherwise persist a reservation as process authority.
  if (previous === undefined || previous.tag !== "PREFLIGHT_REGISTERED") return false;
  return transition.lockIdentity === previous.lockIdentity
    && transition.processIdentity !== previous.processIdentity;
}

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

function isQueryText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_QUERY_CHARS
    && value.isWellFormed();
}

function sameLease(left: LeaseRecord, right: LeaseRecord): boolean {
  return LEASE_FIELDS.every((field) => left[field] === right[field]);
}

interface ScanOutcome {
  readonly aggregateId: string | null;
  readonly refusal: FoundationBindingResult | null;
}

/**
 * A restart-safe completeness proof, not a lookup table.
 *
 * `CoordinationEffectQuery` carries an effectId but not the idempotency key the
 * aggregate id derives from, and schema work is out of scope, so the only honest
 * way to find the activation is to walk the public event stream and prove the
 * match is UNIQUE. Every page must make progress and every candidate must read;
 * a truncated, non-monotonic, thrown, or ambiguous scan is UNKNOWN, never the
 * ABSENT a caller would act on.
 */
function scanForEffect(store: FoundationBindingStore, effectId: string): ScanOutcome {
  const no = (code: UnknownCode): ScanOutcome =>
    ({ aggregateId: null, refusal: foundationBindingUnknown(code) });
  let cursor = 0n;
  let found: string | null = null;
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    let read: CursorPage<StoredEvent, bigint>;
    try {
      read = store.readEventsAfter(cursor, SCAN_PAGE_SIZE);
    } catch {
      return no("FOUNDATION_BINDING_EVIDENCE_UNREADABLE");
    }
    if (read.hasMore && read.items.length === 0) return no("FOUNDATION_BINDING_SCAN_INCOMPLETE");
    for (const event of read.items) {
      if (event.eventType !== ACTIVATION_LEDGER_EVENT_TYPE) continue;
      const candidate = readActivationLedgerRecord(event.aggregateId, [event]);
      if (!candidate.ok) return no("FOUNDATION_BINDING_EVIDENCE_MALFORMED");
      if (candidate.record.effectIntent.intentId !== effectId) continue;
      if (found !== null && found !== event.aggregateId) {
        return no("FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS");
      }
      found = event.aggregateId;
    }
    if (!read.hasMore) return { aggregateId: found, refusal: null };
    const next = read.nextCursor;
    if (next === null || next <= cursor) return no("FOUNDATION_BINDING_SCAN_INCOMPLETE");
    cursor = next;
  }
  return no("FOUNDATION_BINDING_SCAN_INCOMPLETE");
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
