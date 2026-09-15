import { REVIEW_ESCALATION_ROUND_LIMIT } from "@moe/review";

import type { ReviewLedger, ReviewRoundRecord } from "./review-read-model.js";

/**
 * A STALLED review (addendum 2026-09-15): the latest round repeated exactly the previous round's
 * own findings against a byte-identical review input - the same captured workspace, criteria,
 * graph and plan. Nothing a coding seat could observe changed, so another automatic round can
 * only repeat it. Measured on UnAI: rounds 1-3 and 5-7-9-11 of one node were each a seat run that
 * re-verified an unchanged tree and filed the same finding.
 *
 * Design 15.2 already routes a repeated finding to re-plan (`REJECT_PLAN`); a stall is the
 * repeat nothing can resolve without a human, so it requires the escalation decision at once
 * instead of spending the rest of the round budget. A repeat after real changes keeps its
 * automatic retries. Findings attributed to other nodes never make or break a stall.
 */
function ownFingerprints(round: ReviewRoundRecord): ReadonlySet<string> {
  // Injected read-model slices may carry no lineage; they have no own findings to repeat.
  return new Set((round.lineage?.records ?? [])
    .filter((record) => record.round === round.round && record.finding.attributedTo === undefined)
    .map((record) => record.fingerprint));
}

export function roundStalled(previous: ReviewRoundRecord | undefined, latest: ReviewRoundRecord | undefined): boolean {
  if (previous === undefined || latest === undefined) return false;
  if (previous.routing.route === "ACCEPT" || latest.routing.route === "ACCEPT") return false;
  if (latest.reviewInputDigest !== previous.reviewInputDigest) return false;
  const before = ownFingerprints(previous);
  const after = ownFingerprints(latest);
  return after.size > 0 && after.size === before.size && [...after].every((fingerprint) => before.has(fingerprint));
}

/** The consecutive stalled rounds ending at the latest, oldest first (e.g. [5, 7, 9]); empty when not stalled. */
export function reviewStall(rounds: readonly ReviewRoundRecord[]): readonly number[] {
  const stalled: number[] = [];
  for (let index = rounds.length - 1; index > 0 && roundStalled(rounds[index - 1], rounds[index]); index -= 1) {
    if (stalled.length === 0) stalled.push(rounds[index]!.round);
    stalled.unshift(rounds[index - 1]!.round);
  }
  return Object.freeze(stalled);
}

/** A human decision is due: three unsuccessful rounds (design 15.2), or a stall. */
export function reviewDecisionRequired(ledger: Pick<ReviewLedger, "lineage" | "rounds">): boolean {
  return ledger.lineage.unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT || reviewStall(ledger.rounds).length > 0;
}
