/**
 * THE CURRENT SAFE-RELEASE AUTHORITY FOR ONE ATTEMPT (task-e62e3828). Core's
 * `safeRelease` (`expansion-planning-hold.ts:208`) decides whether an expansion
 * hold may exist; this is where the evidence it judges COMES FROM — one exact
 * `ExpansionReleaseEvidence` plus the paired `ExpansionHandoffBinding`, derived
 * only from durable facts a released attempt left behind, so no consumer trusts
 * a `DAEMON_VERIFIED` field an agent typed.
 *
 * THE QUERY SELECTS AND CONTRIBUTES NOTHING ELSE: two plain data keys admitted
 * BEFORE any store read, with an extra key REFUSED rather than ignored, because
 * a dropped claim is indistinguishable from an honoured one at the call site.
 *
 * EVERY QUESTION GOES TO ITS OWNER and every refusal keeps THAT owner's code and
 * layer. Nothing is re-derived here and nothing is written: no hold, no
 * PlanningRun, no admission, no activation, no row of any kind.
 */

import type { ExpansionHandoffBinding, ExpansionReleaseEvidence } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import type { FoundationAttemptBinding } from "../activation/activation-attempt-reader.js";
import {
  deriveAttemptReleaseAggregateId, readAttemptRelease,
} from "./attempt-release-disposition.js";
import { readCurrentSafeBoundaryObservation } from "./attempt-safe-boundary-lookup.js";
import { readReleaseHandoffBinding } from "./release-handoff-binding.js";
import { deriveReleaseTerminalEvidence } from "./release-terminal-evidence.js";

/** MODULE-PRIVATE: an exported column-zero `*_LAYER` is a declared security
 *  boundary the roster demands a hostile trio for. Only the TYPE escapes. */
const LAYER = "DAEMON_EXPANSION_RELEASE_AUTHORITY";

/** NINE MEMBERS, each naming a DIFFERENT repair. No generated mirror: this tuple
 *  types the union below and generates the focused test's case table. */
export const EXPANSION_RELEASE_AUTHORITY_CODES = Object.freeze([
  "EXPANSION_RELEASE_REQUEST_INVALID", "EXPANSION_RELEASE_NOT_RELEASED",
  "EXPANSION_RELEASE_CAUSE_MISMATCH", "EXPANSION_RELEASE_TERMINAL_INCOMPLETE",
  "EXPANSION_RELEASE_BOUNDARY_UNSAFE", "EXPANSION_RELEASE_RECEIPT_ABSENT",
  "EXPANSION_RELEASE_CURRENTNESS_MOVED", "EXPANSION_RELEASE_EVIDENCE_CONFLICT",
  "EXPANSION_RELEASE_EVIDENCE_MALFORMED",
] as const);
export type ExpansionReleaseAuthorityCode = (typeof EXPANSION_RELEASE_AUTHORITY_CODES)[number];
export type ExpansionReleaseAuthorityLayer = typeof LAYER;

/** Identity ONLY. A ref, a flag or a state would be an answer, not a question. */
export interface ExpansionReleaseQuery {
  readonly attemptRef: string; readonly projectId: string;
}

export interface ExpansionReleaseBound {
  readonly release: ExpansionReleaseEvidence; readonly status: "BOUND";
  /** The SAME immutable value as `release.handoff`: core compares the two. */
  readonly workerHandoff: ExpansionHandoffBinding;
}
/** Neither object is exposed. `code`/`layer` are this module's own when it
 *  decided, and the upstream authority's VERBATIM when one did. */
export interface ExpansionReleaseRefused {
  readonly code: ExpansionReleaseAuthorityCode | string;
  readonly layer: ExpansionReleaseAuthorityLayer | string;
  readonly status: "ABSENT" | "UNKNOWN";
}
export type ExpansionReleaseAuthorityOutcome = ExpansionReleaseBound | ExpansionReleaseRefused;

export const refuseExpansionRelease = (
  code: ExpansionReleaseRefused["code"], status: ExpansionReleaseRefused["status"],
  layer: ExpansionReleaseRefused["layer"] = LAYER,
): ExpansionReleaseRefused => Object.freeze({ code, layer, status });

