import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { CommandDecisionRecord, EffectsCommittedDecision } from "@moe/store";
import { isPlainJsonObject } from "./review-contracts.js";
import type { ReviewLedger } from "./review-read-model.js";

export interface TerminalReplan {
  /** The human's REPLAN: the node's last committed decision. */
  readonly replan: EffectsCommittedDecision;
  /** The committed `review.submit` of the latest round, which that REPLAN answers. */
  readonly answered: EffectsCommittedDecision;
}

const REPLAN_RESULT_KEYS = "decision,escalationRef,unsuccessfulRounds";
const UNDECODABLE = Symbol("undecodable");

function resultOf(row: EffectsCommittedDecision) {
  const decoded = decodeBoundedJsonBytes(row.resultBytes);
  return decoded.ok && isPlainJsonObject(decoded.value) ? decoded.value : UNDECODABLE;
}
const decisionOf = (row: EffectsCommittedDecision): unknown => {
  const result = resultOf(row);
  return result === UNDECODABLE ? UNDECODABLE : result["decision"];
};

/**
 * The one proof a human REPLAN retired this node and nothing has happened to it since: both the
 * successor handoff (planning/replan-context.ts) and RELEASE_REPLANNED read it, each adding its
 * own checks. Null is refusal.
 *
 * The REPLAN must be the node's last committed decision and answer the latest round, with only an
 * agent's `qualification.replan` or a human's `escalation.decide` ALLOW_MORE_ATTEMPTS between the
 * two, in an unbroken version chain. That allow-list is closed on purpose: of `REVIEW_HANDLERS`
 * and the verifier receipt, these are the only commits that can reach a node after a failed latest
 * round (the receipt and `integration.accept_output` need a clean one, and another round would be
 * the latest). A re-plan grants nothing (every node INVALIDATED), writes no Git effect and leaves
 * the round untouched, and the human decided at a version that already includes it, so it is no
 * evidence against the REPLAN. An ALLOW there is unspent, since no round follows it. A new kind
 * that writes to a node after a failed round is refused here until it is weighed and listed.
 */
export function readTerminalReplan(decisions: readonly CommandDecisionRecord[], projectId: string, nodeRef: string,
  ledger: ReviewLedger): TerminalReplan | null {
  const latest = ledger.rounds.at(-1);
  if (ledger.unreadable || !ledger.replanned || ledger.accepted !== undefined || ledger.continuation !== undefined
    || latest === undefined || latest.routing.route === "ACCEPT") return null;
  const rows = decisions.filter((row): row is EffectsCommittedDecision => row.effectDisposition === "EFFECTS_COMMITTED"
    && row.key.projectId === projectId && row.targetAggregateId === nodeRef);
  const decided = rows.filter((row) => row.commandKind === "escalation.decide").map(decisionOf);
  if (decided.includes(UNDECODABLE) || decided.filter((decision) => decision === "REPLAN").length !== 1) return null;
  const replan = rows.at(-1);
  if (replan === undefined || replan.commandKind !== "escalation.decide" || replan.currentVersion !== ledger.version) return null;
  const result = resultOf(replan);
  if (result === UNDECODABLE || result["decision"] !== "REPLAN" || Object.keys(result).sort().join(",") !== REPLAN_RESULT_KEYS
    || typeof result["escalationRef"] !== "string" || result["escalationRef"].trim() === ""
    || result["unsuccessfulRounds"] !== ledger.lineage.unsuccessfulRounds) return null;
  const index = rows.findIndex((row) => row.decisionId === latest.decisionId);
  const answered = rows[index];
  if (answered === undefined || index >= rows.length - 1 || answered.commandKind !== "review.submit"
    || answered.currentVersion !== latest.aggregateVersion || answered.resultSha256 !== latest.resultSha256) return null;
  let version = answered.currentVersion;
  for (const row of rows.slice(index + 1)) {
    if (row !== replan && row.commandKind !== "qualification.replan"
      && (row.commandKind !== "escalation.decide" || decisionOf(row) !== "ALLOW_MORE_ATTEMPTS")) return null;
    if (row.previousVersion !== version) return null;
    version = row.currentVersion;
  }
  return Object.freeze({ replan, answered });
}
