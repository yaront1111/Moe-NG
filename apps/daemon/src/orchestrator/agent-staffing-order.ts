import type { ChainStep } from "../http/affordance-contract.js";

/**
 * WHICH OFFERED STEP A FREE SEAT TAKES FIRST.
 *
 * Lifted out of the wrapper's staffing pass as an inline `sort` closure when the design step
 * joined the surface: the file stood six lines under its 400-line cap, and the ordering is a
 * POLICY rather than plumbing — it decides what a scarce `maxAgents` budget buys, so it earns
 * a name, a home and its own arms.
 *
 * THE ORDER, LOWEST FIRST, AND WHY EACH RANK IS WHERE IT IS:
 *
 * 0. `node.deliver` — already-planned work. Its seat is the reason the loop exists, and a node
 *    left unstaffed is a chain that has stopped moving. Nothing preempts it.
 * 1. `design.submit` — the rung between Gate 1 and the decomposition. A design GATES THE WHOLE
 *    DECOMPOSITION BEHIND IT: while it is unstaffed the goal offers no `planning.submit_
 *    decomposition` at all, so every node the goal will ever have is waiting on this one seat.
 *    That makes it the highest-leverage non-node item on the surface, and leaving it tied with
 *    generic work would let an incidental chore spend the last seat while a whole goal idles.
 * 2. Everything else.
 * 3. `goal.close` — last. It is in `HUMAN_ONLY_STEPS` and never actually staffed, so its rank
 *    is inherited belt-and-braces rather than load-bearing; it is kept only so the relative
 *    order of the kinds that WERE ranked before this change is preserved exactly.
 *
 * Ranks are compared, never stored, so the numbers may be renumbered freely; only their
 * ORDER is a fact, and `agent-wrapper.test.ts` pins it by work-item id.
 */
/**
 * The step kind the offer surface publishes for the design rung
 * (`http/affordance-planning-offers.ts:179`). Named ONCE, here, and consumed by both the rank
 * table below and the wrapper's mission dispatch: two sites minting this literal independently
 * is how an offer and a staffer come to disagree while each passes its own tests.
 */
export const DESIGN_STEP_KIND = "design.submit" as const;

const STAFFING_RANKS: Readonly<Record<string, number>> = Object.freeze({
  [DESIGN_STEP_KIND]: 1,
  "goal.close": 3,
  "node.deliver": 0,
});

/** The rank of one offered step; anything unranked is ordinary work. */
export function staffingRank(step: ChainStep): number {
  return STAFFING_RANKS[step.kind] ?? 2;
}

/** `Array.prototype.sort` comparator over the staffing order. Stable within a rank. */
export function byStaffingRank(a: ChainStep, b: ChainStep): number {
  return staffingRank(a) - staffingRank(b);
}
