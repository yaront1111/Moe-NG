/**
 * The daemon-owned half of the scheduler-to-core hand-off: the four fact families core's
 * `prepareExpansion` needs that neither kernel produces, plus the live approval claim.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not project `ExpansionAdmittedFacts`.
 * `bindExpansionAdmission` is the SOLE producer of that shape and of the `DAEMON_VERIFIED`
 * truth marking and the `opportunityRef` beside it; a second mapper here would be free to drift
 * from it, and a drifting mapper is how a forged admission survives. So the service calls that
 * bridge and this module supplies only what the bridge has no opinion about.
 *
 * EVERY VALUE BELOW IS DERIVED FROM A VALIDATED PRODUCTION RESULT, NEVER FROM CALLER BYTES.
 *
 *   funding   from the ACCEPTED admission's own budget reservation — the reservation the
 *             scheduler kernel actually took. The `fundingRef` is a deterministic function of
 *             that reservation's `admissionRef` and meter, so it names the reservation it
 *             describes and cannot be presented by a caller. A reservation whose lines span more
 *             than one meter is UNDERIVABLE rather than summed across meters: adding token
 *             quantities to wall-clock quantities would produce a well-formed number that means
 *             nothing, and core would accept it.
 *
 *   fence     from the DURABLE hold's own `release: ExpansionReleaseEvidence` — the safe-release
 *             proof the hold was opened against. `subordinateAuthorityFenced` is `true` only
 *             when that evidence proves every subordinate authority terminal at an observed safe
 *             boundary under a daemon-verified truth class. Anything weaker leaves it `false`,
 *             and core answers `EXPANSION_PREPARATION_FENCE_UNPROVEN`. The field is deliberately
 *             not named `leaseFencedRef`: it is evidence a lease was REVOKED, never one granted.
 *
 *   lifecycle from the fact that `readCurrentActiveGraph` returned at all. That projection
 *             accepts a revision only when its replayed lifecycle is `ACTIVE`
 *             (`active-graph-projection.ts:172`), and `ACTIVE` is the only lifecycle
 *             `GRAPH_REVISION_TRANSITIONS["graph.supersede"]` admits, so the constant below is
 *             the projection's own guarantee restated, not an assumption about the world.
 *
 *   claim     from the LIVE admitted facts and the STORED preparation. Both operands are
 *             production results; neither is a caller value. Keeping them apart is the point —
 *             a claim rebuilt from the preparation alone could never disagree with it, and
 *             `matchClaim` would become a check that cannot fail.
 *
 * Pure: no store, no clock, no principal. It mints no authority.
 */

import type {
  ExpansionAdmittedFacts, ExpansionApprovalClaim, ExpansionFenceFacts, ExpansionFundingFacts,
  ExpansionPlanningHoldState, ExpansionPreparation,
} from "@moe/core";
import type { ExpansionBoundFacts } from "@moe/scheduler";

import type { ExpansionRequestAuthority } from "./expansion-request-current-authority.js";

/**
 * The one graph lifecycle a supersedable expansion can be prepared against. Restated from the
 * projection's guarantee rather than read from a caller: there is no field on
 * `ActiveGraphAccepted` to read it from, because the projection refuses every other value.
 */
export const EXPANSION_ADMISSION_GRAPH_LIFECYCLE = "ACTIVE" as const;

/** The predecessor binding a supersession input must name, read from durable authority alone. */
export interface ExpansionAdmissionPredecessor {
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly revisionId: string;
}

export function predecessorOf(
  authority: ExpansionRequestAuthority,
): ExpansionAdmissionPredecessor {
  return Object.freeze({
    graphContentHash: authority.graphContentHash,
    graphEpoch: authority.graphEpoch,
    revisionId: authority.parentRevisionRef,
  });
}

function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Whether the caller's supersession input names the DAEMON-CURRENT predecessor, member by
 * member. The supersession kernel proves the successor follows the predecessor it was given; it
 * has no way to know whether that predecessor is the one the daemon currently holds, so a
 * caller could otherwise supersede a revision the project moved past. Compared field by field
 * rather than by canonical bytes: the caller's value is arbitrary data, and a deeply nested one
 * would blow a serialiser's stack instead of refusing.
 */
