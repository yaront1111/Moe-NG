/**
 * THE ATTEMPT-RELEASE FENCE LEGS.
 *
 * THE SAFETY RULE, and it is the whole module: the release row and every version
 * this release DERIVED its evidence from must be judged in ONE store decision. The
 * seam this replaces was check-then-write — build the handoff, read the source and
 * resource versions, recheck them, then separately commit only the release
 * aggregate at `expectedVersion: 0`. A second connection on the file-backed store
 * (another daemon, a concurrent `resource.reconcile`, a replay) that moves any of
 * those sources between the last read and the commit produces a DAEMON_VERIFIED
 * row over stale evidence — permanently, because `expectedVersion: 0` means the
 * first row an attempt's release aggregate receives is the only one it can hold.
 *
 * IT TAKES NO STORE AND PERFORMS NO READ, and that signature IS the fence. Every
 * version here was captured by the caller AT ITS READ; a module that could read
 * could fence at a version nobody observed, which is the defect wearing a fix's
 * clothing. The composer only orders and shapes what it was handed.
 *
 * IT TAKES NO REQUEST AND NO CALLER-SUPPLIED ROSTER. There is no field on
 * `AttemptReleaseRequest` that could reach this function, and `carriesHandoffClaim`
 * already refuses a request that so much as SPELLS a handoff key. The observation
 * set is SERVER-OWNED.
 *
 * THE SLOT SET IS EXACT, AND A MISSING OR UNKNOWN SLOT REFUSES RATHER THAN BEING
 * IGNORED. An ignored fence is an unfenced aggregate that still reads as fenced,
 * which is the only failure mode worse than the one this module closes.
 *
 * WHY SEVEN AND NOT TEN. `MAX_DECISION_LEGS` is 8 and the DDL interpolates it
 * (`leg_count BETWEEN 1 AND 8`), so raising it is a schema migration. One primary
 * plus seven fences fits exactly. The three release-path aggregates NOT fenced are
 * excluded on measured grounds, not on budget: the capture and context aggregates
 * are singletons written at `expectedVersion: 0` with strict-one readers, so their
 * ids cannot move; and the exact activation-keyed artifact aggregate the handoff
 * classifier reads has NO production writer at all — its only writer is passed
 * `bound.target`, a different aggregate — so fencing it would fence nothing.
 *
 * NOTHING HERE RE-DERIVES ANYTHING. Not terminality, not the safe boundary, not
 * the handoff. `release-terminal-evidence.ts` forbids a second definition and this
 * module carries versions only. There is also no global `readEventHorizon` fence:
 * that moves on ANY write anywhere and would refuse nearly every release on a busy
 * daemon — a livelock, not a fence.
 */

import type { EventDraft, ExpectedVersionDecisionLeg } from "@moe/store";

/**
 * THE FENCE ROSTER, frozen and exact. Seven slots, sorted, no duplicate. A
 * consumer enumerates THIS rather than a count literal, and the composer asserts
 * set-equality against it in both directions — a roster that only iterates itself
 * shrinks with the deletion of a member and stays green while a fence vanishes.
 */
export const ATTEMPT_RELEASE_FENCE_SLOTS = Object.freeze([
  "ACTIVATION", "BINDING", "DISPATCH", "JOURNAL", "PROVIDER_RUN", "RESOURCE", "STEP",
] as const);
export type AttemptReleaseFenceSlot = (typeof ATTEMPT_RELEASE_FENCE_SLOTS)[number];

/**
 * WHICH FENCE REFUSED, and every member names a DIFFERENT repair. A moved resource
 * set, a moved evidence source, a moved attempt stream and a second caller's
 * handoff binding are four different faults; collapsing them into one code would
 * hide which one an operator has to chase. The composer's own input faults get the
 * fifth code, because a roster this daemon composed badly is not a race at all.
 *
 * The vocabulary is exported rather than spelled inline so the union in
 * `./attempt-release-store.js` names a TYPE instead of repeating five strings.
 */
export const ATTEMPT_RELEASE_FENCE_LEG_CODES = Object.freeze([
  "ATTEMPT_RELEASE_ATTEMPT_FENCE_STALE",
  "ATTEMPT_RELEASE_BINDING_FENCE_STALE",
  "ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT",
  "ATTEMPT_RELEASE_RESOURCE_FENCE_STALE",
  "ATTEMPT_RELEASE_SOURCE_FENCE_STALE",
] as const);
export type AttemptReleaseFenceLegCode = (typeof ATTEMPT_RELEASE_FENCE_LEG_CODES)[number];

