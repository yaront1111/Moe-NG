import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { ReleaseOutcome } from "../../live/live-release.js";
import { evidenceSummary } from "../goals/goal-release.js";
import { MIDDOT } from "../glyphs.js";

/**
 * GATE 3 AS A QUEUE ITEM: the operator says whether the evidence is strong enough to expose
 * this work to users. This module decides WHETHER that decision exists for a goal and what it
 * is called; `goal-release.tsx` renders the evidence and `release-port.ts` spends the offer.
 * Nothing here fetches.
 *
 * WHY THE RECEIPT IS WHAT CLEARS THE ITEM, and not the offer. `affordance-planning-offers.ts`
 * withholds `release.decide` in exactly one case -- no landed commit, so there is no release
 * object to decide about -- and deliberately withholds NOTHING after that, because the
 * refusals ARE the answer to "why can't I release?". So the offer survives the release, and an
 * item derived from the offer alone would sit in the queue forever. The RELEASED receipt is
 * the daemon's own statement that the decision was taken, and it is what makes this item go
 * away. A REFUSED receipt does NOT clear it: a refused release is still waiting on a human.
 *
 * THE UNKNOWN COUNT TRAVELS WITH THE ITEM. The queue is the first place an operator reads this
 * summary, so it carries the same two numbers the card does, from the same derivation
 * (`evidenceSummary`) rather than a second count that could disagree with it.
 */

export interface ReleaseFacts {
  /** The daemon's `release.decide` offer, spent verbatim by release-port.ts. */
  readonly affordance: Readonly<Record<string, unknown>>;
  readonly covered: number;
  /** The published sha the evidence is measured at, or null when nothing is pushed yet. */
  readonly sha: string | null;
  readonly total: number;
  /** Criteria whose evidence could NOT be re-measured. Never folded into `covered`. */
  readonly unknown: number;
}

/** The words and the facts for one RELEASE item, or null when there is no decision to take. */
export interface ReleaseQueueOffer {
  readonly actionLabel: string;
  readonly detail: string;
  readonly facts: ReleaseFacts;
  readonly headline: string;
}

const RELEASE_COMMAND_KIND = "release.decide";

/** The aggregate the daemon names for a goal's release; mirrors `releaseDossierAggregateId`. */
export function releaseAggregateIdOf(goalId: string): string {
  return `release:${goalId}`;
}

function offerFor(
  surface: SurfaceFrame | null, goalId: string,
): Readonly<Record<string, unknown>> | null {
  if (surface === null || surface.outcome !== "SURFACE") return null;
  const target = releaseAggregateIdOf(goalId);
  return surface.offers.find((offer) =>
    offer["commandKind"] === RELEASE_COMMAND_KIND && offer["targetAggregateId"] === target) ?? null;
}

export function releaseOfferFor(
  goalId: string,
  release: ReleaseOutcome | undefined,
  surface: SurfaceFrame | null,
): ReleaseQueueOffer | null {
  if (release === undefined || release.status !== "PRESENT") return null;
  const { criteria, receipt, sha } = release.evidence;
  // The decision was taken and it succeeded: this goal is released and needs nobody.
  if (receipt?.outcome === "RELEASED") return null;
  const affordance = offerFor(surface, goalId);
  if (affordance === null) return null;
  const { covered, total, unknown } = evidenceSummary(criteria);
  const refused = receipt?.refusalCode ?? null;
  return Object.freeze({
    actionLabel: "Open the goal",
    detail: `Evidence covered ${String(covered)} of ${String(total)}`
      + (unknown === 0 ? "" : ` ${MIDDOT} UNKNOWN ${String(unknown)} could not be re-measured`)
      + (refused === null ? "" : ` ${MIDDOT} last attempt refused ${refused}`)
      + ". Read the receipts and the landings, then approve the release or fix what is missing.",
    facts: Object.freeze({ affordance, covered, sha, total, unknown }),
    headline: refused === null
      ? "Your work is ready to release and needs your verdict"
      : "A release was refused and needs you again",
  });
}
