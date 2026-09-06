import { boundGoalOf } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";

/**
 * WHICH PLANNING RUN IS CURRENT, after the operator has sent a plan back.
 *
 * THE PROBLEM THIS SOLVES. A goal's catalog entry carries the run it was compiled
 * into (`planningRunRef`), and that ref is IMMUTABLE - it still names the run the
 * operator rejected. Binding the plan gate to it after a reject would offer the
 * operator a control over a dead run: the daemon refuses that write
 * (`APPROVAL_RUN_NOT_REVIEWABLE @ APPROVAL_RUN_BINDING`), so the failure would reach
 * them as a daemon refusal rather than as the UI bug it is.
 *
 * THE AUTHORITY IS THE SURFACE'S OWN `planningGoalRefs`, read by INVERSION: the
 * daemon states runId -> goalId, and after a reject it binds ONLY the successor -
 * the rejected run is bound to nothing. So the run currently bound to this goal IS
 * the current run, stated by the daemon rather than inferred here. Nothing in this
 * module asks the catalog to change shape; its exact-key decoders are untouched.
 *
 * FAIL-OPEN, deliberately, and matching the daemon's own read path (which answers
 * `{hops: 0, unreadable: true}` rather than refusing): when the surface is unread,
 * disconnected or binds this goal to no run at all, the immutable `planningRunRef`
 * is returned. A read that cannot see the successor must not blank the screen; the
 * WRITE is still fenced by the daemon, which is the layer that may fail closed.
 *
 * AMBIGUITY IS NOT RESOLVED BY GUESSING. The daemon binds one run per goal; if a
 * frame ever states two, no run is "the" current one and the immutable ref is
 * returned rather than whichever key enumerated first.
 */

/** Every run the frame binds to this goal, in the order the daemon stated them. */
function runsBoundTo(frame: SurfaceFrame | null, goalId: string): readonly string[] {
  if (frame === null || frame.outcome !== "SURFACE" || goalId === "") return [];
  const refs = frame.planningGoalRefs;
  if (refs === undefined) return [];
  try {
    // Own enumerable string keys only, same discipline as `boundGoalOf`: a prototype
    // key is not a daemon statement.
    return Object.keys(refs).filter((runId) => boundGoalOf(refs, runId) === goalId);
  } catch {
    return [];
  }
}

/**
 * The run the plan gate must bind to right now: the successor after a reject, and
 * the goal's own compiled run at every other time.
 */
export function currentRunOf(
  frame: SurfaceFrame | null, goalId: string, planningRunRef: string,
): string {
  const bound = runsBoundTo(frame, goalId);
  return bound.length === 1 ? bound[0] ?? planningRunRef : planningRunRef;
}

/**
 * Has this goal's plan been sent back and not yet replanned?
 *
 * TRUE needs ALL THREE halves below. The first two say the daemon has moved the goal
 * onto a run other than the one this screen was opened against and is not offering
 * that run for approval yet. Once the compiler replans, the successor's
 * `approval.decide_intent` appears and this goes false on the same frame that
 * re-enables the controls.
 *
 * THE THIRD IS WHAT KEEPS IT HONEST AFTER THE APPROVAL, and it was missing: the two
 * negative halves are equally true of a goal whose successor the operator APPROVED,
 * because `planningGoalRefs` keeps binding the successor for the goal's whole life
 * (`affordance-planning-offers.ts` writes one ref per durable goal per read,
 * regardless of offers) while the approval offer is withdrawn at activation. Measured
 * live on UnAI 2026-09-06: an EXECUTION_ENABLED goal with four working nodes still
 * bound `run-364badebfb47fdf2e0631b57` and offered NOTHING, so the board header read
 * "Plan sent back / Waiting for a new plan" over agents that were already delivering,
 * and Needs you held a card for a decision nobody could make.
 *
 * So the wait is asserted POSITIVELY: the daemon is only re-planning while it offers
 * this goal a new decomposition. That offer is minted for exactly the state this
 * banner describes - a goal whose current run is not reviewable, on the compiler lane
 * with Gate 1 approved - and it survives a compiler seat holding the claim, because
 * offers are derived from the ledger and claims ride the STEPS beside them.
 */
const REPLAN_OFFER_KIND = "planning.submit_decomposition";

export function planSentBack(
  frame: SurfaceFrame | null, goalId: string, planningRunRef: string,
): boolean {
  if (frame === null || frame.outcome !== "SURFACE") return false;
  const current = currentRunOf(frame, goalId, planningRunRef);
  if (current === planningRunRef) return false;
  if (frame.offers.some((offer) =>
    offer["commandKind"] === "approval.decide_intent"
    && offer["targetAggregateId"] === current)) return false;
  return frame.offers.some((offer) =>
    offer["commandKind"] === REPLAN_OFFER_KIND && offer["targetAggregateId"] === goalId);
}