/**
 * This module's own layer, published as a closed TYPE with the constant kept
 * MODULE-PRIVATE. A column-zero exported `*_LAYER` is a declared production
 * boundary, and the security roster then demands a hostile BEFORE/AFTER/RACE trio
 * for it. The layer exists because refusing a release whose evidence moved is a
 * decision taken HERE — not a kernel verdict, not a producer's, and not the
 * terminality deferral `DAEMON_ATTEMPT_RELEASE` already names.
 */
const LAYER = "DAEMON_ATTEMPT_RELEASE_FENCE" as const;
export type AttemptReleaseFenceLegLayer = typeof LAYER;

/** ONE aggregate's observation, captured at ITS read by the caller that read it. */
export interface AttemptReleaseFenceObservation {
  readonly aggregateId: string;
  readonly slot: AttemptReleaseFenceSlot;
  /** The version OBSERVED at read time. Never re-read, never defaulted. */
  readonly version: number;
}

/** The release row itself: the only leg that appends, always at version zero. */
export interface AttemptReleasePrimaryLeg {
  readonly aggregateId: string;
  readonly events: readonly EventDraft[];
}

export interface AttemptReleaseFenceLegsComposed {
  /** Ordered for `commitExpectedVersionDecisionLegs`: primary first, then fences. */
  readonly legs: readonly ExpectedVersionDecisionLeg[];
  readonly ok: true;
  /** The fences as composed, slot-sorted. The surface a roster proof is graded on. */
  readonly roster: readonly AttemptReleaseFenceObservation[];
}

export interface AttemptReleaseFenceLegsRefused {
  readonly code: AttemptReleaseFenceLegCode;
  readonly layer: AttemptReleaseFenceLegLayer;
  readonly ok: false;
}

export type AttemptReleaseFenceLegsOutcome =
  AttemptReleaseFenceLegsComposed | AttemptReleaseFenceLegsRefused;

const refuse = (code: AttemptReleaseFenceLegCode): AttemptReleaseFenceLegsRefused =>
  Object.freeze({ code, layer: LAYER, ok: false as const });

/** Which fault a moved slot IS. Exhaustive over the frozen slot set by
 *  construction: a slot added to the roster without an entry here fails to
 *  typecheck rather than defaulting to a neighbour's diagnosis. */
const FAULT_OF: Readonly<Record<AttemptReleaseFenceSlot, AttemptReleaseFenceLegCode>> =
  Object.freeze({
    ACTIVATION: "ATTEMPT_RELEASE_ATTEMPT_FENCE_STALE",
    BINDING: "ATTEMPT_RELEASE_BINDING_FENCE_STALE",
    DISPATCH: "ATTEMPT_RELEASE_ATTEMPT_FENCE_STALE",
    JOURNAL: "ATTEMPT_RELEASE_SOURCE_FENCE_STALE",
    PROVIDER_RUN: "ATTEMPT_RELEASE_SOURCE_FENCE_STALE",
    RESOURCE: "ATTEMPT_RELEASE_RESOURCE_FENCE_STALE",
    STEP: "ATTEMPT_RELEASE_SOURCE_FENCE_STALE",
  } as const);

/** A head this daemon could not READ, so no honest fence can be composed over it.
 *  It is deliberately the roster code rather than a race code: nothing moved, the
 *  roster simply could not be completed, and naming a race would be a fabricated
 *  diagnosis. Exported so the release writer answers under THIS layer instead of
 *  borrowing the resource fence's terminality code for an unreadable stream. */
export const unreadableFenceHead = (): AttemptReleaseFenceLegsRefused =>
  refuse("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");

const admissibleVersion = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * The ordered legs for ONE release decision, or a refusal that composes nothing.
 *
 * `legs[0]` is the release primary at `expectedVersion: 0` carrying the release
 * event — the single-row property the release aggregate has always had, kept
 * exactly. `legs[1..7]` are the fences, each with an exactly-empty `events` array,
 * which is the store's documented READ-ONLY form: it is version-checked under the
 * write lock before any append and grants no receipt authority.
 *
 * EVERY REFUSAL IS FAIL-CLOSED AND COMPOSES ZERO LEGS. A duplicate slot, a missing
 * slot, an unknown slot, a blank aggregate id, an aggregate id equal to the release
 * primary's, or a version that is not a safe non-negative integer all refuse: none
 * of them can be repaired by guessing, and a guessed fence is an unfenced
 * aggregate.
 */