const MAX_TEXT = 256;
const RESUMABLE = "WORK_RELEASE_OR_PAUSE";
export const isReleaseText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
const isRefused = (value: object): value is ExpansionReleaseRefused => "status" in value;
const malformed = (): ExpansionReleaseRefused =>
  refuseExpansionRelease("EXPANSION_RELEASE_EVIDENCE_MALFORMED", "UNKNOWN");
const conflict = (): ExpansionReleaseRefused =>
  refuseExpansionRelease("EXPANSION_RELEASE_EVIDENCE_CONFLICT", "UNKNOWN");

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** THE ONLY THING A CALLER MAY SAY: two own plain enumerable DATA properties. An
 *  accessor is refused rather than invoked, so a getter cannot answer one value
 *  to the guard and another to the derivation. */
export function admitExpansionReleaseQuery(query: unknown): ExpansionReleaseQuery | null {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return null;
  const keys = Reflect.ownKeys(query);
  if (keys.length !== 2) return null;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(query, key);
    if (property === undefined || !property.enumerable || !("value" in property)) return null;
  }
  const { attemptRef, projectId } = query as Record<string, unknown>;
  return isReleaseText(attemptRef) && isReleaseText(projectId)
    ? { attemptRef, projectId } : null;
}

/** AGGREGATE-SCOPED: a global horizon moves on any unrelated write and would
 *  refuse nearly every read on a busy daemon. `null` is an unreadable stream,
 *  never a version that merely differs. */
function releaseVersion(store: SqliteEventStore, aggregateId: string): number | null {
  try { return store.readEvents(aggregateId).length; } catch { return null; }
}

interface ReleaseFacts {
  readonly attemptState: string; readonly disposition: ExpansionReleaseEvidence["disposition"];
  /** The SCHEDULER's nine-key checkpoint digest — COMPARED WITH core's two-key
   *  binding and never cast into it: different arity, owner and consumer. */
  readonly journalDigest: string; readonly leaseRef: string; readonly leaseState: string;
  readonly providerSlotRef: string; readonly providerSlotState: string; readonly reason: string;
}

/** The release row is UNTYPED, so every consumed key is checked before use. */
function releaseFacts(record: Record<string, unknown>): ReleaseFacts | ExpansionReleaseRefused {
  const disposition = record["disposition"]; const handoff = record["handoff"];
  if (disposition === null || typeof disposition !== "object"
    || handoff === null || typeof handoff !== "object") return malformed();
  const { resumable, strongestReason, terminalTarget } = disposition as Record<string, unknown>;
  const journalDigest = (handoff as Record<string, unknown>)["journalDigest"];
  const attemptState = record["attemptState"]; const reason = record["reason"];
  const leaseRef = record["leaseRef"]; const leaseState = record["leaseState"];
  const providerSlotRef = record["providerSlotRef"];
  const providerSlotState = record["providerSlotState"];
  if (!isReleaseText(journalDigest) || !isReleaseText(attemptState) || !isReleaseText(reason)
    || !isReleaseText(leaseRef) || !isReleaseText(leaseState) || !isReleaseText(providerSlotRef)
    || !isReleaseText(providerSlotState) || !isReleaseText(strongestReason)
    || !isReleaseText(terminalTarget) || typeof resumable !== "boolean"
    || record["truthClass"] !== "DAEMON_VERIFIED") return malformed();
  return { attemptState, disposition: { resumable, strongestReason, terminalTarget },
    journalDigest, leaseRef, leaseState, providerSlotRef, providerSlotState, reason };
}

/** NOT_RELEASED and CAUSE_MISMATCH demand opposite repairs: one attempt is still
 *  draining, the other settled under a reason `safeRelease` never accepts. */
function releaseUnsafe(facts: ReleaseFacts, outcome: string): ExpansionReleaseRefused | null {
  if (outcome !== "RELEASED" || facts.attemptState !== "RELEASED"
    || facts.leaseState !== "RELEASED" || facts.providerSlotState !== "RELEASED"
    || facts.disposition.terminalTarget !== "RELEASED") {
    return refuseExpansionRelease("EXPANSION_RELEASE_NOT_RELEASED", "UNKNOWN");
  }
  return facts.reason !== RESUMABLE || facts.disposition.strongestReason !== RESUMABLE
    || !facts.disposition.resumable
    ? refuseExpansionRelease("EXPANSION_RELEASE_CAUSE_MISMATCH", "UNKNOWN") : null;
}

