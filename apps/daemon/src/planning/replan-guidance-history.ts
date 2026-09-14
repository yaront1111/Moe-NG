import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { decisionsOf } from "../decision-ledger-memo.js";
import { canonicalReviewArtifact } from "../review/review-submission-artifact.js";
import { implementationGuidanceResult, readReviewGuidanceSource, validImplementationGuidance }
  from "../review/review-implementation-guidance.js";
import type { ReviewLedger } from "../review/review-read-model.js";
import { storedVerifierFailureSourceMatches } from "../review/review-verifier-failure.js";

const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as JsonObject : null;
const invalid = (): never => { throw new Error("REPLAN_CONTEXT_UNAVAILABLE"); };

/** Follow only the host's exact diagnostic edge, never an arbitrary earlier approval. */
function consumedSubmission(store: SqliteEventStore, projectId: string, nodeRef: string, ledger: ReviewLedger) {
  const latest = ledger.rounds.at(-1);
  if (latest === undefined || latest.continuation !== undefined) return latest;
  const decision = decisionsOf(store, 200).find((row) => row.decisionId === latest.decisionId);
  if (decision === undefined || decision.key.projectId !== projectId || decision.targetAggregateId !== nodeRef
    || decision.commandKind !== "review.submit" || decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.currentVersion !== latest.aggregateVersion || decision.resultSha256 !== latest.resultSha256) return invalid();
  const decoded = decodeBoundedJsonBytes(decision.resultBytes);
  const result = decoded.ok ? object(decoded.value) : null;
  if (result === null) return invalid();
  if (!Object.hasOwn(result, "verifierFailureSource")) return latest;
  const prior = ledger.rounds.at(-2);
  if (prior === undefined || !storedVerifierFailureSourceMatches(result["verifierFailureSource"]!, prior)
    || latest.routing.route === "ACCEPT" || latest.round !== prior.round + 1
    || decision.previousVersion !== prior.aggregateVersion || latest.aggregateVersion !== prior.aggregateVersion + 1
    || readReviewGuidanceSource(store, projectId, nodeRef, prior) === null) return invalid();
  return prior;
}

/** Historical words only: this reader never returns or reinstates continuation authority. */
export function replanGuidanceHistory(store: SqliteEventStore, projectId: string, nodeRef: string,
  ledger: ReviewLedger): JsonObject | null {
  if (ledger.unreadable || !ledger.replanned || ledger.accepted !== undefined) return invalid();
  const submitted = consumedSubmission(store, projectId, nodeRef, ledger);
  const use = submitted?.continuation;
  if (use === undefined) return null;
  const approval = use.approval;
  if (ledger.unreadable || !ledger.replanned || use.projectId !== projectId || use.subjectRef !== nodeRef
    || use.round !== submitted?.round || approval.projectId !== projectId || approval.subjectRef !== nodeRef) return invalid();
  const decision = decisionsOf(store, 200).find((row) => row.decisionId === approval.decisionId);
  if (decision === undefined || decision.commandKind !== "escalation.decide"
    || decision.effectDisposition !== "EFFECTS_COMMITTED" || decision.key.projectId !== projectId
    || decision.targetAggregateId !== nodeRef || decision.currentVersion !== approval.decisionVersion
    || decision.resultSha256 !== approval.decisionResultSha256) return invalid();
  const decoded = decodeBoundedJsonBytes(decision.resultBytes);
  const result = decoded.ok ? object(decoded.value) : null;
  if (result === null || result["decision"] !== "ALLOW_MORE_ATTEMPTS") return invalid();
  if (!Object.hasOwn(result, "implementationGuidance")) return null;
  const guidance = object(result["implementationGuidance"]);
  const prior = ledger.rounds.find((round) => round.decisionId === approval.sourceDecisionId);
  if (guidance === null || !validImplementationGuidance(guidance["text"])
    || prior?.resultSha256 !== approval.sourceResultSha256) return invalid();
  const source = readReviewGuidanceSource(store, projectId, nodeRef, prior);
  if (source === null || canonicalReviewArtifact(guidance)
    !== canonicalReviewArtifact(implementationGuidanceResult(guidance["text"], source))) return invalid();
  return Object.freeze({ text: guidance["text"], decisionId: decision.decisionId,
    resultSha256: decision.resultSha256, consumedByReviewDecisionId: submitted.decisionId,
    status: "HISTORICAL_CONTEXT_ONLY" });
}