export function composeAttemptReleaseFenceLegs(
  primary: AttemptReleasePrimaryLeg,
  observations: readonly AttemptReleaseFenceObservation[],
): AttemptReleaseFenceLegsOutcome {
  if (primary.aggregateId.length === 0 || primary.events.length === 0) {
    return refuse("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");
  }
  const bySlot = new Map<AttemptReleaseFenceSlot, AttemptReleaseFenceObservation>();
  for (const observation of observations) {
    // UNKNOWN AND DUPLICATE BOTH REFUSE. A slot the roster does not name cannot be
    // classified, and a second observation for one slot means two answers about one
    // aggregate — neither is a fence.
    if (!ATTEMPT_RELEASE_FENCE_SLOTS.includes(observation.slot)) {
      return refuse("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");
    }
    if (bySlot.has(observation.slot)) return refuse("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");
    if (observation.aggregateId.length === 0
      || observation.aggregateId === primary.aggregateId
      || !admissibleVersion(observation.version)) {
      return refuse("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");
    }
    bySlot.set(observation.slot, observation);
  }
  // SET-EQUALITY, BOTH DIRECTIONS. The loop above rejected every slot the roster
  // does not name; this rejects every roster slot the caller did not observe. One
  // direction alone shrinks with its own input and stays green.
  if (bySlot.size !== ATTEMPT_RELEASE_FENCE_SLOTS.length) {
    return refuse("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");
  }
  const roster: AttemptReleaseFenceObservation[] = [];
  const aggregateIds = new Set<string>([primary.aggregateId]);
  for (const slot of ATTEMPT_RELEASE_FENCE_SLOTS) {
    const observation = bySlot.get(slot);
    if (observation === undefined) return refuse("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");
    // TWO SLOTS MAY NOT NAME ONE AGGREGATE. The store refuses a duplicate leg with
    // STORE_INPUT_INVALID, which would report a caller fault as a store fault and
    // would make one of the two fences silently unreachable.
    if (aggregateIds.has(observation.aggregateId)) {
      return refuse("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");
    }
    aggregateIds.add(observation.aggregateId);
    roster.push(Object.freeze({ ...observation }));
  }
  const legs: ExpectedVersionDecisionLeg[] = [Object.freeze({
    aggregateId: primary.aggregateId, events: Object.freeze([...primary.events]),
    // ZERO, ALWAYS. Deriving it from a tail would let a release append onto a row
    // that already stands, and no later write can correct a release row.
    expectedVersion: 0,
  })];
  for (const observation of roster) {
    legs.push(Object.freeze({
      aggregateId: observation.aggregateId,
      // EXACTLY EMPTY, and that is what makes this leg a read-only fence rather
      // than an append: the store grants it no receipt authority.
      events: Object.freeze([]), expectedVersion: observation.version,
    }));
  }
  return Object.freeze({
    legs: Object.freeze(legs), ok: true as const, roster: Object.freeze(roster),
  });
}

/**
 * WHICH FENCE THE STORE FOUND STALE, from the decision the store actually
 * returned.
 *
 * On a rejected multi-leg decision the durable `targetAggregateId` is the STALE
 * LEG, not the primary — so this maps that id back through the roster THIS call
 * composed. An id the roster does not carry (including the primary's own) is not a
 * fence conflict this module can attribute, and answering a neighbouring slot's
 * code would be a fabricated diagnosis.
 *
 * THE AGGREGATE ID DOES NOT TRAVEL OUT. Only the class does. `message` is the one
 * free-text field a release refusal may carry, and a durable aggregate id placed
 * there would leak an identifier to every caller that can see a refusal.
 */
export function classifyAttemptReleaseFenceConflict(
  roster: readonly AttemptReleaseFenceObservation[], staleAggregateId: string,
): AttemptReleaseFenceLegsRefused | null {
  const stale = roster.find(
    (observation) => observation.aggregateId === staleAggregateId);
  return stale === undefined ? null : refuse(FAULT_OF[stale.slot]);
}