interface TerminalFacts {
  readonly effectsTerminal: boolean; readonly resourcesTerminal: boolean;
  readonly terminalEffectRefs: readonly string[]; readonly terminalResourceRefs: readonly string[];
}

/** Terminality is ASKED OF ITS OWNER, with a nonzero denominator on both
 *  families: an empty family is not proof, it is the absence of proof. */
function terminalFacts(
  store: SqliteEventStore, query: ExpansionReleaseQuery,
): TerminalFacts | ExpansionReleaseRefused {
  const evidence = deriveReleaseTerminalEvidence(store, { ...query });
  if (!evidence.ok) return refuseExpansionRelease(evidence.code, "UNKNOWN", evidence.layer);
  if (!evidence.releasable || evidence.enumeratedEffects === 0
    || evidence.enumeratedResources === 0) {
    return refuseExpansionRelease("EXPANSION_RELEASE_TERMINAL_INCOMPLETE", "UNKNOWN");
  }
  if (evidence.attemptRef !== query.attemptRef || evidence.projectId !== query.projectId) {
    return conflict();
  }
  return { effectsTerminal: evidence.effectsTerminal,
    resourcesTerminal: evidence.resourcesTerminal,
    terminalEffectRefs: [...evidence.terminalEffectRefs],
    terminalResourceRefs: [...evidence.terminalResourceRefs] };
}

interface BoundaryFacts { readonly observationRef: string; readonly safeBoundaryObserved: true }

/** THE REF IS THE PRODUCER'S, never recomputed: re-deriving it would reimplement
 *  the producer to ask it a question. Validating the observation is its job too,
 *  and its refusal travels out under ITS code and ITS layer. */
function boundaryFacts(
  store: SqliteEventStore, query: ExpansionReleaseQuery,
): BoundaryFacts | ExpansionReleaseRefused {
  const found = readCurrentSafeBoundaryObservation(store, { ...query });
  if (!found.ok) {
    return refuseExpansionRelease(found.source?.code ?? found.code,
      found.code === "SAFE_BOUNDARY_LOOKUP_ABSENT" ? "ABSENT" : "UNKNOWN",
      found.source?.layer ?? found.layer);
  }
  const { observation } = found;
  if (observation.attemptRef !== query.attemptRef || observation.projectId !== query.projectId
    || observation.observationRef !== found.observationRef) return conflict();
  return observation.safeBoundaryObserved
    ? { observationRef: found.observationRef, safeBoundaryObserved: true as const }
    : refuseExpansionRelease("EXPANSION_RELEASE_BOUNDARY_UNSAFE", "UNKNOWN");
}

interface HandoffFacts { readonly handoff: ExpansionHandoffBinding; readonly receiptRef: string }

/**
 * The CURRENT core binding. `readReleaseHandoffBinding` selects the LATEST row by
 * design — several historical bindings are legitimate and a duplicate aggregate
 * SEQUENCE is the only cardinality ambiguity — re-deriving the journal digest and
 * re-reading the receipt first. `receipt: null` is a MEASURED fact rather than a
 * read failure, and still not authority: it refuses under this module's own
 * RECEIPT_ABSENT, while an UNREADABLE receipt keeps the verification layer's.
 */
function handoffFacts(
  store: SqliteEventStore, activation: FoundationAttemptBinding,
  query: ExpansionReleaseQuery, journalDigest: string,
): HandoffFacts | ExpansionReleaseRefused {
  const read = readReleaseHandoffBinding(store, {
    attemptAggregateId: activation.activationAggregateId, projectId: query.projectId });
  if (!read.ok) {
    return refuseExpansionRelease(read.code,
      read.code === "RELEASE_HANDOFF_BINDING_ABSENT" ? "ABSENT" : "UNKNOWN", read.layer);
  }
  const { binding } = read;
  if (binding.receipt === null) {
    return refuseExpansionRelease("EXPANSION_RELEASE_RECEIPT_ABSENT", "UNKNOWN");
  }
  if (binding.attemptRef !== query.attemptRef || binding.projectId !== query.projectId
    || binding.attemptAggregateId !== activation.activationAggregateId
    || binding.handoff.ref !== activation.activationDigest
    || binding.handoff.digest !== journalDigest) return conflict();
  // The VERIFIED `verificationId`. `receiptSha256` is NOT interchangeable: it
  // stays the binding reader's drift pin, and naming it here would delete that.
  return { handoff: { digest: binding.handoff.digest, ref: binding.handoff.ref },
    receiptRef: binding.receipt.verificationId };
}

