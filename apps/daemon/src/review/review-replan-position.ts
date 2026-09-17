import type { CommandDecisionRecord, EffectsCommittedDecision } from "@moe/store";
import type { ReviewLedger } from "./review-read-model.js";

/**
 * Whether the node's durable re-plan supersedes the round an acceptance attests. TRUE is the
 * closed answer, so a re-plan this cannot place never reads as one the node answered.
 *
 * `ledger.delta` is the LATEST re-plan's classification and the fold never clears it, so read as
 * a flag it says only "this node was re-planned once" — no evidence at all about the package a
 * later acceptance attests. Agents are told to re-plan a rejected review, so the ordinary path
 * leaves one behind for the rest of the node's life. What matters is POSITION.
 *
 * WHAT ANSWERS A RE-PLAN IS NEW REVIEWED WORK, not a later timestamp. A round committed after the
 * re-plan is the node's answer to it, and an acceptance over THAT round attests bytes no re-plan
 * ever invalidated. A re-plan committed after the round instead classified the very package being
 * closed on as INVALIDATED and named the successor plan that replaces it, so it supersedes — the
 * re-plan an acceptance is followed by most of all, since that one is later still.
 *
 * ONLY THOSE TWO POSITIONS ARE REACHABLE. A re-plan BETWEEN the attested round and its acceptance
 * is refused twice over by the version fences the receipt path already holds:
 * `recordVerifierReceipt` wants `ledger.version === sourceRound.aggregateVersion` and
 * `acceptOutput` wants the receipt's own decision at `ledger.version`, and a delta commit moves
 * that version (proven in `review-replan-position.test.ts`). The comparison below refuses it
 * anyway rather than admitting a state no command can build.
 */
export function replanSupersedesLatestRound(
  decisions: readonly CommandDecisionRecord[], projectId: string, nodeRef: string,
  ledger: ReviewLedger,
): boolean {
  if (ledger.delta === undefined) return false;
  const latest = ledger.rounds.at(-1);
  if (latest === undefined) return true;
  const rows = decisions.filter((row): row is EffectsCommittedDecision =>
    row.effectDisposition === "EFFECTS_COMMITTED" && row.key.projectId === projectId
    && row.targetAggregateId === nodeRef);
  // The ledger proves a re-plan exists; a filtered view that holds none cannot place it, and an
  // unplaceable re-plan is exactly what TRUE is for. Symmetric with the unplaceable round below.
  if (!rows.some((row) => row.commandKind === "qualification.replan")) return true;
  const index = rows.findIndex((row) => row.decisionId === latest.decisionId);
  const round = rows[index];
  if (round === undefined || round.commandKind !== "review.submit"
    || round.currentVersion !== latest.aggregateVersion
    || round.resultSha256 !== latest.resultSha256) return true;
  return rows.slice(index + 1).some((row) => row.commandKind === "qualification.replan");
}