export function namesCurrentPredecessor(
  supersession: unknown,
  predecessor: ExpansionAdmissionPredecessor,
): boolean {
  const expected = member(supersession, "expectedPredecessor");
  return member(expected, "revisionId") === predecessor.revisionId
    && member(expected, "graphContentHash") === predecessor.graphContentHash
    && member(expected, "graphEpoch") === predecessor.graphEpoch;
}

/**
 * Whether the durable hold was opened against the graph bytes the project currently holds. Two
 * independently durable aggregates: the hold froze the parent revision at creation, the active
 * graph projection reports it now. Disagreement means the graph moved under an open hold, and
 * the expansion must be re-requested rather than admitted against bytes that no longer exist.
 */
export function holdMatchesCurrentGraph(
  hold: ExpansionPlanningHoldState,
  authority: ExpansionRequestAuthority,
): boolean {
  return hold.proposalBaseHash === authority.graphContentHash
    && hold.parentRevisionRef === authority.parentRevisionRef
    && hold.graphEpoch === authority.graphEpoch;
}

/**
 * The funding facts the accepted admission earned, or `null` when the reservation's lines span
 * more than one meter and no single funding fact can describe them honestly.
 */
export function fundingFactsOf(bound: ExpansionBoundFacts): ExpansionFundingFacts | null {
  const reservation = bound.budgetReservation;
  const lines = reservation.lines;
  const first = lines[0];
  if (first === undefined) return null;
  if (lines.some((line) => line.meter !== first.meter)) return null;
  const quantity = lines.reduce((total, line) => total + line.quantity, 0);
  if (!Number.isSafeInteger(quantity) || quantity < 0) return null;
  return Object.freeze({
    fundingRef: `funding:${reservation.admissionRef}:${first.meter}`,
    meter: first.meter,
    quantity,
    reservationId: reservation.reservationId,
    state: "RESERVED" as const,
  });
}

const TERMINAL_RELEASE_STATES: readonly string[] = ["RELEASED", "REVOKED", "TERMINATED"];

/**
 * The fence facts the durable hold's release evidence proves. `subordinateAuthorityFenced` is
 * the CONJUNCTION of every leg — an observed safe boundary, terminal effects, terminal
 * resources, a terminal lease, a terminal provider slot, and a daemon-verified truth class.
 * Any weaker evidence yields `false`, which core refuses; nothing here upgrades a partial proof.
 */
export function fenceFactsOf(hold: ExpansionPlanningHoldState): ExpansionFenceFacts {
  const release = hold.release;
  const proven = release.safeBoundaryObserved
    && release.effectsTerminal
    && release.resourcesTerminal
    && TERMINAL_RELEASE_STATES.includes(release.leaseState)
    && TERMINAL_RELEASE_STATES.includes(release.providerSlotState)
    && release.truthClass === "DAEMON_VERIFIED";
  return Object.freeze({
    authorityFencedRef: `authority-fenced:${release.receiptRef}:${release.observationRef}`,
    fencedAtEpoch: hold.graphEpoch,
    // `true` is the type core demands; the boolean is what is actually carried, so an unproven
    // release reaches `stateCode` as `false` and is refused there rather than here.
    subordinateAuthorityFenced: proven as true,
  });
}

/**
 * The live facts no `ApprovalDecisionRecord` can carry, taken from the LIVE admitted facts and
 * the STORED preparation identity. A preparation that has moved since it was prepared makes the
 * two disagree and core refuses with the mismatch code naming which family moved.
 */
export function approvalClaimOf(
  admitted: ExpansionAdmittedFacts,
  preparation: ExpansionPreparation,
): ExpansionApprovalClaim {
  return Object.freeze({
    budgetReservationId: admitted.budgetReservation.reservationId,
    budgetReservationState: admitted.budgetReservation.state,
    preparationIdentity: preparation.identity,
    resourceEpoch: admitted.resourceReservation.epoch,
    resourceIds: Object.freeze([...admitted.resourceReservation.resourceIds]),
    resourceReservationState: admitted.resourceReservation.state,
    supersessionAuthorityHash: preparation.bound.supersessionAuthorityHash,
  });
}