/** The current safe-release evidence for ONE attempt, or a refusal that grants
 *  nothing. The activation is selected FIRST by identity alone; everything below
 *  is keyed off the binding the STORE answered, never off a caller value. */
export function readCurrentExpansionRelease(
  store: SqliteEventStore, query: unknown,
): ExpansionReleaseAuthorityOutcome {
  const admitted = admitExpansionReleaseQuery(query);
  if (admitted === null) {
    return refuseExpansionRelease("EXPANSION_RELEASE_REQUEST_INVALID", "UNKNOWN");
  }
  const activation = readFoundationActivationByAttempt(
    store, admitted.projectId, admitted.attemptRef);
  // ABSENT and UNKNOWN travel out under the ACTIVATION READER's own code and
  // layer: a missing attempt and an unreadable ledger demand opposite repairs.
  if (activation.status !== "BOUND") {
    return refuseExpansionRelease(activation.code, activation.status, activation.layer);
  }
  const { activationAggregateId } = activation;
  const aggregateId = deriveAttemptReleaseAggregateId(activationAggregateId);
  const version = releaseVersion(store, aggregateId);
  const stored = readAttemptRelease(store, activationAggregateId);
  if (!stored.ok) {
    return refuseExpansionRelease(stored.code,
      stored.code === "ATTEMPT_RELEASE_RECORD_ABSENT" ? "ABSENT" : "UNKNOWN", stored.refusedBy);
  }
  const facts = releaseFacts(stored.record);
  if (isRefused(facts)) return facts;
  const unsafe = releaseUnsafe(facts, stored.outcome);
  if (unsafe !== null) return unsafe;
  if (stored.record["attemptAggregateId"] !== activationAggregateId
    || stored.record["attemptRef"] !== admitted.attemptRef) return conflict();
  const terminal = terminalFacts(store, admitted);
  if (isRefused(terminal)) return terminal;
  const boundary = boundaryFacts(store, admitted);
  if (isRefused(boundary)) return boundary;
  const handoff = handoffFacts(store, activation, admitted, facts.journalDigest);
  if (isRefused(handoff)) return handoff;
  // THE LAST READ BEFORE THE ANSWER. Evidence composed across a release aggregate
  // that moved under it vouches for a row that no longer stands.
  if (version === null || releaseVersion(store, aggregateId) !== version) {
    return refuseExpansionRelease("EXPANSION_RELEASE_CURRENTNESS_MOVED", "UNKNOWN");
  }
  return compose(admitted, facts, terminal, boundary, handoff);
}

/** Fresh values built ONLY from the stored answers above, then deeply frozen. */
function compose(
  query: ExpansionReleaseQuery, facts: ReleaseFacts, terminal: TerminalFacts,
  boundary: BoundaryFacts, handoff: HandoffFacts,
): ExpansionReleaseBound {
  const shared: ExpansionHandoffBinding = {
    digest: handoff.handoff.digest, ref: handoff.handoff.ref };
  const release: ExpansionReleaseEvidence = {
    attemptRef: query.attemptRef, attemptState: facts.attemptState,
    disposition: facts.disposition, effectsTerminal: terminal.effectsTerminal,
    handoff: shared, leaseRef: facts.leaseRef, leaseState: facts.leaseState,
    observationRef: boundary.observationRef, providerSlotRef: facts.providerSlotRef,
    providerSlotState: facts.providerSlotState, reason: facts.reason,
    receiptRef: handoff.receiptRef, resourcesTerminal: terminal.resourcesTerminal,
    safeBoundaryObserved: boundary.safeBoundaryObserved,
    terminalEffectRefs: terminal.terminalEffectRefs,
    terminalResourceRefs: terminal.terminalResourceRefs, truthClass: "DAEMON_VERIFIED" };
  // ONE value on both sides, so core's `same(release.handoff, workerHandoff)`
  // compares the object with itself rather than two copies that could drift.
  return deepFreeze({ release, status: "BOUND" as const, workerHandoff: shared });
}
